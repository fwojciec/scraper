import type { SnapshotResult } from "./snapshot.ts";

/** Result of a mutating action (click, fill, navigate, etc.). */
export interface ActionResult {
  /** Updated snapshot, present when the caller requested --snapshot. */
  snapshot?: SnapshotResult;
}

/** Options common to all mutating actions. */
export interface ActionOptions {
  includeSnapshot?: boolean;
}
