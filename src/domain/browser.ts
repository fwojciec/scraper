import type { EvalResult } from "./eval.ts";
import type { SnapshotOptions, SnapshotResult } from "./snapshot.ts";

/** Interface for browser control operations. Implemented by cdp/ adapter. */
export interface BrowserService {
  navigate(url: string): Promise<void>;
  evaluate(expression: string): Promise<EvalResult>;
  screenshot(fullPage?: boolean): Promise<string>;
}

/** Interface for page snapshot generation. Implemented by aria/ adapter. */
export interface SnapshotService {
  snapshot(options: SnapshotOptions): Promise<SnapshotResult>;
}
