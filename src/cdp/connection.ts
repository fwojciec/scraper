/** CDP connection implementing BrowserService. */

import type { BrowserService } from "../domain/browser.ts";
import type { EvalRequest, EvalResult } from "../domain/eval.ts";
import type { NavigateRequest, PageInfo } from "../domain/page.ts";

interface ManagedPage {
  name: string;
  targetId: string;
  sessionId: string;
  url: string;
}

export interface CdpBrowserService extends BrowserService {
  close(): void;
}

// simple-cdp's JSR .d.ts incorrectly uses `export type` for value exports.
// Work around with a dynamic import that gives us an untyped module.
// deno-lint-ignore no-explicit-any
let _cdpMod: any;
// deno-lint-ignore no-explicit-any
async function loadCdp(): Promise<any> {
  if (!_cdpMod) _cdpMod = await import("@simple-cdp/simple-cdp");
  return _cdpMod;
}

/** Discover the WebSocket debugger URL from Chrome's /json/version endpoint. */
async function discoverWsUrl(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Chrome /json/version returned ${res.status}`);
  }
  const info = await res.json();
  return info.webSocketDebuggerUrl;
}

/** Create a CDP connection to Chrome on the given port and return a BrowserService. */
export async function createCdpConnection(port: number): Promise<CdpBrowserService> {
  const wsUrl = await discoverWsUrl(port);
  const { CDP } = await loadCdp();
  const cdp = new CDP({ webSocketDebuggerUrl: wsUrl });

  // Enable Target domain
  await cdp.Target.setDiscoverTargets({ discover: true });

  const pages = new Map<string, ManagedPage>();

  function getPage(name: string): ManagedPage {
    const page = pages.get(name);
    if (!page) throw new Error(`No page named "${name}"`);
    return page;
  }

  async function navigate(req: NavigateRequest): Promise<PageInfo> {
    const name = req.name ?? "default";
    const existing = pages.get(name);

    if (existing) {
      await cdp.Page.navigate({ url: req.url }, existing.sessionId);
      if (req.url !== "about:blank") {
        await cdp.Page.loadEventFired(null, existing.sessionId);
      }
      existing.url = req.url;
      return { name, url: req.url, targetId: existing.targetId };
    }

    // Create new target
    const { targetId } = await cdp.Target.createTarget({ url: req.url });

    // Attach to target to get a session
    const { sessionId } = await cdp.Target.attachToTarget({
      targetId,
      flatten: true,
    });

    // Enable domains on the session
    await cdp.Page.enable(null, sessionId);
    await cdp.Runtime.enable(null, sessionId);

    // Wait for page to load
    if (req.url !== "about:blank") {
      await cdp.Page.loadEventFired(null, sessionId);
    }

    const page: ManagedPage = { name, targetId, sessionId, url: req.url };
    pages.set(name, page);

    return { name, url: req.url, targetId };
  }

  async function evaluate(req: EvalRequest): Promise<EvalResult> {
    const name = req.name ?? "default";
    const page = getPage(name);

    const response = await cdp.Runtime.evaluate(
      {
        expression: req.expression,
        returnByValue: true,
        awaitPromise: true,
      },
      page.sessionId,
    );

    if (response.exceptionDetails) {
      const msg = response.exceptionDetails.text ??
        response.exceptionDetails.exception?.description ??
        "Evaluation failed";
      throw new Error(msg);
    }

    return { result: response.result.value };
  }

  async function screenshot(name: string, fullPage?: boolean): Promise<string> {
    const page = getPage(name);

    let clip:
      | { x: number; y: number; width: number; height: number; scale: number }
      | undefined;
    if (fullPage) {
      const metrics = await cdp.Page.getLayoutMetrics(null, page.sessionId);
      clip = {
        x: 0,
        y: 0,
        width: metrics.contentSize.width,
        height: metrics.contentSize.height,
        scale: 1,
      };
    }

    const { data } = await cdp.Page.captureScreenshot(
      { format: "png", ...(clip ? { clip } : {}) },
      page.sessionId,
    );

    const path = await Deno.makeTempFile({ suffix: ".png" });
    await Deno.writeFile(path, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    return path;
  }

  function listPages(): Promise<PageInfo[]> {
    const result = [...pages.values()].map((p) => ({
      name: p.name,
      url: p.url,
      targetId: p.targetId,
    }));
    return Promise.resolve(result);
  }

  async function closePage(name: string): Promise<void> {
    const page = getPage(name);
    await cdp.Target.closeTarget({ targetId: page.targetId });
    pages.delete(name);
  }

  function close(): void {
    try {
      cdp.connection?.close();
    } catch {
      // Connection already closed
    }
  }

  return { navigate, evaluate, screenshot, listPages, closePage, close };
}
