// Composition root: wires adapters -> app -> cli.

import { dirname } from "@std/path";
import { type CliDeps, runCli } from "./cli/mod.ts";
import {
  buildBrowserWsUrl,
  canonicalizeTargetId,
  createPageConnection,
  defaultUserDataDir,
  matchTabByPrefix,
  readDevToolsActivePort,
  resolveTarget,
} from "./cdp/mod.ts";
import { createSnapshotService } from "./aria/mod.ts";
import { type CounterStore, createScraperApp, type RefsStore } from "./app/mod.ts";
import type { RefMap } from "./domain/mod.ts";

const HOME = Deno.env.get("HOME");
if (!HOME) throw new Error("HOME environment variable is not set");
const STATE_DIR = `${HOME}/.scraper`;
const REF_COUNTER_PATH = `${STATE_DIR}/counter-refs`;
const refsPathFor = (targetId: string) => `${STATE_DIR}/refs.${targetId}.json`;

const encoder = new TextEncoder();

async function writeFileAtomic(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = await Deno.makeTempFile({ dir });
  await Deno.writeTextFile(tmp, data);
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
      return JSON.parse(await Deno.readTextFile(refsPathFor(targetId))) as RefMap;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound || e instanceof SyntaxError) return null;
      throw e;
    }
  },
  write: (targetId, refs) => writeFileAtomic(refsPathFor(targetId), JSON.stringify(refs)),
  remove: (targetId) => removeIfExists(refsPathFor(targetId)),
};

const refCounterStore: CounterStore = {
  async read() {
    try {
      const raw = (await Deno.readTextFile(REF_COUNTER_PATH)).trim();
      if (!raw) return 0;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return 0;
      return n;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return 0;
      throw e;
    }
  },
  write: (value) => writeFileAtomic(REF_COUNTER_PATH, String(value)),
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

const deps: CliDeps = {
  app,
  canonicalizeTab,
  stdout: (s) => Deno.stdout.writeSync(encoder.encode(s)),
  stderr: (s) => Deno.stderr.writeSync(encoder.encode(s)),
};

const code = await runCli(Deno.args, deps);
Deno.exit(code);
