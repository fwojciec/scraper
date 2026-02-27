/** Options for generating an ARIA snapshot. */
export interface SnapshotOptions {
  name?: string;
  maxDepth?: number;
  maxNodes?: number;
  selector?: string;
}

/** Result of generating an ARIA snapshot. */
export interface SnapshotResult {
  yaml: string;
}
