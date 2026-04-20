import type { ActionOptions, ActionResult } from "./action.ts";
import type { ElementTarget } from "./element.ts";
import type { EvalResult } from "./eval.ts";
import type { SnapshotOptions, SnapshotResult } from "./snapshot.ts";

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
  snapshot(targetId: string, options: SnapshotOptions): Promise<SnapshotResult>;
  evaluate(targetId: string, expression: string): Promise<EvalResult>;
  screenshot(targetId: string, fullPage?: boolean): Promise<string>;
  upload(
    targetId: string,
    target: ElementTarget,
    filePath: string,
    options?: ActionOptions,
  ): Promise<ActionResult>;
  wait(targetId: string, request: WaitRequest): Promise<void>;
}
