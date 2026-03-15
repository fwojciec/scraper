// Composition root: wires adapters -> domain.
// `scraper start` launches Chrome and exits. All other commands connect to CDP directly.

import { type CliDeps, runCli, type StartOptions, type StartResult } from "./cli/mod.ts";
import { type CdpBrowserService, createCdpConnection, launchChrome } from "./cdp/mod.ts";
import { type AXNode, createSnapshotService } from "./aria/mod.ts";
import { createJsonFileStore } from "./fs/mod.ts";
import type { RefMap } from "./domain/mod.ts";

const HOME = Deno.env.get("HOME");
if (!HOME) throw new Error("HOME environment variable is not set");
const STATE_PATH = `${HOME}/.scraper/chrome.json`;

interface ChromeState {
  chromePid: number;
  cdpPort: number;
  userDataDir: string;
  targetId: string;
}

const stateStore = createJsonFileStore<ChromeState>(STATE_PATH);
const REFS_PATH = `${HOME}/.scraper/refs.json`;
const refsStore = createJsonFileStore<RefMap>(REFS_PATH);

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

/**
 * Check if the process at `pid` was launched with `--user-data-dir=<path>`.
 * This is a definitive ownership check: Chrome is spawned with this flag,
 * and the path is a unique temp directory we created.
 */
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

/**
 * Classify recorded state into one of three ownership states:
 * - "dead": PID is not alive. Safe to clean up everything.
 * - "ours": PID alive AND its command line contains our --user-data-dir.
 * - "foreign": PID alive but it's not our Chrome (recycled PID).
 */
function classifyState(state: ChromeState): "dead" | "ours" | "foreign" {
  if (!isProcessAlive(state.chromePid)) return "dead";
  return isOurChromeProcess(state.chromePid, state.userDataDir) ? "ours" : "foreign";
}

/** Probe Chrome's CDP endpoint. */
async function isCdpResponding(state: ChromeState): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${state.cdpPort}/json/version`);
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Clean up after a confirmed-dead Chrome process.
 * Only safe to call when isProcessAlive(state.chromePid) is false.
 */
async function cleanupDeadChrome(state: ChromeState): Promise<void> {
  try {
    await Deno.remove(state.userDataDir, { recursive: true });
  } catch { /* best effort */ }
  await stateStore.remove();
  await refsStore.remove();
}

/**
 * Discover the initial page target from Chrome's /json/list, with retries.
 * Retries both transport failures and missing-target conditions.
 */
async function discoverPageTarget(port: number): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!res.ok) {
        await res.body?.cancel();
        if (attempt < 4) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        throw new Error(`Chrome /json/list returned ${res.status}`);
      }
      const targets = await res.json();
      // deno-lint-ignore no-explicit-any
      const pageTarget = targets.find((t: any) => t.type === "page");
      if (pageTarget) return pageTarget.id;
    } catch (err) {
      if (attempt >= 4) throw err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("no page target found in Chrome");
}

const STOP_POLL_INTERVAL_MS = 100;
const STOP_TIMEOUT_MS = 5000;

async function startChrome(opts: StartOptions): Promise<StartResult> {
  const existing = await stateStore.read();

  if (existing) {
    const ownership = classifyState(existing);

    if (ownership === "ours") {
      // Our Chrome is alive. Use CDP probe to check if it's healthy.
      if (await isCdpResponding(existing)) {
        return {
          status: "already_running",
          chromePid: existing.chromePid,
          cdpPort: existing.cdpPort,
        };
      }
      // Our Chrome is alive but CDP is not responding. Don't launch a second
      // instance — that would orphan this one.
      throw new Error(
        `chrome appears to be running (pid ${existing.chromePid}) but is not responding` +
          ` — run 'scraper stop' first`,
      );
    }

    if (ownership === "dead") {
      await cleanupDeadChrome(existing);
    } else {
      // "foreign" — PID recycled. Remove state file only.
      await stateStore.remove();
    }
  }

  // New session = old refs are stale
  await refsStore.remove();

  // Launch Chrome
  const chrome = await launchChrome({
    chromePath: opts.chromePath,
    headless: true,
  });

  try {
    const targetId = await discoverPageTarget(chrome.port);

    // Unref so Chrome outlives this process
    chrome.process.unref();

    // Write state
    await stateStore.write({
      chromePid: chrome.pid,
      cdpPort: chrome.port,
      userDataDir: chrome.userDataDir,
      targetId,
    });

    return { status: "started", chromePid: chrome.pid, cdpPort: chrome.port };
  } catch (err) {
    // Cleanup on failure
    try {
      chrome.process.kill("SIGTERM");
    } catch { /* already dead */ }
    try {
      await chrome.process.status;
    } catch { /* already exited */ }
    try {
      await Deno.remove(chrome.userDataDir, { recursive: true });
    } catch { /* best effort */ }
    throw err;
  }
}

async function stopChrome(): Promise<void> {
  const state = await stateStore.read();
  if (!state) {
    throw new Error("chrome is not running");
  }

  const ownership = classifyState(state);

  if (ownership === "dead") {
    await cleanupDeadChrome(state);
    return;
  }

  if (ownership === "foreign") {
    // PID recycled — not our Chrome. Remove state file and refs.
    await stateStore.remove();
    await refsStore.remove();
    return;
  }

  // "ours" — our Chrome is alive. Send SIGTERM.
  try {
    Deno.kill(state.chromePid, "SIGTERM");
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Raced with process exit — it's dead now.
      await cleanupDeadChrome(state);
      return;
    }
    // Permission error or other unexpected failure. Process may still be alive;
    // don't delete anything, just report the error.
    throw err;
  }

  // Poll until dead
  const maxPolls = STOP_TIMEOUT_MS / STOP_POLL_INTERVAL_MS;
  for (let i = 0; i < maxPolls; i++) {
    if (!isProcessAlive(state.chromePid)) {
      await cleanupDeadChrome(state);
      return;
    }
    await new Promise((r) => setTimeout(r, STOP_POLL_INTERVAL_MS));
  }

  // Final check
  if (!isProcessAlive(state.chromePid)) {
    await cleanupDeadChrome(state);
    return;
  }

  throw new Error(`chrome process ${state.chromePid} still alive after ${STOP_TIMEOUT_MS}ms`);
}

/**
 * Read state, verify Chrome ownership, connect to CDP, run an operation, and close.
 *
 * Ownership is verified by checking the process command line for our --user-data-dir.
 *
 * Failure modes:
 * - No state file → "chrome is not running"
 * - PID dead → clean up, "chrome is not running"
 * - PID recycled (not our Chrome) → remove state file, "chrome is not running"
 * - Our Chrome alive → connect to CDP; errors propagate as-is (no state cleanup)
 */
async function withConnection<T>(
  fn: (browser: CdpBrowserService) => Promise<T>,
): Promise<T> {
  const state = await stateStore.read();
  if (!state) throw new Error("chrome is not running");

  const ownership = classifyState(state);

  if (ownership === "dead") {
    await cleanupDeadChrome(state);
    throw new Error("chrome is not running — run 'scraper start'");
  }

  if (ownership === "foreign") {
    await stateStore.remove();
    throw new Error("chrome is not running — run 'scraper start'");
  }

  // "ours" — Chrome is alive. Connect to CDP. If createCdpConnection fails
  // (e.g. stale target, transient CDP issue), let it propagate without
  // deleting state so Chrome is not orphaned.
  const browser = await createCdpConnection(state.cdpPort, state.targetId);
  try {
    return await fn(browser);
  } finally {
    browser.close();
  }
}

const deps: CliDeps = {
  startChrome,
  stopChrome,
  navigate(url: string): Promise<void> {
    return withConnection((browser) => browser.navigate(url));
  },
  snapshot(opts) {
    return withConnection(async (browser) => {
      const snapshotSvc = createSnapshotService({
        async getFullAXTree() {
          return await browser.getFullAXTree() as AXNode[];
        },
        async resolveSelector(selector: string) {
          return await browser.resolveSelector(selector);
        },
      });
      const result = await snapshotSvc.snapshot(opts);
      await refsStore.write(result.refs);
      return result;
    });
  },
  evaluate(expression: string) {
    return withConnection((browser) => browser.evaluate(expression));
  },
  screenshot(fullPage?: boolean) {
    return withConnection((browser) => browser.screenshot(fullPage));
  },
  stdout: (s) => Deno.stdout.writeSync(encoder.encode(s)),
  stderr: (s) => Deno.stderr.writeSync(encoder.encode(s)),
};

const code = await runCli(Deno.args, deps);
Deno.exit(code);
