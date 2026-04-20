/** Options for generating an ARIA snapshot. */
export interface SnapshotOptions {
  maxDepth?: number;
  maxNodes?: number;
  selector?: string;
  /**
   * Session-scoped starting value for the ref counter. The first ref minted by
   * this snapshot is `e{startingRefCounter + 1}`. Defaults to 0, so the first
   * ref is `e1` when unspecified. Used to persist a monotonic cross-tab counter
   * (`~/.scraper/counter-refs`).
   */
  startingRefCounter?: number;
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
  /**
   * Highest ref counter value used by this snapshot. Equal to
   * `startingRefCounter` when no refs were minted. Callers persist this so the
   * next snapshot starts at `lastRefCounter + 1`.
   */
  lastRefCounter: number;
}
