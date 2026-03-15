/** CDP connection: browser-level and page-level connections. */

import type { BrowserService } from "../domain/browser.ts";
import type { EvalResult } from "../domain/eval.ts";
import type { PageInfo } from "../domain/page.ts";

/** Page-level CDP connection — attached to a specific target. */
export interface CdpPageService extends BrowserService {
  close(): void;
  // deno-lint-ignore no-explicit-any
  getFullAXTree(): Promise<any>;
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
        targetId: t.targetId,
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

  // --- Network idle tracker ---
  // Track in-flight requests by requestId (Set) to handle redirects correctly:
  // redirects fire multiple requestWillBeSent for the same requestId but only
  // one terminal event (loadingFinished/loadingFailed).
  const inflightRequests = new Map<string, number>();
  const STALE_REQUEST_MS = 30_000;
  const IGNORED_REQUEST_TYPES = new Set(["WebSocket", "EventSource"]);
  // deno-lint-ignore no-explicit-any
  cdp.Network.addEventListener("requestWillBeSent", (e: any) => {
    if (e.sessionId === sessionId && !IGNORED_REQUEST_TYPES.has(e.params.type)) {
      inflightRequests.set(e.params.requestId, Date.now());
    }
  });
  // deno-lint-ignore no-explicit-any
  cdp.Network.addEventListener("loadingFinished", (e: any) => {
    if (e.sessionId === sessionId) inflightRequests.delete(e.params.requestId);
  });
  // deno-lint-ignore no-explicit-any
  cdp.Network.addEventListener("loadingFailed", (e: any) => {
    if (e.sessionId === sessionId) inflightRequests.delete(e.params.requestId);
  });

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

  /** Click element at the given RemoteObjectId using real pointer events. */
  async function clickElement(objectId: string): Promise<void> {
    // Ensure the element is visible in the viewport before computing coordinates
    await cdp.DOM.scrollIntoViewIfNeeded({ objectId }, sessionId);

    // Get the element's content quads (coordinates)
    const { quads } = await cdp.DOM.getContentQuads(
      { objectId },
      sessionId,
    );

    if (!quads || quads.length === 0) {
      throw new Error("element has no visible area — cannot click");
    }

    // Compute center of the first quad (array of 8 floats: x1,y1,x2,y2,x3,y3,x4,y4)
    const quad = quads[0];
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

    // Dispatch mouse events: move, press, release
    await cdp.Input.dispatchMouseEvent(
      { type: "mouseMoved", x, y },
      sessionId,
    );
    await cdp.Input.dispatchMouseEvent(
      { type: "mousePressed", x, y, button: "left", clickCount: 1 },
      sessionId,
    );
    await cdp.Input.dispatchMouseEvent(
      { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
      sessionId,
    );
  }

  /** Fill an input element: focus, clear, set value, dispatch input+change. */
  async function fillElement(objectId: string, value: string): Promise<void> {
    const result = await cdp.Runtime.callFunctionOn(
      {
        objectId,
        functionDeclaration: `function(newValue) {
          if (!('value' in this)) throw new Error('element is not a fillable input');
          this.focus();
          this.value = '';
          this.value = newValue;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        arguments: [{ value }],
        awaitPromise: false,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "fill failed";
      throw new Error(msg);
    }
  }

  /** Type text character by character: focus, then dispatch key events. */
  async function typeText(objectId: string, text: string): Promise<void> {
    await focusElement(objectId);

    // Type each character via key events
    for (const char of text) {
      await cdp.Input.dispatchKeyEvent(
        { type: "keyDown", key: char, text: char },
        sessionId,
      );
      await cdp.Input.dispatchKeyEvent(
        { type: "keyUp", key: char },
        sessionId,
      );
    }
  }

  /** Select a dropdown option: set value and dispatch input+change. */
  async function selectOption(objectId: string, value: string): Promise<void> {
    const result = await cdp.Runtime.callFunctionOn(
      {
        objectId,
        functionDeclaration: `function(val) {
          if (this.tagName !== 'SELECT') throw new Error('element is not a <select>');
          const option = Array.from(this.options).find(o => o.value === val);
          if (!option) throw new Error('no option with value ' + JSON.stringify(val));
          this.value = val;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        arguments: [{ value }],
        awaitPromise: false,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "select failed";
      throw new Error(msg);
    }
  }

  /** Submit the form containing the element (or the element itself if it's a form). */
  async function submitForm(objectId: string): Promise<void> {
    const result = await cdp.Runtime.callFunctionOn(
      {
        objectId,
        functionDeclaration: `function() {
          const form = this.tagName === 'FORM' ? this : this.closest('form');
          if (!form) throw new Error('no form found for this element');
          form.requestSubmit();
        }`,
        awaitPromise: false,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "submit failed";
      throw new Error(msg);
    }
  }

  /** Focus the element. */
  async function focusElement(objectId: string): Promise<void> {
    const result = await cdp.Runtime.callFunctionOn(
      {
        objectId,
        functionDeclaration: "function() { this.focus(); }",
        awaitPromise: false,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "focus failed";
      throw new Error(msg);
    }
  }

  /** Map logical key names to physical key codes for CDP Input.dispatchKeyEvent. */
  function keyToCode(k: string): string {
    const map: Record<string, string> = {
      Enter: "Enter",
      Tab: "Tab",
      Escape: "Escape",
      Space: "Space",
      Backspace: "Backspace",
      Delete: "Delete",
      ArrowUp: "ArrowUp",
      ArrowDown: "ArrowDown",
      ArrowLeft: "ArrowLeft",
      ArrowRight: "ArrowRight",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      Control: "ControlLeft",
      Shift: "ShiftLeft",
      Alt: "AltLeft",
      Meta: "MetaLeft",
    };
    if (map[k]) return map[k];
    if (k.length === 1) {
      const c = k.toLowerCase();
      if (c >= "a" && c <= "z") return `Key${c.toUpperCase()}`;
      if (c >= "0" && c <= "9") return `Digit${c}`;
    }
    return k;
  }

  /** Press a keyboard key (dispatched to the focused element). */
  async function pressKey(descriptor: string): Promise<void> {
    // Parse modifier prefixes (e.g., "Control+a", "Shift+Enter")
    // Use lastIndexOf to handle "+" as a key (e.g., "Shift++", "+")
    let modifiers: string[];
    let key: string;
    const lastPlus = descriptor.lastIndexOf("+");
    if (lastPlus === -1 || lastPlus === 0) {
      // No modifier separator, or descriptor is "+" itself
      modifiers = [];
      key = descriptor;
    } else if (lastPlus === descriptor.length - 1) {
      // Trailing "+": the key is "+", modifiers are everything before
      modifiers = descriptor.slice(0, lastPlus).split("+").filter((s) => s !== "");
      key = "+";
    } else {
      modifiers = descriptor.slice(0, lastPlus).split("+");
      key = descriptor.slice(lastPlus + 1);
    }

    // Map well-known key names to their text representation
    const textMap: Record<string, string> = {
      Enter: "\r",
      Space: " ",
      Tab: "\t",
    };
    const text = textMap[key];
    const code = keyToCode(key);

    // Press modifier keys
    for (const mod of modifiers) {
      await cdp.Input.dispatchKeyEvent(
        { type: "rawKeyDown", key: mod, code: keyToCode(mod) },
        sessionId,
      );
    }

    await cdp.Input.dispatchKeyEvent(
      { type: "rawKeyDown", key, code, ...(text ? { text } : {}) },
      sessionId,
    );
    if (text) {
      await cdp.Input.dispatchKeyEvent(
        { type: "char", key, code, text },
        sessionId,
      );
    }
    await cdp.Input.dispatchKeyEvent(
      { type: "keyUp", key, code },
      sessionId,
    );

    // Release modifier keys (reverse order)
    for (const mod of [...modifiers].reverse()) {
      await cdp.Input.dispatchKeyEvent(
        { type: "keyUp", key: mod, code: keyToCode(mod) },
        sessionId,
      );
    }
  }

  /** Upload a file to an input[type=file] element. */
  async function uploadFile(objectId: string, filePath: string): Promise<void> {
    // Verify it's a file input
    const checkResult = await cdp.Runtime.callFunctionOn(
      {
        objectId,
        functionDeclaration:
          "function() { return this.tagName === 'INPUT' && this.type === 'file'; }",
        returnByValue: true,
      },
      sessionId,
    );
    if (checkResult.exceptionDetails) {
      const msg = checkResult.exceptionDetails.exception?.description ??
        checkResult.exceptionDetails.text ?? "check failed";
      throw new Error(msg);
    }
    if (!checkResult.result.value) {
      throw new Error("element is not a file input");
    }

    // Get backendNodeId
    const desc = await cdp.DOM.describeNode({ objectId }, sessionId);
    const backendNodeId = desc.node.backendNodeId;

    // Set the file
    await cdp.DOM.setFileInputFiles(
      { files: [filePath], backendNodeId },
      sessionId,
    );
  }

  // --- Dialog handler ---
  let dialogHandler:
    | ((type: string, message: string, defaultPrompt: string) => void)
    | null = null;

  // deno-lint-ignore no-explicit-any
  cdp.Page.addEventListener("javascriptDialogOpening", (e: any) => {
    if (e.sessionId === sessionId && dialogHandler) {
      dialogHandler(
        e.params.type,
        e.params.message,
        e.params.defaultPrompt ?? "",
      );
    }
  });

  /** Single-listener design: only one handler at a time. */
  function onDialog(
    handler: (type: string, message: string, defaultPrompt: string) => void,
  ): () => void {
    if (dialogHandler) {
      throw new Error("dialog handler already registered — clean up the previous one first");
    }
    dialogHandler = handler;
    return () => {
      dialogHandler = null;
    };
  }

  async function handleDialog(
    accept: boolean,
    promptText?: string,
  ): Promise<void> {
    await cdp.Page.handleJavaScriptDialog(
      { accept, ...(promptText !== undefined ? { promptText } : {}) },
      sessionId,
    );
  }

  /** Wait for network idle: 0 in-flight requests for graceMs, up to timeoutMs. Returns true if timed out. */
  async function waitForNetworkIdle(
    graceMs = 500,
    timeoutMs = 5000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let idleSince = inflightRequests.size === 0 ? Date.now() : 0;

    while (Date.now() < deadline) {
      // Evict stale requests that never received a terminal event
      const now = Date.now();
      for (const [id, startTime] of inflightRequests) {
        if (now - startTime >= STALE_REQUEST_MS) inflightRequests.delete(id);
      }

      if (inflightRequests.size === 0) {
        if (idleSince === 0) idleSince = Date.now();
        if (Date.now() - idleSince >= graceMs) return false;
      } else {
        idleSince = 0;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // Timeout is not an error — action succeeded, page may still be loading
    return true;
  }

  /** Wait for an element matching selector to exist in the DOM. */
  async function waitForSelector(
    selector: string,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let delay = 100;

    while (Date.now() < deadline) {
      const result = await cdp.Runtime.evaluate(
        {
          expression: `document.querySelector(${JSON.stringify(selector)}) !== null`,
          returnByValue: true,
        },
        sessionId,
      );
      if (result.result.value === true) return;
      await new Promise((r) => setTimeout(r, Math.min(delay, deadline - Date.now())));
      delay = Math.min(delay * 2, 1000);
    }
    throw new Error(`timed out waiting for selector "${selector}" (${timeoutMs}ms)`);
  }

  /** Wait for text to appear on the page. */
  async function waitForText(
    text: string,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let delay = 100;

    while (Date.now() < deadline) {
      const result = await cdp.Runtime.evaluate(
        {
          expression: `(document.body?.innerText ?? '').includes(${JSON.stringify(text)})`,
          returnByValue: true,
        },
        sessionId,
      );
      if (result.result.value === true) return;
      await new Promise((r) => setTimeout(r, Math.min(delay, deadline - Date.now())));
      delay = Math.min(delay * 2, 1000);
    }
    throw new Error(`timed out waiting for text "${text}" (${timeoutMs}ms)`);
  }

  /** Wait for text within an element identified by objectId. */
  async function waitForTextInElement(
    objectId: string,
    text: string,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let delay = 100;

    while (Date.now() < deadline) {
      const result = await cdp.Runtime.callFunctionOn(
        {
          objectId,
          functionDeclaration: `function(searchText) {
            return (this.innerText ?? '').includes(searchText);
          }`,
          arguments: [{ value: text }],
          returnByValue: true,
        },
        sessionId,
      );
      if (result.result.value === true) return;
      await new Promise((r) => setTimeout(r, Math.min(delay, deadline - Date.now())));
      delay = Math.min(delay * 2, 1000);
    }
    throw new Error(`timed out waiting for text "${text}" in element (${timeoutMs}ms)`);
  }

  function close(): void {
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
    clickElement,
    fillElement,
    typeText,
    selectOption,
    submitForm,
    focusElement,
    pressKey,
    uploadFile,
    onDialog,
    handleDialog,
    waitForNetworkIdle,
    waitForSelector,
    waitForText,
    waitForTextInElement,
    close,
  };
}
