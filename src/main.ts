// Composition root: wires adapters -> domain.
// `scraper start` launches daemon, all other commands are CLI client.

import { type CliDeps, type PidFile, runCli, type StartOptions } from "./cli/mod.ts";
import { createCdpConnection, killChrome, launchChrome } from "./cdp/mod.ts";
import { createSnapshotService } from "./aria/mod.ts";
import { createServer } from "./http/mod.ts";

const HOME = Deno.env.get("HOME");
if (!HOME) throw new Error("HOME environment variable is not set");
const PID_DIR = `${HOME}/.scraper`;
const PID_PATH = `${PID_DIR}/daemon.json`;

const encoder = new TextEncoder();

async function readPidFile(): Promise<PidFile | null> {
  try {
    const text = await Deno.readTextFile(PID_PATH);
    return JSON.parse(text) as PidFile;
  } catch {
    return null;
  }
}

async function writePidFile(pf: PidFile): Promise<void> {
  await Deno.mkdir(PID_DIR, { recursive: true });
  await Deno.writeTextFile(PID_PATH, JSON.stringify(pf));
}

async function removePidFile(): Promise<void> {
  try {
    await Deno.remove(PID_PATH);
  } catch {
    // Already gone
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    const cmd = new Deno.Command("kill", { args: ["-0", String(pid)] });
    const result = cmd.outputSync();
    return result.code === 0;
  } catch {
    return false;
  }
}

function killProcess(pid: number): void {
  Deno.kill(pid, "SIGTERM");
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
  const snapshotSvc = createSnapshotService();

  const server = createServer({
    navigate: (req) => browser.navigate(req),
    evaluate: (req) => browser.evaluate(req),
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

  const httpServer = server.serve({ port: opts.port });

  // Clean up Chrome and CDP when HTTP server shuts down.
  httpServer.finished.then(async () => {
    try {
      browser.close();
      await killChrome(chrome);
    } catch {
      // Best-effort cleanup
    }
    await removePidFile();
  });

  return { pid: Deno.pid, port: opts.port, cdpPort: chrome.port };
}

const deps: CliDeps = {
  fetch: globalThis.fetch,
  readPidFile,
  writePidFile,
  removePidFile,
  isProcessAlive,
  killProcess,
  spawnDaemon,
  stdout: (s) => Deno.stdout.writeSync(encoder.encode(s)),
  stderr: (s) => Deno.stderr.writeSync(encoder.encode(s)),
};

const code = await runCli(Deno.args, deps);

// Exit immediately for client commands (non-zero or no daemon running).
// When daemon is active, the HTTP server keeps the event loop alive.
if (code !== 0) Deno.exit(code);
