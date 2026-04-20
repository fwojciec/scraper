// Orchestration layer implementing ScraperApp.
// The only internal module allowed to depend on multiple adapters (cdp/, aria/).
//
// Attach-only: every command reads DevToolsActivePort and opens a fresh CDP
// connection. No process-lifecycle bookkeeping, no persisted chrome.json, no
// active target — callers address every tab explicitly via a canonical targetId.

import type { CdpPageService } from "../cdp/mod.ts";
import type { SnapshotDeps } from "../aria/mod.ts";
import type {
  ActionOptions,
  ActionResult,
  ElementTarget,
  RefMap,
  ScraperApp,
  SnapshotService,
  WaitRequest,
} from "../domain/mod.ts";

/** Per-tab refs persistence (`refs.<targetId>.json`). */
export interface RefsStore {
  read(targetId: string): Promise<RefMap | null>;
  write(targetId: string, refs: RefMap): Promise<void>;
  remove(targetId: string): Promise<void>;
}

/**
 * Session-scoped monotonic counter store (`counter-refs`). Reads return 0 when
 * the file does not yet exist so callers can treat the first snapshot uniformly.
 */
export interface CounterStore {
  read(): Promise<number>;
  write(value: number): Promise<void>;
}

/** Dependencies for the scraper application layer. */
export interface ScraperAppDeps {
  // Attach (cdp/)
  userDataDir: string;
  readDevToolsActivePort(dir: string): Promise<{ port: number; wsPath: string }>;
  buildBrowserWsUrl(port: number, wsPath: string): string;
  createPageConnection(wsUrl: string, targetId: string): Promise<CdpPageService>;
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

  /** Run snapshot pipeline and persist refs + monotonic counter. */
  async function doSnapshot(
    page: CdpPageService,
    targetId: string,
    opts?: { maxDepth?: number; maxNodes?: number; selector?: string },
  ) {
    const snapshotSvc = snapshotServiceFor(page);
    const startingRefCounter = await deps.refCounterStore.read();
    const result = await snapshotSvc.snapshot({
      ...(opts ?? {}),
      startingRefCounter,
    });
    if (result.lastRefCounter !== startingRefCounter) {
      await deps.refCounterStore.write(result.lastRefCounter);
    }
    // Always overwrite per the design: `refs.<targetId>.json` is overwritten
    // by that tab's next snapshot. A snapshot that mints no refs must still
    // clear any prior refs for this tab so stale handles cannot resolve.
    if (Object.keys(result.refs).length > 0) {
      await deps.refsStore.write(targetId, result.refs);
    } else {
      await deps.refsStore.remove(targetId);
    }
    return result;
  }

  /** Execute post-action pipeline: network idle wait + optional snapshot. */
  async function postAction(
    page: CdpPageService,
    targetId: string,
    opts?: ActionOptions,
  ): Promise<ActionResult> {
    const timedOut = await page.waitForNetworkIdle();
    if (timedOut) {
      deps.warn("warning: network idle timed out — page may still be loading\n");
    }
    if (opts?.includeSnapshot) {
      const snapshot = await doSnapshot(page, targetId);
      return { snapshot };
    }
    return {};
  }

  /**
   * Wrap an action with dialog detection: dismisses any dialog that opens and
   * reports it as an error. Proper dialog policy support returns in #14.
   */
  async function withDialogHandling<T>(
    page: CdpPageService,
    fn: () => Promise<T>,
  ): Promise<T> {
    const dialogErrors: Error[] = [];
    const handlePromises: Promise<void>[] = [];

    const cleanup = page.onDialog((_type, message) => {
      handlePromises.push(page.handleDialog(false).catch(() => {}));
      dialogErrors.push(new Error(`a dialog appeared: "${message}"`));
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

  return {
    navigate(targetId: string, url: string, opts?: ActionOptions) {
      return withPageConnection(targetId, async (page) => {
        return await withDialogHandling(page, async () => {
          await page.navigate(url);
          if (opts?.includeSnapshot) {
            return await postAction(page, targetId, opts);
          }
          const timedOut = await page.waitForNetworkIdle();
          if (timedOut) {
            deps.warn("warning: network idle timed out — page may still be loading\n");
          }
          // Page context changed — invalidate this tab's refs. The monotonic
          // cross-tab counter is preserved so refs never reuse an ID.
          await deps.refsStore.remove(targetId);
          return {};
        });
      });
    },
    snapshot(targetId, opts) {
      return withPageConnection(targetId, (page) => doSnapshot(page, targetId, opts));
    },
    evaluate(targetId: string, expression: string) {
      return withPageConnection(targetId, (page) => page.evaluate(expression));
    },
    screenshot(targetId: string, fullPage?: boolean) {
      return withPageConnection(targetId, (page) => page.screenshot(fullPage));
    },
    upload(targetId: string, target: ElementTarget, filePath: string, opts?: ActionOptions) {
      return withPageConnection(targetId, async (page) => {
        const refs = await deps.refsStore.read(targetId);
        const objectId = await deps.resolveTarget(target, page, refs);
        return await withDialogHandling(page, async () => {
          await page.uploadFile(objectId, filePath);
          return await postAction(page, targetId, opts);
        });
      });
    },
    wait(targetId: string, request: WaitRequest) {
      return withPageConnection(targetId, async (page) => {
        switch (request.kind) {
          case "textInElement": {
            const refs = await deps.refsStore.read(targetId);
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
