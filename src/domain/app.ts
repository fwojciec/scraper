import type { ActionOptions, ActionResult } from "./action.ts";
import type { ElementTarget } from "./element.ts";
import type { EvalResult } from "./eval.ts";
import type { PageId, PageInfo } from "./page.ts";
import type { SnapshotOptions, SnapshotResult } from "./snapshot.ts";

/**
 * What to wait for — discriminated union that makes invalid states
 * unrepresentable. Replaces the loosely-typed WaitOptions bag.
 */
export type WaitRequest =
  | { kind: "selector"; selector: string; timeoutMs?: number }
  | { kind: "text"; text: string; timeoutMs?: number }
  | { kind: "textInElement"; target: ElementTarget; text: string; timeoutMs?: number };

/** Application-level contract for the scraper. */
export interface ScraperApp {
  pages(): Promise<PageInfo[]>;
  selectPage(pageId: PageId): Promise<void>;
  navigate(url: string, options?: ActionOptions): Promise<ActionResult>;
  snapshot(options: SnapshotOptions): Promise<SnapshotResult>;
  evaluate(expression: string): Promise<EvalResult>;
  screenshot(fullPage?: boolean): Promise<string>;
  upload(target: ElementTarget, filePath: string, options?: ActionOptions): Promise<ActionResult>;
  wait(request: WaitRequest): Promise<void>;
}
