// Orchestration layer implementing ScraperApp.
// The only internal module allowed to depend on multiple adapters (cdp/, aria/, fs/).

import type { ChromeProcess, LaunchOptions } from "../cdp/mod.ts";
import type { CdpBrowserService, CdpPageService } from "../cdp/mod.ts";
import type { SnapshotDeps } from "../aria/mod.ts";
import type { JsonFileStore } from "../fs/mod.ts";
import type {
  ActionOptions,
  ActionResult,
  DialogPolicy,
  ElementTarget,
  PageInfo,
  RefMap,
  ScraperApp,
  SnapshotService,
  StartOptions,
  StartResult,
  WaitRequest,
} from "../domain/mod.ts";

/** Owned mode: we launched Chrome. */
export interface OwnedState {
  mode: "owned";
  chromePid: number;
  cdpPort: number;
  userDataDir: string;
  targetId: string;
}

/** Attached mode: connected to user's Chrome. targetId absent until `page <id>`. */
export interface AttachedState {
  mode: "attached";
  cdpPort: number;
  wsPath: string;
  targetId?: string;
}

export type ChromeState = OwnedState | AttachedState;

/** Dependencies for the scraper application layer. */
export interface ScraperAppDeps {
  // Chrome lifecycle (cdp/)
  launchChrome(opts: LaunchOptions): Promise<ChromeProcess>;
  defaultUserDataDir(channel?: string): string;
  readDevToolsActivePort(dir: string): Promise<{ port: number; wsPath: string }>;

  // CDP connectivity (cdp/)
  buildBrowserWsUrl(port: number, wsPath: string): string;
  discoverWsUrl(port: number): Promise<string>;
  createBrowserConnection(wsUrl: string): Promise<CdpBrowserService>;
  createPageConnection(wsUrl: string, targetId: string): Promise<CdpPageService>;
  resolveTarget(
    target: ElementTarget,
    page: CdpPageService,
    refs: RefMap | null,
  ): Promise<string>;

  // Snapshot (aria/)
  createSnapshotService(deps: SnapshotDeps): SnapshotService;

  // State persistence (fs/)
  stateStore: JsonFileStore<ChromeState>;
  refsStore: JsonFileStore<RefMap>;

  // OS-level operations (injected for testability)
  isProcessAlive(pid: number): boolean;
  isOurChromeProcess(pid: number, userDataDir: string): boolean;
  killProcess(pid: number): void;
  removeDir(path: string): Promise<void>;
  fetch(url: string): Promise<Response>;

  // Warning output
  warn(msg: string): void;
}

const ATTACH_TIMEOUT_MS = 30_000;
const STOP_POLL_INTERVAL_MS = 100;
const STOP_TIMEOUT_MS = 5000;

/** Create a ScraperApp wired to the given dependencies. */
export function createScraperApp(deps: ScraperAppDeps): ScraperApp {
  /**
   * Classify owned state into one of three ownership states:
   * - "dead": PID is not alive. Safe to clean up everything.
   * - "ours": PID alive AND its command line contains our --user-data-dir.
   * - "foreign": PID alive but it's not our Chrome (recycled PID).
   */
  function classifyOwnedState(state: OwnedState): "dead" | "ours" | "foreign" {
    if (!deps.isProcessAlive(state.chromePid)) return "dead";
    return deps.isOurChromeProcess(state.chromePid, state.userDataDir) ? "ours" : "foreign";
  }

  /** Probe Chrome's CDP endpoint. */
  async function isCdpResponding(port: number): Promise<boolean> {
    try {
      const res = await deps.fetch(`http://127.0.0.1:${port}/json/version`);
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
      await deps.removeDir(state.userDataDir);
    } catch { /* best effort */ }
    await deps.stateStore.remove();
    await deps.refsStore.remove();
  }

  /**
   * Discover the initial page target from Chrome's /json/list, with retries.
   * Retries both transport failures and missing-target conditions.
   */
  async function discoverPageTarget(port: number): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await deps.fetch(`http://127.0.0.1:${port}/json/list`);
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
      if (attempt < 4) await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("no page target found in Chrome");
  }

  /** Resolve a browser-level WebSocket URL from state. */
  async function browserWsUrl(state: ChromeState): Promise<string> {
    if (state.mode === "attached") {
      return deps.buildBrowserWsUrl(state.cdpPort, state.wsPath);
    }
    return await deps.discoverWsUrl(state.cdpPort);
  }

  async function startChrome(opts: StartOptions): Promise<StartResult> {
    if (opts.attach) {
      return await startAttach(opts.channel);
    }

    const existing = await deps.stateStore.read();

    if (existing) {
      if (existing.mode === "attached") {
        throw new Error("already attached to Chrome — run 'scraper stop' first");
      }

      const ownership = classifyOwnedState(existing);

      if (ownership === "ours") {
        if (await isCdpResponding(existing.cdpPort)) {
          return {
            status: "already_running",
            chromePid: existing.chromePid,
            cdpPort: existing.cdpPort,
          };
        }
        throw new Error(
          `chrome appears to be running (pid ${existing.chromePid}) but is not responding` +
            ` — run 'scraper stop' first`,
        );
      }

      if (ownership === "dead") {
        await cleanupDeadChrome(existing);
      } else {
        // "foreign" — PID recycled. Remove state file only.
        await deps.stateStore.remove();
      }
    }

    // New session = old refs are stale
    await deps.refsStore.remove();

    const chrome = await deps.launchChrome({
      chromePath: opts.chromePath,
      headless: true,
    });

    try {
      const targetId = await discoverPageTarget(chrome.port);

      // Unref so Chrome outlives this process
      chrome.process.unref();

      await deps.stateStore.write({
        mode: "owned",
        chromePid: chrome.pid,
        cdpPort: chrome.port,
        userDataDir: chrome.userDataDir,
        targetId,
      });

      return { status: "started", chromePid: chrome.pid, cdpPort: chrome.port };
    } catch (err) {
      try {
        chrome.process.kill("SIGTERM");
      } catch { /* already dead */ }
      try {
        await chrome.process.status;
      } catch { /* already exited */ }
      try {
        await deps.removeDir(chrome.userDataDir);
      } catch { /* best effort */ }
      throw err;
    }
  }

  async function startAttach(channel?: string): Promise<StartResult> {
    const existing = await deps.stateStore.read();
    if (existing) {
      if (existing.mode === "attached") {
        if (await isCdpResponding(existing.cdpPort)) {
          return { status: "already_running", cdpPort: existing.cdpPort };
        }
        await deps.stateStore.remove();
        await deps.refsStore.remove();
      } else {
        throw new Error("Chrome was launched by scraper — run 'scraper stop' first");
      }
    }

    const userDataDir = deps.defaultUserDataDir(channel);
    const { port, wsPath } = await deps.readDevToolsActivePort(userDataDir);
    const wsUrl = deps.buildBrowserWsUrl(port, wsPath);

    let timerId: number | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error("timed out waiting for Chrome — approve the dialog in Chrome")),
        ATTACH_TIMEOUT_MS,
      );
    });
    timeoutPromise.catch(() => {});

    try {
      const connectAndVerify = async () => {
        const browser = await deps.createBrowserConnection(wsUrl);
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

    await deps.stateStore.write({
      mode: "attached",
      cdpPort: port,
      wsPath,
    });

    return { status: "attached", cdpPort: port };
  }

  async function stopChrome(): Promise<void> {
    const state = await deps.stateStore.read();
    if (!state) {
      throw new Error("chrome is not running");
    }

    if (state.mode === "attached") {
      await deps.stateStore.remove();
      await deps.refsStore.remove();
      return;
    }

    const ownership = classifyOwnedState(state);

    if (ownership === "dead") {
      await cleanupDeadChrome(state);
      return;
    }

    if (ownership === "foreign") {
      await deps.stateStore.remove();
      await deps.refsStore.remove();
      return;
    }

    // "ours" — our Chrome is alive. Send SIGTERM.
    try {
      deps.killProcess(state.chromePid);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        await cleanupDeadChrome(state);
        return;
      }
      throw err;
    }

    // Poll until dead
    const maxPolls = STOP_TIMEOUT_MS / STOP_POLL_INTERVAL_MS;
    for (let i = 0; i < maxPolls; i++) {
      if (!deps.isProcessAlive(state.chromePid)) {
        await cleanupDeadChrome(state);
        return;
      }
      await new Promise((r) => setTimeout(r, STOP_POLL_INTERVAL_MS));
    }

    if (!deps.isProcessAlive(state.chromePid)) {
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
    const state = await deps.stateStore.read();
    if (!state) throw new Error("chrome is not running — run 'scraper start'");

    if (state.mode === "owned") {
      const ownership = classifyOwnedState(state);
      if (ownership === "dead") {
        await cleanupDeadChrome(state);
        throw new Error("chrome is not running — run 'scraper start'");
      }
      if (ownership === "foreign") {
        await deps.stateStore.remove();
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
    const browser = await deps.createBrowserConnection(wsUrl);
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

    const browser = await deps.createPageConnection(wsUrl, state.targetId);
    try {
      return await fn(browser);
    } finally {
      browser.close();
    }
  }

  /** Build a SnapshotService bound to a page connection. */
  function snapshotServiceFor(page: CdpPageService) {
    return deps.createSnapshotService({
      async getFullAXTree() {
        return await page.getFullAXTree();
      },
      async resolveSelector(selector: string) {
        return await page.resolveSelector(selector);
      },
    });
  }

  /** Run snapshot pipeline and persist refs. */
  async function doSnapshot(
    page: CdpPageService,
    opts?: { maxDepth?: number; maxNodes?: number; selector?: string },
  ) {
    const snapshotSvc = snapshotServiceFor(page);
    const result = await snapshotSvc.snapshot(opts ?? {});
    if (Object.keys(result.refs).length > 0) {
      await deps.refsStore.write(result.refs);
    }
    return result;
  }

  /** Execute post-action pipeline: network idle wait + optional snapshot. */
  async function postAction(
    page: CdpPageService,
    opts?: ActionOptions,
  ): Promise<ActionResult> {
    const timedOut = await page.waitForNetworkIdle();
    if (timedOut) {
      deps.warn("warning: network idle timed out — page may still be loading\n");
    }
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
      await Promise.all(handlePromises).catch(() => {});
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
    opts: ActionOptions | undefined,
  ): Promise<ActionResult> {
    return withDialogHandling(page, opts?.onDialog, async () => {
      await action();
      return await postAction(page, opts);
    });
  }

  async function listPages(): Promise<PageInfo[]> {
    return await withBrowserConnection(async (browser, state) => {
      return await browser.listPages(state.targetId);
    });
  }

  async function selectPage(pageId: string): Promise<void> {
    await withBrowserConnection(async (browser, state) => {
      const pages = await browser.listPages();
      const found = pages.find((p) => p.pageId === pageId);
      if (!found) {
        throw new Error(`no page with id '${pageId}' — run 'scraper pages' to list tabs`);
      }
      await deps.stateStore.write({ ...state, targetId: pageId });
      await deps.refsStore.remove();
    });
  }

  return {
    start: startChrome,
    stop: stopChrome,
    navigate(url: string, opts?: ActionOptions) {
      return withPageConnection(async (page) => {
        return await withDialogHandling(page, opts?.onDialog, async () => {
          await page.navigate(url);
          if (opts?.includeSnapshot) {
            return await postAction(page, opts);
          }
          const timedOut = await page.waitForNetworkIdle();
          if (timedOut) {
            deps.warn("warning: network idle timed out — page may still be loading\n");
          }
          await deps.refsStore.remove();
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
    pages: listPages,
    selectPage,
    click(target: ElementTarget, opts?: ActionOptions) {
      return withPageConnection(async (page) => {
        const refs = await deps.refsStore.read();
        const objectId = await deps.resolveTarget(target, page, refs);
        return await executeAction(page, () => page.clickElement(objectId), opts);
      });
    },
    fill(target: ElementTarget, value: string, opts?: ActionOptions) {
      return withPageConnection(async (page) => {
        const refs = await deps.refsStore.read();
        const objectId = await deps.resolveTarget(target, page, refs);
        return await executeAction(page, () => page.fillElement(objectId, value), opts);
      });
    },
    type(target: ElementTarget, text: string, opts?: ActionOptions) {
      return withPageConnection(async (page) => {
        const refs = await deps.refsStore.read();
        const objectId = await deps.resolveTarget(target, page, refs);
        return await executeAction(page, () => page.typeText(objectId, text), opts);
      });
    },
    selectOption(target: ElementTarget, value: string, opts?: ActionOptions) {
      return withPageConnection(async (page) => {
        const refs = await deps.refsStore.read();
        const objectId = await deps.resolveTarget(target, page, refs);
        return await executeAction(page, () => page.selectOption(objectId, value), opts);
      });
    },
    submit(target: ElementTarget, opts?: ActionOptions) {
      return withPageConnection(async (page) => {
        const refs = await deps.refsStore.read();
        const objectId = await deps.resolveTarget(target, page, refs);
        return await executeAction(page, () => page.submitForm(objectId), opts);
      });
    },
    pressKey(key: string, target?: ElementTarget, opts?: ActionOptions) {
      return withPageConnection(async (page) => {
        return await executeAction(
          page,
          async () => {
            if (target) {
              const refs = await deps.refsStore.read();
              const objectId = await deps.resolveTarget(target, page, refs);
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
        const refs = await deps.refsStore.read();
        const objectId = await deps.resolveTarget(target, page, refs);
        return await executeAction(page, () => page.uploadFile(objectId, filePath), opts);
      });
    },
    wait(request: WaitRequest) {
      return withPageConnection(async (page) => {
        switch (request.kind) {
          case "textInElement": {
            const refs = await deps.refsStore.read();
            const objectId = await deps.resolveTarget(request.target, page, refs);
            await page.waitForTextInElement(objectId, request.text, request.timeoutMs);
            break;
          }
          case "text":
            await page.waitForText(request.text, request.timeoutMs);
            break;
          case "selector":
            await page.waitForSelector(request.selector, request.timeoutMs);
            break;
        }
      });
    },
  };
}
