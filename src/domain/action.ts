import type { SnapshotResult } from "./snapshot.ts";

/** Result of a mutating action (click, fill, navigate, etc.). */
export interface ActionResult {
  /** Updated snapshot, present when the caller requested --snapshot. */
  snapshot?: SnapshotResult;
}

/** How a mutating action should handle a dialog if one appears. */
export type DialogPolicy =
  | { action: "accept"; text?: string }
  | { action: "dismiss" };

/** Options common to all mutating actions. */
export interface ActionOptions {
  includeSnapshot?: boolean;
  onDialog?: DialogPolicy;
}
