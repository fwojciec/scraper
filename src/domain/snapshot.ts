/** Options for generating an ARIA snapshot. */
export interface SnapshotOptions {
  maxDepth?: number;
  maxNodes?: number;
  selector?: string;
}

/** Opaque token for a ref label in an ARIA snapshot (e.g. "e1", "e2"). */
export type RefToken = string;

/** Handle to a DOM node, used to resolve refs back to page elements. */
export type DomNodeHandle = number;

/** Serializable ref map: RefToken → DomNodeHandle. */
export type RefMap = Record<RefToken, DomNodeHandle>;

/** Result of generating an ARIA snapshot. */
export interface SnapshotResult {
  yaml: string;
  refs: RefMap;
}
