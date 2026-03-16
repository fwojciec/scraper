/** CDP connection: browser-level and page-level connections. */

import type { AccessibilityNode } from "../domain/accessibility.ts";
import type { EvalResult } from "../domain/eval.ts";
import type { PageInfo } from "../domain/page.ts";
import { translateAXNodes } from "./accessibility.ts";
import { createDialogHandler } from "./dialog.ts";
import { createInputMethods } from "./input.ts";
import { createNetworkTracker } from "./network.ts";
import { createWaitMethods } from "./wait.ts";

/** Page-level CDP connection — attached to a specific target. */
export interface CdpPageService {
  navigate(url: string): Promise<void>;
  evaluate(expression: string): Promise<EvalResult>;
  screenshot(fullPage?: boolean): Promise<string>;
  close(): void;
  getFullAXTree(): Promise<AccessibilityNode[]>;
  resolveSelector(selector: string): Promise<number>;
  /** Resolve a backendNodeId to a RemoteObjectId. Throws if stale. */
  resolveRef(backendNodeId: number, refName: string): Promise<string>;
  /** Resolve CSS selector to a RemoteObjectId. Error on 0 or >1 matches. */
  resolveUniqueSelector(selector: string): Promise<string>;
  /** Click element at the given RemoteObjectId using real pointer events. */
  clickElement(objectId: string): Promise<void>;
  /** Fill an input element: focus, clear, set value, dispatch input+change. */
  fillElement(objectId: string, value: string): Promise<void>;
  /** Type text character by character: focus, then dispatch key events. */
  typeText(objectId: string, text: string): Promise<void>;
  /** Select a dropdown option: set value and dispatch input+change. */
  selectOption(objectId: string, value: string): Promise<void>;
  /** Submit the form containing the element (or the element itself if it's a form). */
  submitForm(objectId: string): Promise<void>;
  /** Focus the element. */
  focusElement(objectId: string): Promise<void>;
  /** Press a keyboard key (dispatched to the focused element). */
  pressKey(key: string): Promise<void>;
  /** Upload a file to an input[type=file] element. */
  uploadFile(objectId: string, filePath: string): Promise<void>;
  /** Register handler for dialog events. Returns cleanup function. */
  onDialog(
    handler: (type: string, message: string, defaultPrompt: string) => void,
  ): () => void;
  /** Handle a JavaScript dialog (accept/dismiss). */
  handleDialog(accept: boolean, promptText?: string): Promise<void>;
  /** Wait for network idle: 0 in-flight requests for graceMs, up to timeoutMs. Returns true if timed out. */
  waitForNetworkIdle(graceMs?: number, timeoutMs?: number): Promise<boolean>;
  /** Wait for an element matching selector to exist in the DOM. */
  waitForSelector(selector: string, timeoutMs?: number): Promise<void>;
  /** Wait for text to appear on the page. */
  waitForText(text: string, timeoutMs?: number): Promise<void>;
  /** Wait for text within an element identified by objectId. */
  waitForTextInElement(objectId: string, text: string, timeoutMs?: number): Promise<void>;
}

/** Browser-level CDP connection — not attached to any target. */
export interface CdpBrowserService {
  listPages(activeTargetId?: string): Promise<PageInfo[]>;
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
export async function discoverWsUrl(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Chrome /json/version returned ${res.status}`);
  }
  const info = await res.json();
  return info.webSocketDebuggerUrl;
}

/** Build a browser-level WebSocket URL. */
export function buildBrowserWsUrl(port: number, wsPath: string): string {
  return `ws://127.0.0.1:${port}${wsPath}`;
}

/**
 * Create a browser-level CDP connection (no target attached).
 * Used for page management: listing pages, switching targets.
 */
export async function createBrowserConnection(
  wsUrl: string,
): Promise<CdpBrowserService> {
  const { CDP } = await loadCdp();
  const cdp = new CDP({ webSocketDebuggerUrl: wsUrl });

  async function listPages(activeTargetId?: string): Promise<PageInfo[]> {
    const { targetInfos } = await cdp.Target.getTargets();
    return targetInfos
      // deno-lint-ignore no-explicit-any
      .filter((t: any) => t.type === "page")
      // deno-lint-ignore no-explicit-any
      .map((t: any) => ({
        pageId: t.targetId,
        url: t.url,
        title: t.title,
        active: t.targetId === activeTargetId,
      }));
  }

  function close(): void {
    try {
      cdp.connection?.close();
    } catch {
      // Connection already closed
    }
  }

  return { listPages, close };
}

/** Create a page-level CDP connection, attaching to a specific target. */
export async function createPageConnection(
  wsUrl: string,
  targetId: string,
): Promise<CdpPageService> {
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
    throw new Error("target no longer exists — run 'scraper pages' to pick a new tab");
  }

  await cdp.Page.enable(null, sessionId);
  await cdp.Runtime.enable(null, sessionId);
  await cdp.Accessibility.enable(null, sessionId);
  await cdp.DOM.enable(null, sessionId);
  await cdp.Network.enable(null, sessionId);

  const network = createNetworkTracker(cdp, sessionId);

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

  async function getFullAXTree(): Promise<AccessibilityNode[]> {
    const response = await cdp.Accessibility.getFullAXTree(null, sessionId);
    return translateAXNodes(response.nodes);
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

  /** Resolve a backendNodeId to a RemoteObjectId. Throws if stale. */
  async function resolveRef(backendNodeId: number, refName: string): Promise<string> {
    try {
      const result = await cdp.DOM.resolveNode(
        { backendNodeId },
        sessionId,
      );
      return result.object.objectId;
    } catch {
      throw new Error(
        `ref ${refName} is stale — the element no longer exists. Run 'scraper snapshot' to get fresh refs`,
      );
    }
  }

  /** Resolve CSS selector to a RemoteObjectId. Error on 0 or >1 matches. */
  async function resolveUniqueSelector(selector: string): Promise<string> {
    const sel = JSON.stringify(selector);
    // Single evaluate to atomically count and return the element (avoids TOCTOU race)
    const evalResult = await cdp.Runtime.evaluate(
      {
        expression: `(() => {
          const sel = ${sel};
          const els = document.querySelectorAll(sel);
          if (els.length === 0) throw new Error("no_match");
          if (els.length > 1) throw new Error("multiple:" + els.length);
          return els[0];
        })()`,
        returnByValue: false,
      },
      sessionId,
    );

    if (evalResult.exceptionDetails) {
      const desc = evalResult.exceptionDetails.exception?.description ??
        evalResult.exceptionDetails.text ?? "";
      if (desc.includes("no_match")) {
        throw new Error(`selector "${selector}" did not match any element`);
      }
      if (desc.includes("multiple:")) {
        const count = desc.split("multiple:")[1];
        throw new Error(
          `selector "${selector}" matched ${count} elements, expected exactly 1`,
        );
      }
      throw new Error(desc || "querySelectorAll failed");
    }

    return evalResult.result.objectId;
  }

  const input = createInputMethods(cdp, sessionId);
  const dialog = createDialogHandler(cdp, sessionId);
  const waits = createWaitMethods(cdp, sessionId);

  function close(): void {
    network.cleanup();
    dialog.cleanup();
    try {
      cdp.connection?.close();
    } catch {
      // Connection already closed
    }
  }

  return {
    navigate,
    evaluate,
    screenshot,
    getFullAXTree,
    resolveSelector,
    resolveRef,
    resolveUniqueSelector,
    clickElement: input.clickElement,
    fillElement: input.fillElement,
    typeText: input.typeText,
    selectOption: input.selectOption,
    submitForm: input.submitForm,
    focusElement: input.focusElement,
    pressKey: input.pressKey,
    uploadFile: input.uploadFile,
    onDialog: dialog.onDialog,
    handleDialog: dialog.handleDialog,
    waitForNetworkIdle: network.waitForNetworkIdle,
    waitForSelector: waits.waitForSelector,
    waitForText: waits.waitForText,
    waitForTextInElement: waits.waitForTextInElement,
    close,
  };
}
