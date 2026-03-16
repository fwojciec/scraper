import type { SnapshotOptions, SnapshotResult } from "./snapshot.ts";

/** Interface for page snapshot generation. Implemented by aria/ adapter. */
export interface SnapshotService {
  snapshot(options: SnapshotOptions): Promise<SnapshotResult>;
}
