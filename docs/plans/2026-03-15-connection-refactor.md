# Connection Refactor: Split CdpPageService, Event-Driven Waits, DI Cleanup

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task.

**Goal:** Decompose the 770-line `createPageConnection` into focused modules, replace polling waits
with event-driven approaches, thread stderr through DI, and clean up event listeners on close.

**Architecture:** Extract `createPageConnection` into four modules (`network.ts`, `input.ts`,
`wait.ts`, `dialog.ts`) that each export a factory taking `cdp: any` + `sessionId: string`.
Connection.ts becomes the assembler. Network idle uses event callbacks + periodic stale eviction
timer (interval derived from stale threshold: `min(staleMs/2, 5s)`) instead of 50ms polling. DOM
waits use a hybrid approach: in-page `MutationObserver` for fast response + scaled polling fallback
(`min(100, timeout/5)` ms) for state-only changes (`MutationObserver` misses `:checked`, `:focus`,
ancestor visibility). `waitForTextInElement` observes `document.documentElement` (not just the
target element) to catch ancestor visibility changes. `CdpPageService` interface stays in
`connection.ts` — it's consumed in only 2 places.

**Execution order:** Pure extractions first (Tasks 1-3: input, dialog, stderr — behavior-preserving,
safe to land). Then behavioral changes with dedicated tests (Tasks 4-5: event-driven network,
MutationObserver waits). Finally, verification (Task 6).

**Tech Stack:** Deno, TypeScript, CDP via `@simple-cdp/simple-cdp` (has `removeEventListener`),
`@std/assert` for tests.

---

### Task 1: Extract input actions to `src/cdp/input.ts`

Move all element interaction methods out of `createPageConnection`. Pure extraction — no behavior
changes.

**Files:**

- Create: `src/cdp/input.ts`
- Modify: `src/cdp/connection.ts` (remove input functions, import from input.ts)

**Step 1: Extract input methods**

Create `src/cdp/input.ts` by moving these functions from `connection.ts`:

- `focusElement` (must be defined before typeText — typeText calls it)
- `clickElement`
- `fillElement`
- `typeText`
- `selectOption`
- `submitForm`
- `keyToCode` (private helper)
- `pressKey`
- `uploadFile`

```typescript
/** CDP input actions: click, fill, type, select, submit, focus, pressKey, upload. */

// deno-lint-ignore no-explicit-any
export function createInputMethods(cdp: any, sessionId: string) {
  // ... all input functions moved here, unchanged ...
  // focusElement must be defined before typeText (typeText calls it)

  return {
    clickElement,
    fillElement,
    typeText,
    selectOption,
    submitForm,
    focusElement,
    pressKey,
    uploadFile,
  };
}
```

The function bodies are identical to what's currently in `connection.ts`. No behavior changes.

**Step 2: Wire into createPageConnection**

In `src/cdp/connection.ts`:

1. Add import: `import { createInputMethods } from "./input.ts";`
2. Remove all the input function definitions from `createPageConnection`.
3. After enabling CDP domains, add:
   ```typescript
   const input = createInputMethods(cdp, sessionId);
   ```
4. In the returned object, list the input methods:
   ```typescript
   clickElement: input.clickElement,
   fillElement: input.fillElement,
   typeText: input.typeText,
   selectOption: input.selectOption,
   submitForm: input.submitForm,
   focusElement: input.focusElement,
   pressKey: input.pressKey,
   uploadFile: input.uploadFile,
   ```

No new unit tests — pure extraction with no behavior change. Existing 204 tests cover all input
methods thoroughly.

**Step 3: Run full CI**

Run: `deno task ci` Expected: All 204 tests pass.

**Step 4: Commit**

```bash
git add src/cdp/input.ts src/cdp/connection.ts
git commit -m "refactor: extract input actions to cdp/input.ts"
```

---

### Task 2: Extract dialog handler to `src/cdp/dialog.ts`

Move dialog handling out of `createPageConnection`. Pure extraction — adds `removeEventListener` on
cleanup but no behavior changes.

**Files:**

- Create: `src/cdp/dialog.ts`
- Modify: `src/cdp/connection.ts` (remove dialog code, import from dialog.ts)

**Step 1: Extract dialog module**

Create `src/cdp/dialog.ts`:

```typescript
/** CDP dialog handler: registers for Page.javascriptDialogOpening events. */

export interface DialogHandler {
  onDialog(
    handler: (type: string, message: string, defaultPrompt: string) => void,
  ): () => void;
  handleDialog(accept: boolean, promptText?: string): Promise<void>;
  cleanup(): void;
}

// deno-lint-ignore no-explicit-any
export function createDialogHandler(cdp: any, sessionId: string): DialogHandler {
  let dialogHandler:
    | ((type: string, message: string, defaultPrompt: string) => void)
    | null = null;

  // deno-lint-ignore no-explicit-any
  const listener = (e: any) => {
    if (e.sessionId === sessionId && dialogHandler) {
      dialogHandler(
        e.params.type,
        e.params.message,
        e.params.defaultPrompt ?? "",
      );
    }
  };

  cdp.Page.addEventListener("javascriptDialogOpening", listener);

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

  async function handleDialog(accept: boolean, promptText?: string): Promise<void> {
    await cdp.Page.handleJavaScriptDialog(
      { accept, ...(promptText !== undefined ? { promptText } : {}) },
      sessionId,
    );
  }

  function cleanup() {
    cdp.Page.removeEventListener("javascriptDialogOpening", listener);
    dialogHandler = null;
  }

  return { onDialog, handleDialog, cleanup };
}
```

**Step 2: Wire into createPageConnection**

In `src/cdp/connection.ts`:

1. Add import: `import { createDialogHandler } from "./dialog.ts";`
2. Remove the dialog handler block (`dialogHandler` variable, `addEventListener` call, `onDialog`,
   `handleDialog`).
3. After enabling CDP domains, add:
   ```typescript
   const dialog = createDialogHandler(cdp, sessionId);
   ```
4. In `close()`, add `dialog.cleanup();` before closing the connection.
5. In the returned object:
   ```typescript
   onDialog: dialog.onDialog,
   handleDialog: dialog.handleDialog,
   ```

**Step 3: Run full CI**

Run: `deno task ci` Expected: All 204 tests pass.

**Step 4: Commit**

```bash
git add src/cdp/dialog.ts src/cdp/connection.ts
git commit -m "refactor: extract dialog handler to cdp/dialog.ts"
```

---

### Task 3: Thread stderr through postAction

Currently `postAction` and navigate-without-snapshot use `console.error` for timeout warnings,
bypassing the injected `deps.stderr`. Fix by passing a `warn` callback. Small behavioral change —
warnings go through DI instead of console.

**Files:**

- Modify: `src/main.ts:476-491` (postAction)
- Modify: `src/main.ts:568-583` (navigate dep)

**Step 1: Modify postAction to accept a warn callback**

In `src/main.ts`, change `postAction` signature:

```typescript
async function postAction(
  page: CdpPageService,
  opts?: ActionOptions,
  warn?: (msg: string) => void,
): Promise<ActionResult> {
  const timedOut = await page.waitForNetworkIdle();
  if (opts?.includeSnapshot) {
    if (timedOut && warn) {
      warn("warning: network idle timed out — snapshot may reflect incomplete page state\n");
    }
    const snapshot = await doSnapshot(page);
    return { snapshot };
  }
  return {};
}
```

**Step 2: Update all call sites to pass `deps.stderr`**

In `executeAction`:

```typescript
function executeAction(
  page: CdpPageService,
  action: () => Promise<void>,
  opts?: ActionOptions,
): Promise<ActionResult> {
  return withDialogHandling(page, opts?.onDialog, async () => {
    await action();
    return await postAction(page, opts, deps.stderr);
  });
}
```

In `navigate` dep:

```typescript
navigate(url: string, opts?: ActionOptions) {
  return withPageConnection(async (page) => {
    return await withDialogHandling(page, opts?.onDialog, async () => {
      await page.navigate(url);
      if (opts?.includeSnapshot) {
        return await postAction(page, opts, deps.stderr);
      }
      const timedOut = await page.waitForNetworkIdle();
      if (timedOut) {
        deps.stderr("warning: network idle timed out after navigation\n");
      }
      await refsStore.remove();
      return {};
    });
  });
},
```

**Step 3: Run tests and verify no console.error remains**

Run: `deno task ci` Expected: All 204 tests pass.

Run: `grep -n 'console.error' src/main.ts` Expected: No output.

**Step 4: Commit**

```bash
git add src/main.ts
git commit -m "refactor: thread stderr through postAction, remove console.error"
```

---

### Task 4: Extract event-driven network tracker to `src/cdp/network.ts`

Move network idle tracking out of `createPageConnection`. Replace 50ms polling with event-driven
callbacks. **Behavioral change** — needs dedicated unit tests.

Key design decision: a periodic `setInterval` timer evicts stale requests even when no further
network events arrive. Without this, a request that starts and never gets a terminal event
(loadingFinished/loadingFailed) would never age out.

**Files:**

- Create: `src/cdp/network.ts`
- Create: `src/cdp/network.test.ts`
- Modify: `src/cdp/connection.ts` (remove network code, import from network.ts)

**Step 0: Add `@std/testing` dependency**

In `deno.json`, add to imports:

```json
"@std/testing": "jsr:@std/testing@^1"
```

**Step 1: Write the unit tests for NetworkTracker**

All timer-dependent tests use `FakeTime` — no real time passes, no flakiness. Events are emitted
synchronously; `time.tickAsync()` advances the clock to fire internal timers (grace period,
deadline, stale eviction).

Create `src/cdp/network.test.ts`:

```typescript
import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { createNetworkTracker } from "./network.ts";

/** Minimal mock CDP with event listener support. */
function mockCdp() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const network = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
  };

  function emit(type: string, params: Record<string, unknown>, sessionId: string) {
    for (const fn of listeners.get(type) ?? []) {
      fn({ sessionId, params });
    }
  }

  return { Network: network, emit, listeners };
}

const SID = "session-1";

Deno.test("network idle resolves immediately when no requests", async () => {
  using time = new FakeTime();
  const cdp = mockCdp();
  const tracker = createNetworkTracker(cdp, SID);
  const promise = tracker.waitForNetworkIdle(50, 1000);
  await time.tickAsync(51);
  assertEquals(await promise, false);
  tracker.cleanup();
});

Deno.test("network idle waits for in-flight request to finish", async () => {
  using time = new FakeTime();
  const cdp = mockCdp();
  const tracker = createNetworkTracker(cdp, SID);

  cdp.emit("requestWillBeSent", { requestId: "r1", type: "Document" }, SID);
  const promise = tracker.waitForNetworkIdle(100, 2000);

  // Finish the request — grace period starts
  cdp.emit("loadingFinished", { requestId: "r1" }, SID);
  await time.tickAsync(101);

  assertEquals(await promise, false);
  tracker.cleanup();
});

Deno.test("network idle returns true on timeout", async () => {
  using time = new FakeTime();
  const cdp = mockCdp();
  const tracker = createNetworkTracker(cdp, SID);

  cdp.emit("requestWillBeSent", { requestId: "r1", type: "Document" }, SID);
  const promise = tracker.waitForNetworkIdle(50, 200);

  await time.tickAsync(201);
  assertEquals(await promise, true);
  tracker.cleanup();
});

Deno.test("network idle ignores WebSocket and EventSource requests", async () => {
  using time = new FakeTime();
  const cdp = mockCdp();
  const tracker = createNetworkTracker(cdp, SID);

  cdp.emit("requestWillBeSent", { requestId: "ws1", type: "WebSocket" }, SID);
  cdp.emit("requestWillBeSent", { requestId: "es1", type: "EventSource" }, SID);

  const promise = tracker.waitForNetworkIdle(50, 1000);
  await time.tickAsync(51);
  assertEquals(await promise, false);
  tracker.cleanup();
});

Deno.test("network idle ignores events from other sessions", async () => {
  using time = new FakeTime();
  const cdp = mockCdp();
  const tracker = createNetworkTracker(cdp, SID);

  cdp.emit("requestWillBeSent", { requestId: "r1", type: "Document" }, "other-session");

  const promise = tracker.waitForNetworkIdle(50, 1000);
  await time.tickAsync(51);
  assertEquals(await promise, false);
  tracker.cleanup();
});

Deno.test("network idle grace period resets on new request", async () => {
  using time = new FakeTime();
  const cdp = mockCdp();
  const tracker = createNetworkTracker(cdp, SID);

  // Start and finish first request — grace starts
  cdp.emit("requestWillBeSent", { requestId: "r1", type: "Document" }, SID);
  cdp.emit("loadingFinished", { requestId: "r1" }, SID);

  const promise = tracker.waitForNetworkIdle(100, 2000);

  // Midway through grace, new request arrives — resets grace
  await time.tickAsync(30);
  cdp.emit("requestWillBeSent", { requestId: "r2", type: "Document" }, SID);

  // Finish second request — grace restarts
  await time.tickAsync(30);
  cdp.emit("loadingFinished", { requestId: "r2" }, SID);

  // Full grace period from second finish
  await time.tickAsync(101);
  assertEquals(await promise, false);
  tracker.cleanup();
});

Deno.test("network idle evicts stale requests without further events", async () => {
  using time = new FakeTime();
  const cdp = mockCdp();
  const tracker = createNetworkTracker(cdp, SID, { staleRequestMs: 100 });

  cdp.emit("requestWillBeSent", { requestId: "r1", type: "Document" }, SID);
  const promise = tracker.waitForNetworkIdle(50, 2000);

  // Advance past stale threshold — eviction timer fires, evicts r1, grace starts
  await time.tickAsync(101);
  // Advance past grace period
  await time.tickAsync(51);

  assertEquals(await promise, false);
  tracker.cleanup();
});

Deno.test("cleanup removes event listeners", () => {
  const cdp = mockCdp();
  const tracker = createNetworkTracker(cdp, SID);

  const totalBefore = [...cdp.listeners.values()].reduce((n, s) => n + s.size, 0);
  assertEquals(totalBefore > 0, true);

  tracker.cleanup();

  const totalAfter = [...cdp.listeners.values()].reduce((n, s) => n + s.size, 0);
  assertEquals(totalAfter, 0);
});

Deno.test("cleanup clears stale eviction timer", () => {
  const cleared = new Set<number>();
  const origClearInterval = globalThis.clearInterval;
  globalThis.clearInterval = (id: number) => {
    cleared.add(id);
    origClearInterval(id);
  };

  try {
    const cdp = mockCdp();
    const tracker = createNetworkTracker(cdp, SID, { staleRequestMs: 100 });

    // Capture the timer ID created by setInterval inside the tracker
    // (it's the only interval created, so cleared set starts empty)
    assertEquals(cleared.size, 0);

    tracker.cleanup();

    // cleanup() must have called clearInterval — exactly one timer cleared
    assertEquals(cleared.size, 1);
  } finally {
    globalThis.clearInterval = origClearInterval;
  }
});
```

**Step 2: Run tests to verify they fail**

Run: `deno test --allow-read --allow-write --allow-env src/cdp/network.test.ts` Expected: FAIL —
module `./network.ts` not found.

**Step 3: Implement the event-driven network tracker**

Create `src/cdp/network.ts`:

```typescript
/** Event-driven network idle tracker using CDP Network domain events. */

const DEFAULT_STALE_REQUEST_MS = 30_000;
const MAX_STALE_CHECK_INTERVAL_MS = 5_000;
const IGNORED_REQUEST_TYPES = new Set(["WebSocket", "EventSource"]);

export interface NetworkTracker {
  /** Wait for network idle: 0 in-flight requests for graceMs. Returns true if timed out. */
  waitForNetworkIdle(graceMs?: number, timeoutMs?: number): Promise<boolean>;
  /** Remove all CDP event listeners and timers. Call on connection close. */
  cleanup(): void;
}

export interface NetworkTrackerOptions {
  /** Override stale request threshold (default 30s). Useful for testing. */
  staleRequestMs?: number;
}

// deno-lint-ignore no-explicit-any
export function createNetworkTracker(
  cdp: any,
  sessionId: string,
  options?: NetworkTrackerOptions,
): NetworkTracker {
  const staleMs = options?.staleRequestMs ?? DEFAULT_STALE_REQUEST_MS;
  const staleCheckMs = Math.min(Math.ceil(staleMs / 2), MAX_STALE_CHECK_INTERVAL_MS);
  const inflight = new Map<string, number>();
  const changeCallbacks = new Set<() => void>();

  function notifyChange() {
    for (const cb of changeCallbacks) cb();
  }

  function evictStale() {
    const now = Date.now();
    let evicted = false;
    for (const [id, startTime] of inflight) {
      if (now - startTime >= staleMs) {
        inflight.delete(id);
        evicted = true;
      }
    }
    if (evicted) notifyChange();
  }

  // Periodic stale-request eviction: ensures requests that never receive a
  // terminal event (loadingFinished/loadingFailed) are eventually cleaned up,
  // even when no further network events arrive to trigger onChange.
  const staleTimer = setInterval(evictStale, staleCheckMs);

  // deno-lint-ignore no-explicit-any
  const onRequest = (e: any) => {
    if (e.sessionId === sessionId && !IGNORED_REQUEST_TYPES.has(e.params.type)) {
      inflight.set(e.params.requestId, Date.now());
      notifyChange();
    }
  };
  // deno-lint-ignore no-explicit-any
  const onFinished = (e: any) => {
    if (e.sessionId === sessionId) {
      inflight.delete(e.params.requestId);
      notifyChange();
    }
  };
  // deno-lint-ignore no-explicit-any
  const onFailed = (e: any) => {
    if (e.sessionId === sessionId) {
      inflight.delete(e.params.requestId);
      notifyChange();
    }
  };

  cdp.Network.addEventListener("requestWillBeSent", onRequest);
  cdp.Network.addEventListener("loadingFinished", onFinished);
  cdp.Network.addEventListener("loadingFailed", onFailed);

  function waitForNetworkIdle(graceMs = 500, timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      let graceTimer: number | undefined;

      const deadlineTimer = setTimeout(() => {
        done(true);
      }, timeoutMs);

      function done(timedOut: boolean) {
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        clearTimeout(deadlineTimer);
        changeCallbacks.delete(onChange);
        resolve(timedOut);
      }

      function startGrace() {
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        graceTimer = setTimeout(() => done(false), graceMs);
      }

      function onChange() {
        if (inflight.size === 0) {
          startGrace();
        } else {
          // New request arrived — cancel grace period
          if (graceTimer !== undefined) {
            clearTimeout(graceTimer);
            graceTimer = undefined;
          }
        }
      }

      changeCallbacks.add(onChange);

      // Check immediately — may already be idle
      evictStale();
      if (inflight.size === 0) {
        startGrace();
      }
    });
  }

  function cleanup() {
    clearInterval(staleTimer);
    cdp.Network.removeEventListener("requestWillBeSent", onRequest);
    cdp.Network.removeEventListener("loadingFinished", onFinished);
    cdp.Network.removeEventListener("loadingFailed", onFailed);
    changeCallbacks.clear();
  }

  return { waitForNetworkIdle, cleanup };
}
```

**Step 4: Run tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-env src/cdp/network.test.ts` Expected: All 9
tests pass.

**Step 5: Wire into createPageConnection**

In `src/cdp/connection.ts`:

1. Add import: `import { createNetworkTracker } from "./network.ts";`
2. Remove the entire network idle tracker block (lines ~144-164: `inflightRequests`,
   `STALE_REQUEST_MS`, `IGNORED_REQUEST_TYPES`, and the three `addEventListener` calls).
3. Remove the `waitForNetworkIdle` function (lines ~634-659).
4. After `await cdp.Network.enable(null, sessionId);`, add:
   ```typescript
   const network = createNetworkTracker(cdp, sessionId);
   ```
5. In the `close()` function, add `network.cleanup();` before closing the connection (alongside
   existing `dialog.cleanup()`).
6. In the returned object, replace `waitForNetworkIdle` with
   `waitForNetworkIdle: network.waitForNetworkIdle`.

**Step 6: Run full CI**

Run: `deno task ci` Expected: All tests pass (unit + integration).

**Step 7: Commit**

```bash
git add src/cdp/network.ts src/cdp/network.test.ts src/cdp/connection.ts
git commit -m "refactor: extract event-driven network tracker to cdp/network.ts

Replaces 50ms polling with event callbacks + periodic stale eviction timer.
Stale requests without terminal events are evicted by setInterval, not
only on network event callbacks."
```

---

### Task 5: Replace polling waits with MutationObserver + polling fallback

`waitForSelector`, `waitForText`, and `waitForTextInElement` currently poll with exponential
backoff. Replace with a hybrid approach: in-page `MutationObserver` for fast response to DOM
mutations + a scaled polling fallback (`max(1, min(100, timeout/5))` ms) for edge cases that
MutationObserver cannot detect. **Behavioral change** — needs integration tests.

**Why hybrid, not pure MutationObserver?** MutationObserver misses state-only changes that don't
mutate the DOM: `:checked` (property, not attribute), `:focus`, `:valid`/`:invalid`, and ancestor
visibility changes (parent removes `display:none` — the mutation is on an ancestor, not within the
observed subtree). The current polling approach catches all of these because it re-evaluates the
full condition each loop. The polling fallback interval scales with the timeout:
`Math.min(100, Math.floor(timeoutMs / 5))` — this caps at 100ms (matching the old initial poll
rate), and scales down for short timeouts (e.g., 20ms poll for a 100ms timeout). The
MutationObserver still handles the fast path for DOM mutations; the scaled poll is only needed for
state-only selectors.

**For `waitForTextInElement`:** The observer watches `document.documentElement` (not just `this`) so
ancestor visibility changes (parent toggling `display:none`) trigger a re-check of `this.innerText`.

**Files:**

- Create: `src/cdp/wait.ts`
- Modify: `src/cdp/connection.ts` (remove wait functions, import from wait.ts)
- Modify: `tests/integration/fixtures/actions.html` (add attribute-driven wait test elements)
- Modify: `tests/integration/actions.test.ts` (add attribute/class-driven wait tests)

**Step 1: Add integration test fixtures for attribute-driven waits**

In `tests/integration/fixtures/actions.html`, add elements that change visibility or gain matching
selectors via attribute/class changes (not node insertion):

```html
<!-- Attribute-driven wait test: element exists but class added after delay -->
<div id="attr-target">waiting</div>
<button
  id="add-class-btn"
  onclick="setTimeout(() => document.getElementById('attr-target').classList.add('ready'), 200)"
>
  Add Class
</button>

<!-- Style-driven visibility test: text hidden, then shown via style change -->
<div id="hidden-text" style="display: none">Secret Text</div>
<button
  id="show-text-btn"
  onclick="setTimeout(() => document.getElementById('hidden-text').style.display = '', 200)"
>
  Show
</button>

<!-- Ancestor-driven visibility test: child text hidden because parent is display:none -->
<div id="ancestor-wrapper" style="display: none"><span id="nested-text">Nested Secret</span></div>
<button
  id="show-ancestor-btn"
  onclick="setTimeout(() => document.getElementById('ancestor-wrapper').style.display = '', 200)"
>
  Show Ancestor
</button>
```

**Step 2: Add integration tests for attribute/class-driven waits**

In `tests/integration/actions.test.ts`, add tests:

```typescript
// Test: wait --selector for a class that gets added (not a new node)
Deno.test("actions: wait --selector detects attribute changes", async () => {
  // ... setup with fixture server, navigate to actions.html ...
  // Click #add-class-btn which adds .ready class after 200ms
  // Then: scraper wait --selector "#attr-target.ready" --timeout 3000
  // Should succeed (not timeout)
});

// Test: wait --text detects text becoming visible via style change
Deno.test("actions: wait --text detects style-driven visibility", async () => {
  // ... setup ...
  // Click #show-text-btn which removes display:none after 200ms
  // Then: scraper wait --text "Secret Text" --timeout 3000
  // Should succeed
});

// Test: wait --selector + --text detects ancestor visibility toggle (waitForTextInElement path)
Deno.test("actions: wait --text in element detects ancestor visibility change", async () => {
  // ... setup ...
  // Click #show-ancestor-btn which removes display:none from parent after 200ms
  // Then: scraper wait --selector "#nested-text" --text "Nested Secret" --timeout 3000
  // Should succeed — observer on document.documentElement catches parent's style mutation,
  // re-checks el.innerText which now returns visible text
});
```

**Step 3: Run tests to verify they pass with current polling implementation**

Run: `deno task test:integration` Expected: New tests pass (polling catches these cases). This
establishes the behavioral baseline.

**Step 4: Implement the wait module**

Create `src/cdp/wait.ts`. **All MutationObserver configs include `attributes: true`** to observe
class, id, style, and other attribute mutations — not just node insertion and text changes.

```typescript
/** Hybrid DOM waits: MutationObserver for fast response + scaled polling fallback for state-only changes. */

/** Poll interval scales with timeout: caps at 100ms, scales down for short timeouts. */
function pollInterval(timeoutMs: number): number {
  return Math.max(1, Math.min(100, Math.floor(timeoutMs / 5)));
}

// deno-lint-ignore no-explicit-any
export function createWaitMethods(cdp: any, sessionId: string) {
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
          const observer = new MutationObserver(() => { if (check()) done(); });
          observer.observe(document.documentElement, {
            childList: true, subtree: true, attributes: true,
          });
          const poll = setInterval(() => { if (check()) done(); }, pollMs);
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error('timed out waiting for selector "' + sel + '" (' + timeout + 'ms)'));
          }, timeout);
          function cleanup() { observer.disconnect(); clearInterval(poll); clearTimeout(timer); }
          function done() { cleanup(); resolve(); }
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
          const observer = new MutationObserver(() => { if (check()) done(); });
          observer.observe(document.documentElement, {
            childList: true, subtree: true, characterData: true, attributes: true,
          });
          const poll = setInterval(() => { if (check()) done(); }, pollMs);
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error('timed out waiting for text "' + text + '" (' + timeout + 'ms)'));
          }, timeout);
          function cleanup() { observer.disconnect(); clearInterval(poll); clearTimeout(timer); }
          function done() { cleanup(); resolve(); }
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
            const observer = new MutationObserver(() => { if (check()) done(); });
            observer.observe(document.documentElement, {
              childList: true, subtree: true, characterData: true, attributes: true,
            });
            const poll = setInterval(() => { if (check()) done(); }, pollMs);
            const timer = setTimeout(() => {
              cleanup();
              reject(new Error('timed out waiting for text "' + searchText + '" in element (' + timeout + 'ms)'));
            }, timeout);
            function cleanup() { observer.disconnect(); clearInterval(poll); clearTimeout(timer); }
            function done() { cleanup(); resolve(); }
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
```

**Step 5: Wire into createPageConnection**

In `src/cdp/connection.ts`:

1. Add import: `import { createWaitMethods } from "./wait.ts";`
2. Remove the three polling wait functions (`waitForSelector`, `waitForText`,
   `waitForTextInElement`).
3. After the network tracker setup, add:
   ```typescript
   const waits = createWaitMethods(cdp, sessionId);
   ```
4. In the returned object, replace the three wait methods:
   ```typescript
   waitForSelector: waits.waitForSelector,
   waitForText: waits.waitForText,
   waitForTextInElement: waits.waitForTextInElement,
   ```

**Step 6: Run full CI**

Run: `deno task ci` Expected: All tests pass, including:

- Existing wait tests (node insertion, text appearance, timeout)
- New attribute/class-driven wait tests
- `actions: wait --timeout times out with clear error`

The error message format must match what the CLI tests expect. Verify the
`replace(/^Error:\s*/, "")` strips the CDP error prefix correctly.

**Step 7: Commit**

```bash
git add src/cdp/wait.ts src/cdp/connection.ts tests/integration/fixtures/actions.html tests/integration/actions.test.ts
git commit -m "refactor: replace polling waits with hybrid MutationObserver in cdp/wait.ts

MutationObserver for fast response to DOM mutations + scaled polling fallback
(min(100, timeout/5) ms) for state-only changes (:checked, :focus, ancestor
visibility). waitForTextInElement observes document root to catch ancestor
changes. Integration tests cover attribute, style, and ancestor visibility."
```

---

### Task 6: Verify cleanup + final state

At this point, `close()` in `createPageConnection` should call `network.cleanup()` and
`dialog.cleanup()`. Verify that all CDP event listeners and timers are properly deregistered.

**Files:**

- Modify: `src/cdp/connection.ts` (verify close() calls all cleanups)

**Step 1: Verify close() implementation**

Read `src/cdp/connection.ts` and confirm `close()` looks like:

```typescript
function close(): void {
  network.cleanup();
  dialog.cleanup();
  try {
    cdp.connection?.close();
  } catch {
    // Connection already closed
  }
}
```

**Step 2: Run full CI one final time**

Run: `deno task ci` Expected: All tests pass.

**Step 3: Verify connection.ts is significantly slimmer**

Run:
`wc -l src/cdp/connection.ts src/cdp/network.ts src/cdp/input.ts src/cdp/wait.ts src/cdp/dialog.ts`

Expected rough sizes:

- `connection.ts`: ~250 lines (was ~770)
- `network.ts`: ~80 lines
- `input.ts`: ~250 lines
- `wait.ts`: ~100 lines
- `dialog.ts`: ~50 lines

**Step 4: Commit (if any cleanup was needed)**

```bash
git add src/cdp/connection.ts
git commit -m "refactor: verify event listener cleanup on close"
```
