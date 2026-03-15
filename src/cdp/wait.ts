/** Hybrid DOM waits: MutationObserver for fast response + scaled polling fallback for state-only changes. */

/** Poll interval scales with timeout: caps at 100ms, scales down for short timeouts. */
export function pollInterval(timeoutMs: number): number {
  return Math.max(1, Math.min(100, Math.floor(timeoutMs / 5)));
}

// deno-lint-ignore no-explicit-any
export function createWaitMethods(cdp: any, sessionId: string) {
  /** Wait for an element matching selector to exist in the DOM. */
  async function waitForSelector(
    selector: string,
    timeoutMs = 5000,
  ): Promise<void> {
    const pollMs = pollInterval(timeoutMs);
    const result = await cdp.Runtime.evaluate(
      {
        expression: `new Promise((resolve, reject) => {
          const sel = ${JSON.stringify(selector)};
          const timeout = ${timeoutMs};
          const pollMs = ${pollMs};
          function check() { return document.querySelector(sel) !== null; }
          if (check()) { resolve(); return; }
          let settled = false;
          const observer = new MutationObserver(() => { if (check()) done(); });
          observer.observe(document.documentElement, {
            childList: true, subtree: true, attributes: true,
          });
          const poll = setInterval(() => { if (check()) done(); }, pollMs);
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('timed out waiting for selector "' + sel + '" (' + timeout + 'ms)'));
          }, timeout);
          function cleanup() { observer.disconnect(); clearInterval(poll); clearTimeout(timer); }
          function done() { if (settled) return; settled = true; cleanup(); resolve(); }
        })`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description
          ?.replace(/^Error:\s*/, "") ??
          result.exceptionDetails.text ??
          `timed out waiting for selector "${selector}"`,
      );
    }
  }

  /** Wait for text to appear on the page. */
  async function waitForText(
    text: string,
    timeoutMs = 5000,
  ): Promise<void> {
    const pollMs = pollInterval(timeoutMs);
    const result = await cdp.Runtime.evaluate(
      {
        expression: `new Promise((resolve, reject) => {
          const text = ${JSON.stringify(text)};
          const timeout = ${timeoutMs};
          const pollMs = ${pollMs};
          function check() { return (document.body?.innerText ?? '').includes(text); }
          if (check()) { resolve(); return; }
          let settled = false;
          const observer = new MutationObserver(() => { if (check()) done(); });
          observer.observe(document.documentElement, {
            childList: true, subtree: true, characterData: true, attributes: true,
          });
          const poll = setInterval(() => { if (check()) done(); }, pollMs);
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('timed out waiting for text "' + text + '" (' + timeout + 'ms)'));
          }, timeout);
          function cleanup() { observer.disconnect(); clearInterval(poll); clearTimeout(timer); }
          function done() { if (settled) return; settled = true; cleanup(); resolve(); }
        })`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description
          ?.replace(/^Error:\s*/, "") ??
          result.exceptionDetails.text ??
          `timed out waiting for text "${text}"`,
      );
    }
  }

  /** Wait for text within an element identified by objectId. */
  async function waitForTextInElement(
    objectId: string,
    text: string,
    timeoutMs = 5000,
  ): Promise<void> {
    const pollMs = pollInterval(timeoutMs);
    const result = await cdp.Runtime.callFunctionOn(
      {
        objectId,
        functionDeclaration: `function(searchText, timeout, pollMs) {
          const el = this;
          return new Promise((resolve, reject) => {
            function check() { return (el.innerText ?? '').includes(searchText); }
            if (check()) { resolve(); return; }
            let settled = false;
            const observer = new MutationObserver(() => { if (check()) done(); });
            observer.observe(document.documentElement, {
              childList: true, subtree: true, characterData: true, attributes: true,
            });
            const poll = setInterval(() => { if (check()) done(); }, pollMs);
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(new Error('timed out waiting for text "' + searchText + '" in element (' + timeout + 'ms)'));
            }, timeout);
            function cleanup() { observer.disconnect(); clearInterval(poll); clearTimeout(timer); }
            function done() { if (settled) return; settled = true; cleanup(); resolve(); }
          });
        }`,
        arguments: [{ value: text }, { value: timeoutMs }, { value: pollMs }],
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description
          ?.replace(/^Error:\s*/, "") ??
          result.exceptionDetails.text ??
          `timed out waiting for text "${text}" in element`,
      );
    }
  }

  return { waitForSelector, waitForText, waitForTextInElement };
}
