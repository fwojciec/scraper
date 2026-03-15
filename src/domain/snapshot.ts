/** Options for generating an ARIA snapshot. */
export interface SnapshotOptions {
  maxDepth?: number;
  maxNodes?: number;
  selector?: string;
}

/** Serializable ref map: ref string → backendDOMNodeId. */
export type RefMap = Record<string, number>;

/** Result of generating an ARIA snapshot. */
export interface SnapshotResult {
  yaml: string;
  refs: RefMap;
}
