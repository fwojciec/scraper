import type { EvalRequest, EvalResult } from "./eval.ts";
import type { NavigateRequest, PageInfo } from "./page.ts";
import type { SnapshotOptions, SnapshotResult } from "./snapshot.ts";

/** Interface for browser control operations. Implemented by cdp/ adapter. */
export interface BrowserService {
  navigate(req: NavigateRequest): Promise<PageInfo>;
  evaluate(req: EvalRequest): Promise<EvalResult>;
  screenshot(name: string, fullPage?: boolean): Promise<string>;
  listPages(): Promise<PageInfo[]>;
  closePage(name: string): Promise<void>;
}

/** Interface for page snapshot generation. Implemented by aria/ adapter. */
export interface SnapshotService {
  snapshot(
    options: SnapshotOptions,
    evaluateInPage: (expression: string) => Promise<unknown>,
  ): Promise<SnapshotResult>;
}
