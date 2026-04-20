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
  ElementTarget,
  EvalResult,
  NavigateNewResult,
  RefMap,
  ScraperApp,
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

  /** Reserve the next artifact id (monotonic across snapshots and screenshots). */
  async function nextArtifactCounter(): Promise<number> {
    const current = await deps.artifactCounterStore.read();
    const next = current + 1;
    await deps.artifactCounterStore.write(next);
    return next;
  }

  /** Run snapshot pipeline and persist refs + monotonic counters + YAML file. */
  async function doSnapshot(
    page: CdpPageService,
    targetId: string,
    opts?: { maxDepth?: number; maxNodes?: number; selector?: string },
  ) {
    const snapshotSvc = snapshotServiceFor(page);
    const startingRefCounter = await deps.refCounterStore.read();
    const artifactN = await nextArtifactCounter();
    const snapshotId = `s${artifactN}`;
    const { url, title } = await page.getPageInfo();
    const result = await snapshotSvc.snapshot({
      ...(opts ?? {}),
      startingRefCounter,
      snapshotId,
      targetId,
      url,
      title,
      dialog: null,
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
          // Page context changed — invalidate this tab's refs eagerly, before
          // the optional snapshot runs. If snapshotting then fails (AX-tree
          // error, disk write failure), the agent gets "stale ref" instead
          // of silently resolving against the prior page's DOM. doSnapshot
          // overwrites this file with fresh refs on success.
          await deps.refsStore.remove(targetId);
          if (opts?.includeSnapshot) {
            return await postAction(page, targetId, opts);
          }
          const timedOut = await page.waitForNetworkIdle();
          if (timedOut) {
            deps.warn("warning: network idle timed out — page may still be loading\n");
          }
          return {};
        });
      });
    },
    async navigateNew(url: string): Promise<NavigateNewResult> {
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
            return await withDialogHandling(page, async () => {
              await page.navigate(url);
              const timedOut = await page.waitForNetworkIdle();
              if (timedOut) {
                deps.warn("warning: network idle timed out — page may still be loading\n");
              }
              const snapshot = await doSnapshot(page, targetId);
              return { targetId, snapshot };
            });
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
    evaluate(targetId: string, expression: string) {
      return withPageConnection(targetId, async (page): Promise<EvalResult> => {
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
      });
    },
    screenshot(targetId: string) {
      return withPageConnection(targetId, async (page) => {
        const png = await page.screenshot();
        const artifactN = await nextArtifactCounter();
        return await deps.artifactStore.writeScreenshot(`shot${artifactN}`, png);
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
        return await withDialogHandling(page, async () => {
          await page.uploadFile(objectId, filePath);
          return await postAction(page, targetId, opts);
        });
      });
    },
    wait(targetId: string, request: WaitRequest, opts?: ActionOptions) {
      return withPageConnection(targetId, async (page): Promise<ActionResult> => {
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
        return await postAction(page, targetId, opts);
      });
    },
  };
}
