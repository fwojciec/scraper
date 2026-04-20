import type { SnapshotRequest, SnapshotResult } from "./snapshot.ts";

/** Interface for page snapshot generation. Implemented by aria/ adapter. */
export interface SnapshotService {
  snapshot(request: SnapshotRequest): Promise<SnapshotResult>;
}
