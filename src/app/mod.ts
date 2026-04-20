// Orchestration layer implementing ScraperApp.
// The only internal module allowed to depend on multiple adapters (cdp/, aria/).
//
// Attach-only: every command reads DevToolsActivePort and opens a fresh CDP
// connection. No process-lifecycle bookkeeping, no persisted chrome.json.

import type { CdpBrowserService, CdpPageService } from "../cdp/mod.ts";
import type { SnapshotDeps } from "../aria/mod.ts";
import type {
  ActionOptions,
  ActionResult,
  ElementTarget,
  PageInfo,
  RefMap,
  ScraperApp,
  SnapshotService,
  WaitRequest,
} from "../domain/mod.ts";

/** Simple key-value file persistence. Inlined to avoid a generic abstraction. */
export interface TargetStore {
  read(): Promise<string | null>;
  write(targetId: string): Promise<void>;
  remove(): Promise<void>;
}

/** Refs persistence. */
export interface RefsStore {
  read(): Promise<RefMap | null>;
  write(refs: RefMap): Promise<void>;
  remove(): Promise<void>;
}

/** Dependencies for the scraper application layer. */
export interface ScraperAppDeps {
  // Attach (cdp/)
  userDataDir: string;
  readDevToolsActivePort(dir: string): Promise<{ port: number; wsPath: string }>;
  buildBrowserWsUrl(port: number, wsPath: string): string;
  createBrowserConnection(wsUrl: string): Promise<CdpBrowserService>;
  createPageConnection(wsUrl: string, targetId: string): Promise<CdpPageService>;
  resolveTarget(
    target: ElementTarget,
    page: CdpPageService,
    refs: RefMap | null,
  ): Promise<string>;

  // Snapshot (aria/)
  createSnapshotService(deps: SnapshotDeps): SnapshotService;

  // State persistence
  targetStore: TargetStore;
  refsStore: RefsStore;

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

  /** Browser-level connection: used for listing / selecting pages. */
  async function withBrowserConnection<T>(
    fn: (browser: CdpBrowserService) => Promise<T>,
  ): Promise<T> {
    const wsUrl = await browserWsUrl();
    const browser = await deps.createBrowserConnection(wsUrl);
    try {
      return await fn(browser);
    } finally {
      browser.close();
    }
  }

  /** Page-level connection: requires a previously selected target. */
  async function withPageConnection<T>(
    fn: (page: CdpPageService) => Promise<T>,
  ): Promise<T> {
    const targetId = await deps.targetStore.read();
    if (!targetId) {
      throw new Error("no page selected");
    }
    const wsUrl = await browserWsUrl();
    let page: CdpPageService;
    try {
      page = await deps.createPageConnection(wsUrl, targetId);
    } catch (err) {
      // Chrome restarted or the tab was closed — clear the stale target so the
      // next command can re-select instead of failing with the same error.
      if (err instanceof Error && err.message.includes("target no longer exists")) {
        await deps.targetStore.remove();
        await deps.refsStore.remove();
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

  async function listPages(): Promise<PageInfo[]> {
    return await withBrowserConnection(async (browser) => {
      const targetId = await deps.targetStore.read();
      return await browser.listPages(targetId ?? undefined);
    });
  }

  async function selectPage(pageId: string): Promise<void> {
    await withBrowserConnection(async (browser) => {
      const pages = await browser.listPages();
      const found = pages.find((p) => p.pageId === pageId);
      if (!found) {
        throw new Error(`no page with id '${pageId}'`);
      }
      await deps.targetStore.write(pageId);
      await deps.refsStore.remove();
    });
  }

  return {
    navigate(url: string, opts?: ActionOptions) {
      return withPageConnection(async (page) => {
        return await withDialogHandling(page, async () => {
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
    upload(target: ElementTarget, filePath: string, opts?: ActionOptions) {
      return withPageConnection(async (page) => {
        const refs = await deps.refsStore.read();
        const objectId = await deps.resolveTarget(target, page, refs);
        return await withDialogHandling(page, async () => {
          await page.uploadFile(objectId, filePath);
          return await postAction(page, opts);
        });
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
