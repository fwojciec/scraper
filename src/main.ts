// Composition root: wires adapters -> domain.
// `scraper start` launches Chrome and exits. All other commands connect to CDP directly.

import { type CliDeps, runCli, type StartOptions, type StartResult } from "./cli/mod.ts";
import {
  buildBrowserWsUrl,
  type CdpBrowserService,
  type CdpPageService,
  createBrowserConnection,
  createPageConnection,
  defaultUserDataDir,
  discoverWsUrl,
  launchChrome,
  readDevToolsActivePort,
  resolveTarget,
} from "./cdp/mod.ts";
import { type AXNode, createSnapshotService } from "./aria/mod.ts";
import { createJsonFileStore } from "./fs/mod.ts";
import type {
  ActionOptions,
  ActionResult,
  DialogPolicy,
  ElementTarget,
  PageInfo,
  RefMap,
  WaitOptions,
} from "./domain/mod.ts";

const HOME = Deno.env.get("HOME");
if (!HOME) throw new Error("HOME environment variable is not set");
const STATE_PATH = `${HOME}/.scraper/chrome.json`;

/** Owned mode: we launched Chrome. */
interface OwnedState {
  mode: "owned";
  chromePid: number;
  cdpPort: number;
  userDataDir: string;
  targetId: string;
}

/** Attached mode: connected to user's Chrome. targetId absent until `page <id>`. */
interface AttachedState {
  mode: "attached";
  cdpPort: number;
  wsPath: string;
  targetId?: string;
}

type ChromeState = OwnedState | AttachedState;

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
 * Classify owned state into one of three ownership states:
 * - "dead": PID is not alive. Safe to clean up everything.
 * - "ours": PID alive AND its command line contains our --user-data-dir.
 * - "foreign": PID alive but it's not our Chrome (recycled PID).
 */
function classifyOwnedState(state: OwnedState): "dead" | "ours" | "foreign" {
  if (!isProcessAlive(state.chromePid)) return "dead";
  return isOurChromeProcess(state.chromePid, state.userDataDir) ? "ours" : "foreign";
}

/** Probe Chrome's CDP endpoint. */
async function isCdpResponding(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Clean up after a confirmed-dead owned Chrome process.
 * Only safe to call when isProcessAlive(state.chromePid) is false.
 */
async function cleanupDeadChrome(state: OwnedState): Promise<void> {
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

/** Resolve a browser-level WebSocket URL from state. */
async function browserWsUrl(state: ChromeState): Promise<string> {
  if (state.mode === "attached") {
    return buildBrowserWsUrl(state.cdpPort, state.wsPath);
  }
  return await discoverWsUrl(state.cdpPort);
}

async function startChrome(opts: StartOptions): Promise<StartResult> {
  if (opts.attach) {
    return await startAttach(opts.channel);
  }

  const existing = await stateStore.read();

  if (existing) {
    if (existing.mode === "attached") {
      // Attached session exists — user should stop it first.
      throw new Error("already attached to Chrome — run 'scraper stop' first");
    }

    const ownership = classifyOwnedState(existing);

    if (ownership === "ours") {
      // Our Chrome is alive. Use CDP probe to check if it's healthy.
      if (await isCdpResponding(existing.cdpPort)) {
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
      mode: "owned",
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

const ATTACH_TIMEOUT_MS = 30_000;

async function startAttach(channel?: string): Promise<StartResult> {
  const existing = await stateStore.read();
  if (existing) {
    if (existing.mode === "attached") {
      // Already attached — check if CDP still responds
      if (await isCdpResponding(existing.cdpPort)) {
        return { status: "already_running", cdpPort: existing.cdpPort };
      }
      // Stale attached state — clean up
      await stateStore.remove();
      await refsStore.remove();
    } else {
      // Owned Chrome running — user should stop it first
      throw new Error("Chrome was launched by scraper — run 'scraper stop' first");
    }
  }

  // New session = old refs are stale
  await refsStore.remove();

  const userDataDir = defaultUserDataDir(channel);
  const { port, wsPath } = await readDevToolsActivePort(userDataDir);
  const wsUrl = buildBrowserWsUrl(port, wsPath);

  // Attempt to connect with timeout — Chrome may show an approval dialog
  let timerId: number | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error("timed out waiting for Chrome — approve the dialog in Chrome")),
      ATTACH_TIMEOUT_MS,
    );
  });

  try {
    const connectAndVerify = async () => {
      const browser = await createBrowserConnection(wsUrl);
      try {
        await browser.listPages();
      } finally {
        browser.close();
      }
    };
    await Promise.race([connectAndVerify(), timeoutPromise]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timed out")) throw err;
    throw new Error(
      `connection denied — approve the dialog in Chrome, or check chrome://inspect/#remote-debugging (${msg})`,
    );
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }

  await stateStore.write({
    mode: "attached",
    cdpPort: port,
    wsPath,
  });

  return { status: "attached", cdpPort: port };
}

async function stopChrome(): Promise<void> {
  const state = await stateStore.read();
  if (!state) {
    throw new Error("chrome is not running");
  }

  if (state.mode === "attached") {
    // Attached mode — just remove state files, don't kill Chrome
    await stateStore.remove();
    await refsStore.remove();
    return;
  }

  // Owned mode
  const ownership = classifyOwnedState(state);

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
 * Validate state and get a browser-level WebSocket URL.
 * Verifies owned Chrome is alive; for attached mode, just returns the URL.
 */
async function resolveState(): Promise<{ state: ChromeState; wsUrl: string }> {
  const state = await stateStore.read();
  if (!state) throw new Error("chrome is not running — run 'scraper start'");

  if (state.mode === "owned") {
    const ownership = classifyOwnedState(state);
    if (ownership === "dead") {
      await cleanupDeadChrome(state);
      throw new Error("chrome is not running — run 'scraper start'");
    }
    if (ownership === "foreign") {
      await stateStore.remove();
      throw new Error("chrome is not running — run 'scraper start'");
    }
  }

  const wsUrl = await browserWsUrl(state);
  return { state, wsUrl };
}

/**
 * Browser-level connection: no targetId needed.
 * Used by `pages`, `page`, and `stop`.
 */
async function withBrowserConnection<T>(
  fn: (browser: CdpBrowserService, state: ChromeState) => Promise<T>,
): Promise<T> {
  const { state, wsUrl } = await resolveState();
  const browser = await createBrowserConnection(wsUrl);
  try {
    return await fn(browser, state);
  } finally {
    browser.close();
  }
}

/**
 * Page-level connection: targetId required.
 * Used by navigate, snapshot, eval, screenshot, and all actions.
 */
async function withPageConnection<T>(
  fn: (browser: CdpPageService) => Promise<T>,
): Promise<T> {
  const { state, wsUrl } = await resolveState();

  if (!state.targetId) {
    throw new Error("no page selected — run 'scraper pages' then 'scraper page <id>'");
  }

  const browser = await createPageConnection(wsUrl, state.targetId);
  try {
    return await fn(browser);
  } finally {
    browser.close();
  }
}

async function listPages(): Promise<PageInfo[]> {
  return await withBrowserConnection(async (browser, state) => {
    return await browser.listPages(state.targetId);
  });
}

async function selectPage(targetId: string): Promise<void> {
  await withBrowserConnection(async (browser, state) => {
    // Verify the target exists
    const pages = await browser.listPages();
    const found = pages.find((p) => p.targetId === targetId);
    if (!found) {
      throw new Error(`no page with targetId '${targetId}' — run 'scraper pages' to list tabs`);
    }

    // Update state with new targetId (single read, no race)
    await stateStore.write({ ...state, targetId });
  });

  // Old refs are meaningless for the new page
  await refsStore.remove();
}

/** Run snapshot pipeline and persist refs. */
async function doSnapshot(
  page: CdpPageService,
  opts?: { maxDepth?: number; maxNodes?: number; selector?: string },
) {
  const snapshotSvc = createSnapshotService({
    async getFullAXTree() {
      return await page.getFullAXTree() as AXNode[];
    },
    async resolveSelector(selector: string) {
      return await page.resolveSelector(selector);
    },
  });
  const result = await snapshotSvc.snapshot(opts ?? {});
  await refsStore.write(result.refs);
  return result;
}

/** Execute post-action pipeline: network idle wait + optional snapshot. */
async function postAction(
  page: CdpPageService,
  opts?: ActionOptions,
): Promise<ActionResult> {
  await page.waitForNetworkIdle();
  if (opts?.includeSnapshot) {
    const snapshot = await doSnapshot(page);
    return { snapshot };
  }
  return {};
}

/**
 * Wrap an action with dialog detection.
 * Always-on: registers listener before action, checks after.
 * With policy: handles dialog per policy.
 * Without policy: dismisses dialog to unblock, then throws.
 */
async function withDialogHandling<T>(
  page: CdpPageService,
  policy: DialogPolicy | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const dialogErrors: Error[] = [];
  const handlePromises: Promise<void>[] = [];

  const cleanup = page.onDialog((_type, message) => {
    if (policy) {
      handlePromises.push(
        page.handleDialog(
          policy.action === "accept",
          policy.action === "accept" ? policy.text : undefined,
        ).catch((err) => {
          dialogErrors.push(
            new Error(
              `failed to handle dialog: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }),
      );
    } else {
      // Dismiss to unblock the page, then signal error
      handlePromises.push(page.handleDialog(false).catch(() => {}));
      dialogErrors.push(
        new Error(
          `a dialog appeared: "${message}" — retry with --on-dialog accept|dismiss`,
        ),
      );
    }
  });

  try {
    const result = await fn();
    await Promise.all(handlePromises);
    if (dialogErrors.length) throw dialogErrors[0];
    return result;
  } catch (err) {
    await Promise.all(handlePromises);
    if (dialogErrors.length) {
      throw new AggregateError(
        [err, ...dialogErrors],
        `${err instanceof Error ? err.message : err}; also: ${
          dialogErrors.map((e) => e.message).join(", ")
        }`,
      );
    }
    throw err;
  } finally {
    cleanup();
  }
}

/** Execute a mutating action with dialog handling + post-action pipeline. */
function executeAction(
  page: CdpPageService,
  action: () => Promise<void>,
  opts?: ActionOptions,
): Promise<ActionResult> {
  return withDialogHandling(page, opts?.onDialog, async () => {
    await action();
    return await postAction(page, opts);
  });
}

const deps: CliDeps = {
  startChrome,
  stopChrome,
  navigate(url: string, opts?: ActionOptions) {
    return withPageConnection(async (page) => {
      return await withDialogHandling(page, opts?.onDialog, async () => {
        await page.navigate(url);
        if (opts?.includeSnapshot) {
          return await postAction(page, opts);
        }
        // Navigation without --snapshot: wait for network idle, then invalidate refs
        await page.waitForNetworkIdle();
        await refsStore.remove();
        return {};
      });
    });
  },
  snapshot(opts) {
    return withPageConnection((page) => doSnapshot(page, opts));
  },
  evaluate(expression: string) {
    return withPageConnection((page) => page.evaluate(expression));
  },
  screenshot(fullPage?: boolean) {
    return withPageConnection((page) => page.screenshot(fullPage));
  },
  listPages,
  selectPage,
  click(target: ElementTarget, opts?: ActionOptions) {
    return withPageConnection(async (page) => {
      const refs = await refsStore.read();
      const objectId = await resolveTarget(target, page, refs);
      return await executeAction(page, () => page.clickElement(objectId), opts);
    });
  },
  fill(target: ElementTarget, value: string, opts?: ActionOptions) {
    return withPageConnection(async (page) => {
      const refs = await refsStore.read();
      const objectId = await resolveTarget(target, page, refs);
      return await executeAction(
        page,
        () => page.fillElement(objectId, value),
        opts,
      );
    });
  },
  type(target: ElementTarget, text: string, opts?: ActionOptions) {
    return withPageConnection(async (page) => {
      const refs = await refsStore.read();
      const objectId = await resolveTarget(target, page, refs);
      return await executeAction(
        page,
        () => page.typeText(objectId, text),
        opts,
      );
    });
  },
  selectOption(target: ElementTarget, value: string, opts?: ActionOptions) {
    return withPageConnection(async (page) => {
      const refs = await refsStore.read();
      const objectId = await resolveTarget(target, page, refs);
      return await executeAction(
        page,
        () => page.selectOption(objectId, value),
        opts,
      );
    });
  },
  submit(target: ElementTarget, opts?: ActionOptions) {
    return withPageConnection(async (page) => {
      const refs = await refsStore.read();
      const objectId = await resolveTarget(target, page, refs);
      return await executeAction(
        page,
        () => page.submitForm(objectId),
        opts,
      );
    });
  },
  pressKey(key: string, target?: ElementTarget, opts?: ActionOptions) {
    return withPageConnection(async (page) => {
      return await executeAction(
        page,
        async () => {
          if (target) {
            const refs = await refsStore.read();
            const objectId = await resolveTarget(target, page, refs);
            await page.focusElement(objectId);
          }
          await page.pressKey(key);
        },
        opts,
      );
    });
  },
  upload(target: ElementTarget, filePath: string, opts?: ActionOptions) {
    return withPageConnection(async (page) => {
      const refs = await refsStore.read();
      const objectId = await resolveTarget(target, page, refs);
      return await executeAction(
        page,
        () => page.uploadFile(objectId, filePath),
        opts,
      );
    });
  },
  wait(opts: WaitOptions) {
    return withPageConnection(async (page) => {
      const timeoutMs = opts.timeoutMs;

      if (opts.target && opts.text) {
        // Wait for text within element
        const refs = await refsStore.read();
        const objectId = await resolveTarget(opts.target, page, refs);
        await page.waitForTextInElement(objectId, opts.text, timeoutMs);
      } else if (opts.text) {
        // Wait for text anywhere on page
        await page.waitForText(opts.text, timeoutMs);
      } else if (opts.target && "selector" in opts.target) {
        // Wait for element to exist
        await page.waitForSelector(opts.target.selector, timeoutMs);
      }
    });
  },
  stdout: (s) => Deno.stdout.writeSync(encoder.encode(s)),
  stderr: (s) => Deno.stderr.writeSync(encoder.encode(s)),
};

const code = await runCli(Deno.args, deps);
Deno.exit(code);
