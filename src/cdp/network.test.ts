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
  globalThis.clearInterval = ((id: number) => {
    cleared.add(id);
    origClearInterval(id);
    // deno-lint-ignore no-explicit-any
  }) as any;

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
