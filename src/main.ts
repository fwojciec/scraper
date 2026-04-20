// Composition root: wires adapters -> app -> cli.

import { dirname } from "@std/path";
import { type CliDeps, runCli } from "./cli/mod.ts";
import {
  buildBrowserWsUrl,
  createBrowserConnection,
  createPageConnection,
  defaultUserDataDir,
  readDevToolsActivePort,
  resolveTarget,
} from "./cdp/mod.ts";
import { createSnapshotService } from "./aria/mod.ts";
import { createScraperApp, type RefsStore, type TargetStore } from "./app/mod.ts";
import type { RefMap } from "./domain/mod.ts";

const HOME = Deno.env.get("HOME");
if (!HOME) throw new Error("HOME environment variable is not set");
const STATE_DIR = `${HOME}/.scraper`;
const TARGET_PATH = `${STATE_DIR}/target`;
const REFS_PATH = `${STATE_DIR}/refs.json`;

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

const targetStore: TargetStore = {
  async read() {
    try {
      return (await Deno.readTextFile(TARGET_PATH)).trim() || null;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  },
  write: (targetId) => writeFileAtomic(TARGET_PATH, targetId),
  remove: () => removeIfExists(TARGET_PATH),
};

const refsStore: RefsStore = {
  async read() {
    try {
      return JSON.parse(await Deno.readTextFile(REFS_PATH)) as RefMap;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound || e instanceof SyntaxError) return null;
      throw e;
    }
  },
  write: (refs) => writeFileAtomic(REFS_PATH, JSON.stringify(refs)),
  remove: () => removeIfExists(REFS_PATH),
};

const channel = Deno.env.get("SCRAPER_CHROME_CHANNEL") || undefined;
const userDataDir = Deno.env.get("SCRAPER_USER_DATA_DIR") || defaultUserDataDir(channel);

const app = createScraperApp({
  userDataDir,
  readDevToolsActivePort,
  buildBrowserWsUrl,
  createBrowserConnection,
  createPageConnection,
  resolveTarget,
  createSnapshotService,
  targetStore,
  refsStore,
  warn: (s) => Deno.stderr.writeSync(encoder.encode(s)),
});

const deps: CliDeps = {
  app,
  stdout: (s) => Deno.stdout.writeSync(encoder.encode(s)),
  stderr: (s) => Deno.stderr.writeSync(encoder.encode(s)),
};

const code = await runCli(Deno.args, deps);
Deno.exit(code);
