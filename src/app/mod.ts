// Orchestration layer implementing ScraperApp.
// The only internal module allowed to depend on multiple adapters (cdp/, aria/).
//
// Attach-only: every command reads DevToolsActivePort and opens a fresh CDP
// connection. No process-lifecycle bookkeeping, no persisted chrome.json, no
// active target — callers address every tab explicitly via a canonical targetId.

import type { CdpBrowserService, CdpPageService } from "../cdp/mod.ts";
import type { SnapshotDeps } from "../aria/mod.ts";
import { formatStaleRefError, scanRefs } from "../domain/eval.ts";
import type {
  ActionOptions,
  ActionResult,
  DialogResponse,
  ElementTarget,
  EvalResult,
  NavigateNewResult,
  RefMap,
  ScraperApp,
  SnapshotDialog,
  SnapshotService,
  WaitRequest,
} from "../domain/mod.ts";

/** Per-tab refs persistence (`refs.<targetId>.json`). */
export interface RefsStore {
  read(targetId: string): Promise<RefMap | null>;
  /** Persist refs alongside the snapshotId that minted them. */
  write(targetId: string, refs: RefMap, snapshotId: string): Promise<void>;
  remove(targetId: string): Promise<void>;
}

/**
 * Session-scoped monotonic counter store. Reads return 0 when the file does not
 * yet exist so callers can treat the first snapshot uniformly. Used for both
 * the ref counter (`counter-refs`) and the artifact counter (`counter`).
 */
export interface CounterStore {
  read(): Promise<number>;
  write(value: number): Promise<void>;
}

/** Persists snapshot YAML and screenshot PNG artifacts to `~/.scraper/`. */
export interface ArtifactStore {
  /** Write `~/.scraper/<snapshotId>.yaml`; returns the full path. */
  writeSnapshot(snapshotId: string, yaml: string): Promise<string>;
  /** Write `~/.scraper/<screenshotId>.png`; returns the full path. */
  writeScreenshot(screenshotId: string, png: Uint8Array): Promise<string>;
}

/** Dependencies for the scraper application layer. */
export interface ScraperAppDeps {
  // Attach (cdp/)
  userDataDir: string;
  readDevToolsActivePort(dir: string): Promise<{ port: number; wsPath: string }>;
  buildBrowserWsUrl(port: number, wsPath: string): string;
  createPageConnection(wsUrl: string, targetId: string): Promise<CdpPageService>;
  /**
   * Browser-level CDP connection used by `navigate --new` to call
   * `Target.createTarget`. Page-scoped commands continue to use
   * `createPageConnection` directly.
   */
  createBrowserConnection(wsUrl: string): Promise<CdpBrowserService>;
  resolveTarget(
    target: ElementTarget,
    page: CdpPageService,
    refs: RefMap | null,
  ): Promise<string>;

  // Snapshot (aria/)
  createSnapshotService(deps: SnapshotDeps): SnapshotService;

  // State persistence
  refsStore: RefsStore;
  refCounterStore: CounterStore;
  artifactCounterStore: CounterStore;
  artifactStore: ArtifactStore;

  /**
   * Serialize access to `~/.scraper/` state across concurrent CLI invocations.
   * The app wraps each counter-allocating region (snapshot, screenshot) in this
   * so two parallel `scraper snapshot` processes cannot interleave their
   * read-modify-write on `counter` / `counter-refs` and mint the same `sN` or
   * overlapping ref ranges. Implemented in `main.ts` with an exclusive
   * advisory flock on `~/.scraper/state.lock`.
   */
  withStateLock<T>(fn: () => Promise<T>): Promise<T>;

  // Warning output
  warn(msg: string): void;
}

/** Create a ScraperApp wired to the given dependencies. */
export function createScraperApp(deps: ScraperAppDeps): ScraperApp {
  /** Read DevToolsActivePort and build the browser-level WebSocket URL. */
  async function browserWsUrl(): Promise<string> {
    const { port, wsPath } = await deps.readDevToolsActivePort(deps.userDataDir);
    return deps.buildBrowserWsUrl(port, wsPath);
  }

  /**
   * Attach to `targetId`, run `fn`, and always close the page connection.
   * Clears stale refs for that tab when Chrome reports the target is gone.
   */
  async function withPageConnection<T>(
    targetId: string,
    fn: (page: CdpPageService) => Promise<T>,
  ): Promise<T> {
    const wsUrl = await browserWsUrl();
    let page: CdpPageService;
    try {
      page = await deps.createPageConnection(wsUrl, targetId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("target no longer exists")) {
        await deps.refsStore.remove(targetId);
      }
      throw err;
    }
    try {
      return await fn(page);
    } finally {
      page.close();
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

  /**
   * Run snapshot pipeline and persist refs + monotonic counters + YAML file.
   * The entire read-ref-counter → mint artifact id → snapshot → write-refs
   * sequence runs under `withStateLock` so two concurrent `scraper snapshot`
   * processes cannot allocate the same `sN` or overlapping ref ranges.
   */
  function doSnapshot(
    page: CdpPageService,
    targetId: string,
    opts?: { maxDepth?: number; maxNodes?: number; selector?: string },
    dialog: SnapshotDialog | null = null,
  ) {
    return deps.withStateLock(async () => {
      const snapshotSvc = snapshotServiceFor(page);
      const startingRefCounter = await deps.refCounterStore.read();
      const artifactN = (await deps.artifactCounterStore.read()) + 1;
      await deps.artifactCounterStore.write(artifactN);
      const snapshotId = `s${artifactN}`;
      const { url, title } = await page.getPageInfo();
      const result = await snapshotSvc.snapshot({
        ...(opts ?? {}),
        startingRefCounter,
        snapshotId,
        targetId,
        url,
        title,
        dialog,
      });
      if (result.lastRefCounter !== startingRefCounter) {
        await deps.refCounterStore.write(result.lastRefCounter);
      }
      // Always overwrite per the design: `refs.<targetId>.json` is overwritten
      // by that tab's next snapshot. A snapshot that mints no refs must still
      // clear any prior refs for this tab so stale handles cannot resolve.
      if (Object.keys(result.refs).length > 0) {
        await deps.refsStore.write(targetId, result.refs, snapshotId);
      } else {
        await deps.refsStore.remove(targetId);
      }
      await deps.artifactStore.writeSnapshot(snapshotId, result.yaml);
      return result;
    });
  }

  /** Execute post-action pipeline: network idle wait + optional snapshot. */
  async function postAction(
    page: CdpPageService,
    targetId: string,
    opts: ActionOptions | undefined,
    dialog: SnapshotDialog | null,
  ): Promise<ActionResult> {
    const timedOut = await page.waitForNetworkIdle();
    if (timedOut) {
      deps.warn("warning: network idle timed out — page may still be loading\n");
    }
    if (opts?.includeSnapshot) {
      const snapshot = await doSnapshot(page, targetId, undefined, dialog);
      return { snapshot };
    }
    return {};
  }

  /**
   * Wrap an action with dialog detection. Any native JS dialog that opens
   * during `fn` is responded to according to `response` (default: dismiss) and
   * surfaced through the returned `getObservedDialog()` so the caller can
   * thread it into the post-action snapshot. Multiple dialogs in one command
   * collapse to the first one observed — that's the one the agent needs to
   * see to understand why the command's effect was unexpected.
   *
   * Distinct from the pre-#50 behavior: a dialog is no longer an error. The
   * agent observes it via the snapshot's `dialog:` field and decides whether
   * to retry with `--on-dialog accept`.
   */
  async function withDialogHandling<T>(
    page: CdpPageService,
    fn: () => Promise<T>,
    response: DialogResponse = { accept: false },
  ): Promise<{ value: T; dialog: SnapshotDialog | null }> {
    let observed: SnapshotDialog | null = null;
    const handlePromises: Promise<void>[] = [];

    const cleanup = page.onDialog((type, message) => {
      // Only the first dialog wins for snapshot reporting, but every dialog
      // still gets handled — otherwise Chrome blocks page execution.
      if (observed === null) {
        observed = {
          type,
          message,
          handled: response.accept ? "accept" : "dismiss",
        };
      }
      handlePromises.push(
        page.handleDialog(response.accept, response.promptText).catch(() => {}),
      );
    });

    try {
      const value = await fn();
      // Wait for in-flight handleDialog calls to settle — `cleanup()` only
      // unbinds the listener, it doesn't await pending acks.
      await Promise.all(handlePromises);
      return { value, dialog: observed };
    } catch (err) {
      await Promise.all(handlePromises).catch(() => {});
      throw err;
    } finally {
      cleanup();
    }
  }

  return {
    navigate(targetId: string, url: string, opts?: ActionOptions) {
      return withPageConnection(targetId, async (page) => {
        const { dialog } = await withDialogHandling(page, async () => {
          await page.navigate(url);
          // Page context changed — invalidate this tab's refs eagerly, before
          // the optional snapshot runs. If snapshotting then fails (AX-tree
          // error, disk write failure), the agent gets "stale ref" instead
          // of silently resolving against the prior page's DOM. doSnapshot
          // overwrites this file with fresh refs on success.
          await deps.refsStore.remove(targetId);
          // Network idle wait sits inside withDialogHandling because pages
          // commonly fire alert() / confirm() during load, after navigate()
          // has already resolved. Outside the wrap those dialogs block page
          // script and never get dismissed.
          const timedOut = await page.waitForNetworkIdle();
          if (timedOut) {
            deps.warn("warning: network idle timed out — page may still be loading\n");
          }
        }, opts?.onDialog);
        if (opts?.includeSnapshot) {
          const snapshot = await doSnapshot(page, targetId, undefined, dialog);
          return { snapshot };
        }
        return {};
      });
    },
    async navigateNew(url: string, opts?: ActionOptions): Promise<NavigateNewResult> {
      const wsUrl = await browserWsUrl();
      const browser = await deps.createBrowserConnection(wsUrl);
      let targetId: string;
      try {
        try {
          // createTarget at about:blank, then navigate via the page
          // connection. Guarantees our Network domain is enabled BEFORE the
          // real page's requests fire — otherwise the agent could observe
          // a snapshot of a half-loaded page when waitForNetworkIdle reports
          // 0 in-flight only because we missed the initial requestWillBeSent
          // burst.
          targetId = await browser.createTarget("about:blank");
        } catch (err) {
          browser.close();
          throw err;
        }
        try {
          return await withPageConnection(targetId, async (page) => {
            const { dialog } = await withDialogHandling(page, async () => {
              await page.navigate(url);
              const timedOut = await page.waitForNetworkIdle();
              if (timedOut) {
                deps.warn("warning: network idle timed out — page may still be loading\n");
              }
            }, opts?.onDialog);
            const snapshot = await doSnapshot(page, targetId, undefined, dialog);
            return { targetId, snapshot };
          });
        } catch (err) {
          // Roll back the leaked tab — the targetId was never returned to
          // the caller, so they have no handle to clean it up themselves.
          // Best-effort: a failure here would mask the original error.
          try {
            await browser.closeTarget(targetId);
          } catch (closeErr) {
            deps.warn(
              `warning: failed to close partially-created tab ${targetId}: ${
                closeErr instanceof Error ? closeErr.message : closeErr
              }\n`,
            );
          }
          throw err;
        }
      } finally {
        browser.close();
      }
    },
    snapshot(targetId, opts) {
      return withPageConnection(targetId, (page) => doSnapshot(page, targetId, opts));
    },
    evaluate(targetId: string, expression: string, opts?: ActionOptions) {
      return withPageConnection(targetId, async (page): Promise<EvalResult> => {
        // Wrap the whole eval path in dialog handling: `eval` often calls
        // into user JS that triggers `alert()` / `confirm()`, and without
        // the wrap those dialogs block Runtime.evaluate and we deadlock.
        const { value } = await withDialogHandling(page, async (): Promise<EvalResult> => {
          const refNames = scanRefs(expression);
          if (refNames.length === 0) return await page.evaluate(expression);
          const refs = (await deps.refsStore.read(targetId)) ?? {};
          for (const name of refNames) {
            if (!(name in refs)) {
              throw new Error(formatStaleRefError(name, targetId, Object.keys(refs)));
            }
          }
          // Resolve each ref once, preserving scan order so stale-ref errors
          // surface with the first offending ref rather than a late one.
          const resolved: Record<string, string> = {};
          for (const name of refNames) {
            resolved[name] = await page.resolveRef(refs[name], name);
          }
          return await page.evaluateWithRefs(expression, resolved);
        }, opts?.onDialog);
        return value;
      });
    },
    screenshot(targetId: string) {
      return withPageConnection(targetId, async (page) => {
        // Chrome round-trip runs outside the lock — only the counter
        // allocation + disk write need to be serialized. Holding the lock
        // across the screenshot capture would needlessly block other
        // invocations for the duration of Chrome's CaptureScreenshot call.
        const png = await page.screenshot();
        return await deps.withStateLock(async () => {
          const artifactN = (await deps.artifactCounterStore.read()) + 1;
          await deps.artifactCounterStore.write(artifactN);
          return await deps.artifactStore.writeScreenshot(`shot${artifactN}`, png);
        });
      });
    },
    upload(targetId: string, target: ElementTarget, filePath: string, opts?: ActionOptions) {
      return withPageConnection(targetId, async (page) => {
        const refs = await deps.refsStore.read(targetId);
        // Match eval's stale-ref contract: when the agent passes `--ref eN` and
        // eN is not in this tab's current refs, fail with the canonical
        // stale-ref error pointing at refs.<targetId>.json — not the lower-level
        // "unknown ref" message resolveTarget produces. Keeps the agent's error
        // recovery loop ("run snapshot, retry") consistent across commands.
        if ("ref" in target && !(refs && target.ref in refs)) {
          throw new Error(
            formatStaleRefError(target.ref, targetId, refs ? Object.keys(refs) : []),
          );
        }
        const objectId = await deps.resolveTarget(target, page, refs);
        const { dialog } = await withDialogHandling(page, async () => {
          await page.uploadFile(objectId, filePath);
        }, opts?.onDialog);
        return await postAction(page, targetId, opts, dialog);
      });
    },
    wait(targetId: string, request: WaitRequest, opts?: ActionOptions) {
      return withPageConnection(targetId, async (page): Promise<ActionResult> => {
        // Wrap the wait itself in dialog handling: the element being waited for
        // may appear alongside a dialog (e.g. click that triggered the wait also
        // fires alert()). Without the wrap the dialog blocks page script and
        // the wait ends up timing out even though the target condition is met.
        const { dialog } = await withDialogHandling(page, async () => {
          switch (request.kind) {
            case "textInElement": {
              const refs = await deps.refsStore.read(targetId);
              // Match eval/upload's stale-ref contract: a missing `--ref eN`
              // surfaces the canonical stale-ref error (pointing at
              // refs.<targetId>.json) instead of resolveTarget's lower-level
              // "unknown ref" text. Keeps the "run snapshot, retry" recovery
              // loop uniform across every ref-consuming command.
              const target = request.target;
              if ("ref" in target && !(refs && target.ref in refs)) {
                throw new Error(
                  formatStaleRefError(target.ref, targetId, refs ? Object.keys(refs) : []),
                );
              }
              const objectId = await deps.resolveTarget(target, page, refs);
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
        }, opts?.onDialog);
        if (!opts?.includeSnapshot) return {};
        // Wait succeeded — the page likely changed (new element / text). Drop
        // this tab's refs eagerly, before the network-idle gate and snapshot,
        // so a snapshot failure can't leave stale refs resolving against the
        // old DOM. See the parallel pattern in `navigate` above.
        await deps.refsStore.remove(targetId);
        // Route through `postAction` for the same network-idle stability gate
        // navigate/upload use: the wait-trigger may only be the first step of
        // a larger async update (e.g., a results container appears before its
        // contents finish loading), so snapshotting immediately could capture
        // an intermediate DOM whose refs go stale by the next command.
        return await postAction(page, targetId, opts, dialog);
      });
    },
  };
}
