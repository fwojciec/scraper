// Composition root: wires adapters -> app -> cli.

import { dirname } from "@std/path";
import { type CliDeps, runCli, type TabInfo } from "./cli/mod.ts";
import {
  buildBrowserWsUrl,
  canonicalizeTargetId,
  createBrowserConnection,
  createPageConnection,
  defaultUserDataDir,
  listHttpTabs,
  matchTabByPrefix,
  readDevToolsActivePort,
  resolveTarget,
} from "./cdp/mod.ts";
import { createSnapshotService } from "./aria/mod.ts";
import {
  type ArtifactStore,
  type CounterStore,
  createScraperApp,
  type RefsStore,
} from "./app/mod.ts";
import type { RefMap } from "./domain/mod.ts";
import { isArtifactFile, selectDeletions } from "./domain/retention.ts";

const HOME = Deno.env.get("HOME");
if (!HOME) throw new Error("HOME environment variable is not set");
const STATE_DIR = `${HOME}/.scraper`;
const REF_COUNTER_PATH = `${STATE_DIR}/counter-refs`;
const ARTIFACT_COUNTER_PATH = `${STATE_DIR}/counter`;
const STATE_LOCK_PATH = `${STATE_DIR}/state.lock`;
const refsPathFor = (targetId: string) => `${STATE_DIR}/refs.${targetId}.json`;
const snapshotPathFor = (snapshotId: string) => `${STATE_DIR}/${snapshotId}.yaml`;
const screenshotPathFor = (screenshotId: string) => `${STATE_DIR}/${screenshotId}.png`;

const encoder = new TextEncoder();

async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = await Deno.makeTempFile({ dir });
  if (typeof data === "string") {
    await Deno.writeTextFile(tmp, data);
  } else {
    await Deno.writeFile(tmp, data);
  }
  await Deno.rename(tmp, path);
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

const refsStore: RefsStore = {
  async read(targetId) {
    try {
      const parsed = JSON.parse(await Deno.readTextFile(refsPathFor(targetId))) as unknown;
      if (!parsed || typeof parsed !== "object") return null;
      // Current shape is `{snapshotId, refs}`; legacy files written before the
      // wrapper existed are bare RefMaps — fall back so upgrades don't require
      // a manual re-snapshot of every tab.
      const wrapper = parsed as { refs?: unknown };
      if (wrapper.refs && typeof wrapper.refs === "object") {
        return wrapper.refs as RefMap;
      }
      return parsed as RefMap;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound || e instanceof SyntaxError) return null;
      throw e;
    }
  },
  write: (targetId, refs, snapshotId) =>
    writeFileAtomic(refsPathFor(targetId), JSON.stringify({ snapshotId, refs })),
  remove: (targetId) => removeIfExists(refsPathFor(targetId)),
};

function createCounterStore(path: string): CounterStore {
  return {
    async read() {
      try {
        const raw = (await Deno.readTextFile(path)).trim();
        if (!raw) return 0;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return 0;
        return n;
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) return 0;
        throw e;
      }
    },
    write: (value) => writeFileAtomic(path, String(value)),
  };
}

const refCounterStore = createCounterStore(REF_COUNTER_PATH);
const artifactCounterStore = createCounterStore(ARTIFACT_COUNTER_PATH);

/**
 * Exclusive advisory lock on `~/.scraper/state.lock` — serializes
 * counter-allocating regions (`snapshot`, `screenshot`) across concurrent CLI
 * invocations so they cannot interleave their read-modify-write on
 * `counter` / `counter-refs` and mint colliding `sN` artifacts or overlapping
 * ref ranges. Uses `Deno.FsFile.lock()` (stable in Deno 2+).
 */
async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  await Deno.mkdir(STATE_DIR, { recursive: true });
  const file = await Deno.open(STATE_LOCK_PATH, { read: true, write: true, create: true });
  try {
    await file.lock(true);
    try {
      return await fn();
    } finally {
      await file.unlock();
    }
  } finally {
    file.close();
  }
}

/**
 * Retention policy for `~/.scraper/` — Tier B design §Cleanup:
 * keep the newest 20 artifacts, delete anything older than 24 hours.
 * Scope is `s{N}.yaml` and `shot{N}.png` only; ref files and counters are
 * handled by their own lifecycle (dead-refs cleanup / monotonic writes).
 */
const RETENTION_MAX_COUNT = 20;
const RETENTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Opportunistic GC of snapshot/screenshot artifacts, called after every
 * successful artifact write. Best-effort: any IO error during scan or delete
 * is swallowed after a warning — an eviction failure must not turn a
 * successful `snapshot` / `screenshot` command into an error.
 */
async function pruneArtifacts(): Promise<void> {
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(STATE_DIR);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return;
    Deno.stderr.writeSync(
      encoder.encode(`warning: artifact retention scan failed: ${errorMessage(e)}\n`),
    );
    return;
  }

  const candidates: { name: string; mtimeMs: number }[] = [];
  try {
    for await (const entry of entries) {
      if (!entry.isFile) continue;
      if (!isArtifactFile(entry.name)) continue;
      const path = `${STATE_DIR}/${entry.name}`;
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(path);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) continue;
        throw e;
      }
      const mtimeMs = stat.mtime?.getTime() ?? 0;
      candidates.push({ name: entry.name, mtimeMs });
    }
  } catch (e) {
    Deno.stderr.writeSync(
      encoder.encode(`warning: artifact retention scan failed: ${errorMessage(e)}\n`),
    );
    return;
  }

  const toDelete = selectDeletions(candidates, {
    maxCount: RETENTION_MAX_COUNT,
    maxAgeMs: RETENTION_MAX_AGE_MS,
    nowMs: Date.now(),
  });
  for (const name of toDelete) {
    try {
      await Deno.remove(`${STATE_DIR}/${name}`);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue;
      Deno.stderr.writeSync(
        encoder.encode(`warning: failed to prune ${name}: ${errorMessage(e)}\n`),
      );
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const artifactStore: ArtifactStore = {
  async writeSnapshot(snapshotId, yaml) {
    const path = snapshotPathFor(snapshotId);
    await writeFileAtomic(path, yaml);
    await pruneArtifacts();
    return path;
  },
  async writeScreenshot(screenshotId, png) {
    const path = screenshotPathFor(screenshotId);
    await writeFileAtomic(path, png);
    await pruneArtifacts();
    return path;
  },
};

const channel = Deno.env.get("SCRAPER_CHROME_CHANNEL") || undefined;
const userDataDir = Deno.env.get("SCRAPER_USER_DATA_DIR") || defaultUserDataDir(channel);

const app = createScraperApp({
  userDataDir,
  readDevToolsActivePort,
  buildBrowserWsUrl,
  createPageConnection,
  createBrowserConnection,
  resolveTarget,
  createSnapshotService,
  refsStore,
  refCounterStore,
  artifactCounterStore,
  artifactStore,
  withStateLock,
  warn: (s) => Deno.stderr.writeSync(encoder.encode(s)),
});

async function canonicalizeTab(input: string): Promise<string> {
  // Missing-flag check short-circuits before any Chrome I/O so
  // `scraper snapshot` (etc.) without `--tab` reports the documented error
  // even when Chrome isn't running.
  if (!input) return matchTabByPrefix(input, []);
  const { port } = await readDevToolsActivePort(userDataDir);
  return await canonicalizeTargetId(input, port);
}

async function listTabs(): Promise<TabInfo[]> {
  const { port } = await readDevToolsActivePort(userDataDir);
  const tabs = await listHttpTabs(port);
  return tabs
    .filter((t) => t.type === "page")
    .map(({ id, url, title }) => ({ id, url, title }));
}

// Matches `refs.<targetId>.json` — capture group is the targetId.
// Deliberately permissive on the id so we can clean up any prior writer's
// format (uppercase hex is what Chrome currently emits).
const REFS_FILE_RE = /^refs\.([^.]+)\.json$/;

async function cleanupDeadRefs(liveIds: readonly string[]): Promise<void> {
  const live = new Set(liveIds);
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(STATE_DIR);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return;
    throw e;
  }
  for await (const entry of entries) {
    if (!entry.isFile) continue;
    const m = entry.name.match(REFS_FILE_RE);
    if (!m) continue;
    if (live.has(m[1])) continue;
    await removeIfExists(`${STATE_DIR}/${entry.name}`);
  }
}

const deps: CliDeps = {
  app,
  canonicalizeTab,
  listTabs,
  cleanupDeadRefs,
  stdout: (s) => Deno.stdout.writeSync(encoder.encode(s)),
  stderr: (s) => Deno.stderr.writeSync(encoder.encode(s)),
};

const code = await runCli(Deno.args, deps);
Deno.exit(code);
