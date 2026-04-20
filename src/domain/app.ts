import type { ActionOptions, ActionResult } from "./action.ts";
import type { ElementTarget } from "./element.ts";
import type { EvalResult } from "./eval.ts";
import type { SnapshotOptions, SnapshotResult } from "./snapshot.ts";

/** Result of `navigate --new`: the newly-minted full targetId plus its first snapshot. */
export interface NavigateNewResult {
  targetId: string;
  snapshot: SnapshotResult;
}

/**
 * What to wait for — discriminated union that makes invalid states
 * unrepresentable. Replaces the loosely-typed WaitOptions bag.
 */
export type WaitRequest =
  | { kind: "selector"; selector: string; timeoutMs?: number }
  | { kind: "text"; text: string; timeoutMs?: number }
  | { kind: "textInElement"; target: ElementTarget; text: string; timeoutMs?: number };

/**
 * Application-level contract for the scraper. Every tab-scoped method takes an
 * already-canonical full `targetId` (32-hex Chrome target id). Canonicalization
 * from a user-supplied prefix is the CLI's responsibility — see
 * `src/cdp/tabs.ts::canonicalizeTargetId`.
 */
export interface ScraperApp {
  navigate(targetId: string, url: string, options?: ActionOptions): Promise<ActionResult>;
  /**
   * Open a new tab pointing at `url` via `Target.createTarget`, wait for load
   * + network idle, then auto-snapshot. Returns the new tab's full targetId
   * (so the agent can address it on subsequent commands) and the snapshot.
   */
  navigateNew(url: string): Promise<NavigateNewResult>;
  snapshot(targetId: string, options: SnapshotOptions): Promise<SnapshotResult>;
  evaluate(targetId: string, expression: string): Promise<EvalResult>;
  screenshot(targetId: string): Promise<string>;
  upload(
    targetId: string,
    target: ElementTarget,
    filePath: string,
    options?: ActionOptions,
  ): Promise<ActionResult>;
  /**
   * Wait for `request` to be satisfied. On success, the page likely changed in
   * ways the agent cares about (new text, new element) — the CLI auto-snapshots
   * by passing `includeSnapshot: true`, which also eagerly invalidates this
   * tab's refs so a snapshot failure can't leave stale refs addressable.
   * Failure (timeout) rejects without touching refs or the artifact counter.
   */
  wait(targetId: string, request: WaitRequest, options?: ActionOptions): Promise<ActionResult>;
}
