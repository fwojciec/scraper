// Composition root: wires adapters -> app -> cli.

import { type CliDeps, runCli } from "./cli/mod.ts";
import {
  buildBrowserWsUrl,
  createBrowserConnection,
  createPageConnection,
  defaultUserDataDir,
  discoverWsUrl,
  launchChrome,
  readDevToolsActivePort,
  resolveTarget,
} from "./cdp/mod.ts";
import { createSnapshotService } from "./aria/mod.ts";
import { createJsonFileStore } from "./fs/mod.ts";
import { type ChromeState, createScraperApp } from "./app/mod.ts";
import type { RefMap } from "./domain/mod.ts";

const HOME = Deno.env.get("HOME");
if (!HOME) throw new Error("HOME environment variable is not set");
const STATE_PATH = `${HOME}/.scraper/chrome.json`;
const REFS_PATH = `${HOME}/.scraper/refs.json`;

const encoder = new TextEncoder();

function isProcessAlive(pid: number): boolean {
  try {
    const cmd = new Deno.Command("kill", { args: ["-0", String(pid)] });
    const result = cmd.outputSync();
    return result.code === 0;
  } catch {
    return false;
  }
}

function isOurChromeProcess(pid: number, userDataDir: string): boolean {
  try {
    const cmd = new Deno.Command("ps", {
      args: ["-p", String(pid), "-o", "args="],
      stdout: "piped",
      stderr: "null",
    });
    const result = cmd.outputSync();
    if (result.code !== 0) return false;
    const args = new TextDecoder().decode(result.stdout);
    return args.includes(`--user-data-dir=${userDataDir}`);
  } catch {
    return false;
  }
}

const app = createScraperApp({
  launchChrome,
  defaultUserDataDir,
  readDevToolsActivePort,
  buildBrowserWsUrl,
  discoverWsUrl,
  createBrowserConnection,
  createPageConnection,
  resolveTarget,
  createSnapshotService,
  stateStore: createJsonFileStore<ChromeState>(STATE_PATH),
  refsStore: createJsonFileStore<RefMap>(REFS_PATH),
  isProcessAlive,
  isOurChromeProcess,
  killProcess: (pid) => Deno.kill(pid, "SIGTERM"),
  removeDir: (path) => Deno.remove(path, { recursive: true }),
  fetch: (url) => fetch(url),
  warn: (s) => Deno.stderr.writeSync(encoder.encode(s)),
});

const deps: CliDeps = {
  app,
  stdout: (s) => Deno.stdout.writeSync(encoder.encode(s)),
  stderr: (s) => Deno.stderr.writeSync(encoder.encode(s)),
};

const code = await runCli(Deno.args, deps);
Deno.exit(code);
