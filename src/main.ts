// Composition root: wires adapters -> domain.
// `scraper start` launches daemon, all other commands are CLI client.

import { type CliDeps, type PidFile, runCli, type StartOptions } from "./cli/mod.ts";
import { createCdpConnection, killChrome, launchChrome } from "./cdp/mod.ts";
import { createSnapshotService } from "./aria/mod.ts";
import { createServer } from "./http/mod.ts";
import { createJsonFileStore } from "./fs/mod.ts";

const HOME = Deno.env.get("HOME");
if (!HOME) throw new Error("HOME environment variable is not set");
const PID_PATH = `${HOME}/.scraper/daemon.json`;

const pidStore = createJsonFileStore<PidFile>(PID_PATH);

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

// Track active daemon state so killProcess can trigger graceful shutdown
// instead of SIGTERM when rolling back our own daemon, and so Deno.exit
// can await cleanup before terminating.
let activeServer: Deno.HttpServer | undefined;
let pendingCleanup: Promise<void> | undefined;

function killProcess(pid: number): void {
  if (pid === Deno.pid && activeServer) {
    activeServer.shutdown();
    return;
  }
  Deno.kill(pid, "SIGTERM");
}

const DEFAULT_EVAL_TIMEOUT = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let id: number;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      id = setTimeout(() => reject(new Error("evaluation timed out")), ms);
    }),
  ]).finally(() => clearTimeout(id));
}

async function spawnDaemon(opts: StartOptions): Promise<PidFile> {
  const chrome = await launchChrome({
    chromePath: opts.chromePath,
    headless: true,
  });

  let browser;
  try {
    browser = await createCdpConnection(chrome.port);
  } catch (err) {
    await killChrome(chrome);
    throw err;
  }

  const evalTimeout = opts.evalTimeout ?? DEFAULT_EVAL_TIMEOUT;
  const snapshotSvc = createSnapshotService();

  const server = createServer({
    navigate: (req) => browser.navigate(req),
    evaluate: (req) => withTimeout(browser.evaluate(req), evalTimeout),
    screenshot: (name, fullPage) => browser.screenshot(name, fullPage),
    listPages: () => browser.listPages(),
    closePage: (name) => browser.closePage(name),
    snapshot: (options) => {
      const name = options.name ?? "default";
      const evaluateInPage = (expression: string) =>
        browser.evaluate({ name, expression }).then((r) => r.result as unknown);
      return snapshotSvc.snapshot(options, evaluateInPage);
    },
  });

  let httpServer: Deno.HttpServer;
  try {
    httpServer = server.serve({ port: opts.port });
  } catch (err) {
    browser.close();
    await killChrome(chrome);
    throw err;
  }
  activeServer = httpServer;

  // Clean up Chrome and CDP when HTTP server shuts down.
  // Stored in pendingCleanup so Deno.exit can await it.
  pendingCleanup = httpServer.finished.then(async () => {
    activeServer = undefined;
    try {
      browser.close();
      await killChrome(chrome);
    } catch {
      // Best-effort cleanup
    }
    await pidStore.remove();
  });

  return { pid: Deno.pid, port: opts.port, cdpPort: chrome.port };
}

const deps: CliDeps = {
  fetch: globalThis.fetch,
  readPidFile: () => pidStore.read(),
  writePidFile: (pf: PidFile) => pidStore.write(pf),
  removePidFile: () => pidStore.remove(),
  isProcessAlive,
  killProcess,
  spawnDaemon,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  stdout: (s) => Deno.stdout.writeSync(encoder.encode(s)),
  stderr: (s) => Deno.stderr.writeSync(encoder.encode(s)),
};

const code = await runCli(Deno.args, deps);

// Exit immediately for client commands (non-zero or no daemon running).
// When daemon is active, the HTTP server keeps the event loop alive.
if (code !== 0) {
  if (pendingCleanup) await pendingCleanup;
  Deno.exit(code);
}
