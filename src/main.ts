// Composition root: wires adapters -> app -> cli.

import { dirname } from "@std/path";
import { type CliDeps, runCli, type TabInfo } from "./cli/mod.ts";
import {
  buildBrowserWsUrl,
  canonicalizeTargetId,
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

const HOME = Deno.env.get("HOME");
if (!HOME) throw new Error("HOME environment variable is not set");
const STATE_DIR = `${HOME}/.scraper`;
const REF_COUNTER_PATH = `${STATE_DIR}/counter-refs`;
const ARTIFACT_COUNTER_PATH = `${STATE_DIR}/counter`;
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

const artifactStore: ArtifactStore = {
  async writeSnapshot(snapshotId, yaml) {
    const path = snapshotPathFor(snapshotId);
    await writeFileAtomic(path, yaml);
    return path;
  },
  async writeScreenshot(screenshotId, png) {
    const path = screenshotPathFor(screenshotId);
    await writeFileAtomic(path, png);
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
  resolveTarget,
  createSnapshotService,
  refsStore,
  refCounterStore,
  artifactCounterStore,
  artifactStore,
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
