/** CDP connection implementing BrowserService for a single target. */

import type { BrowserService } from "../domain/browser.ts";
import type { EvalResult } from "../domain/eval.ts";

export interface CdpBrowserService extends BrowserService {
  close(): void;
  // deno-lint-ignore no-explicit-any
  getFullAXTree(): Promise<any>;
  resolveSelector(selector: string): Promise<number>;
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

/** Create a CDP connection to Chrome on the given port, attaching to a specific target. */
export async function createCdpConnection(
  port: number,
  targetId: string,
): Promise<CdpBrowserService> {
  const wsUrl = await discoverWsUrl(port);
  const { CDP } = await loadCdp();
  const cdp = new CDP({ webSocketDebuggerUrl: wsUrl });

  let sessionId: string;
  try {
    const result = await cdp.Target.attachToTarget({
      targetId,
      flatten: true,
    });
    sessionId = result.sessionId;
  } catch {
    try {
      cdp.connection?.close();
    } catch { /* ignore */ }
    throw new Error("target no longer exists — run 'scraper stop' then 'scraper start'");
  }

  await cdp.Page.enable(null, sessionId);
  await cdp.Runtime.enable(null, sessionId);
  await cdp.Accessibility.enable(null, sessionId);
  await cdp.DOM.enable(null, sessionId);

  // deno-lint-ignore no-explicit-any
  async function waitForLoad(cdpClient: any, sid: string): Promise<void> {
    await cdpClient.Runtime.evaluate(
      {
        expression: `new Promise(r => {
          if (document.readyState === "complete") r();
          else window.addEventListener("load", () => r(), { once: true });
        })`,
        awaitPromise: true,
        returnByValue: true,
      },
      sid,
    );
  }

  async function navigate(url: string): Promise<void> {
    await cdp.Page.navigate({ url }, sessionId);
    if (url !== "about:blank") {
      await waitForLoad(cdp, sessionId);
    }
  }

  async function evaluate(expression: string): Promise<EvalResult> {
    const response = await cdp.Runtime.evaluate(
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
    );

    if (response.exceptionDetails) {
      const msg = response.exceptionDetails.text ??
        response.exceptionDetails.exception?.description ??
        "Evaluation failed";
      throw new Error(msg);
    }

    return { result: response.result.value };
  }

  async function screenshot(fullPage?: boolean): Promise<string> {
    let clip:
      | { x: number; y: number; width: number; height: number; scale: number }
      | undefined;
    if (fullPage) {
      const metrics = await cdp.Page.getLayoutMetrics(null, sessionId);
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
      sessionId,
    );

    const path = await Deno.makeTempFile({ suffix: ".png" });
    await Deno.writeFile(path, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    return path;
  }

  // deno-lint-ignore no-explicit-any
  async function getFullAXTree(): Promise<any> {
    const response = await cdp.Accessibility.getFullAXTree(null, sessionId);
    return response.nodes;
  }

  async function resolveSelector(selector: string): Promise<number> {
    const evalResult = await cdp.Runtime.evaluate(
      {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        returnByValue: false,
      },
      sessionId,
    );

    if (evalResult.exceptionDetails) {
      const msg = evalResult.exceptionDetails.text ??
        evalResult.exceptionDetails.exception?.description ??
        "querySelector failed";
      throw new Error(msg);
    }

    if (
      !evalResult.result.objectId ||
      evalResult.result.subtype === "null"
    ) {
      throw new Error(
        `selector "${selector}" did not match any element`,
      );
    }

    const desc = await cdp.DOM.describeNode(
      { objectId: evalResult.result.objectId },
      sessionId,
    );

    return desc.node.backendNodeId;
  }

  function close(): void {
    try {
      cdp.connection?.close();
    } catch {
      // Connection already closed
    }
  }

  return { navigate, evaluate, screenshot, getFullAXTree, resolveSelector, close };
}
