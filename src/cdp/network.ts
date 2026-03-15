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

export function createNetworkTracker(
  // deno-lint-ignore no-explicit-any
  cdp: any,
  sessionId: string,
  options?: NetworkTrackerOptions,
): NetworkTracker {
  const staleMs = options?.staleRequestMs ?? DEFAULT_STALE_REQUEST_MS;
  const staleCheckMs = Math.min(Math.ceil(staleMs / 2), MAX_STALE_CHECK_INTERVAL_MS);
  const inflight = new Map<string, number>();
  const changeCallbacks = new Set<() => void>();
  const pendingDone = new Set<(timedOut: boolean) => void>();
  let disposed = false;

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
  const onTerminal = (e: any) => {
    if (e.sessionId === sessionId && inflight.delete(e.params.requestId)) {
      notifyChange();
    }
  };

  cdp.Network.addEventListener("requestWillBeSent", onRequest);
  cdp.Network.addEventListener("loadingFinished", onTerminal);
  cdp.Network.addEventListener("loadingFailed", onTerminal);

  function waitForNetworkIdle(graceMs = 500, timeoutMs = 5000): Promise<boolean> {
    if (disposed) return Promise.resolve(true);
    return new Promise((resolve) => {
      let graceTimer: number | undefined;

      const deadlineTimer = setTimeout(() => {
        done(true);
      }, timeoutMs);

      function done(timedOut: boolean) {
        if (!pendingDone.has(done)) return; // already settled
        pendingDone.delete(done);
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

      pendingDone.add(done);
      changeCallbacks.add(onChange);

      // Check immediately — may already be idle
      evictStale();
      if (inflight.size === 0) {
        startGrace();
      }
    });
  }

  function cleanup() {
    disposed = true;
    clearInterval(staleTimer);
    cdp.Network.removeEventListener("requestWillBeSent", onRequest);
    cdp.Network.removeEventListener("loadingFinished", onTerminal);
    cdp.Network.removeEventListener("loadingFailed", onTerminal);
    // Settle any pending waitForNetworkIdle promises immediately
    for (const done of pendingDone) done(true);
    changeCallbacks.clear();
  }

  return { waitForNetworkIdle, cleanup };
}
