/** Options for generating an ARIA snapshot. */
export interface SnapshotOptions {
  maxDepth?: number;
  maxNodes?: number;
  selector?: string;
}

/**
 * Dialog observed during the command that produced a snapshot. The agent reads
 * this to learn that a native JS dialog (alert/confirm/prompt/beforeunload)
 * fired and how scraper responded — so it can choose to retry with
 * `--on-dialog accept` if the default dismiss was wrong.
 */
export interface SnapshotDialog {
  /** CDP `javascriptDialogOpening` type: "alert" | "confirm" | "prompt" | "beforeunload". */
  type: string;
  /** The dialog's message text. */
  message: string;
  /** What scraper did with it. */
  handled: "dismiss" | "accept";
}

/**
 * Full request sent to the SnapshotService. Extends SnapshotOptions with the
 * session-scoped ref counter and the header fields required by the on-disk
 * snapshot artifact (see Tier B design §Snapshot Artifact).
 */
export interface SnapshotRequest extends SnapshotOptions {
  /**
   * Session-scoped starting value for the ref counter. The first ref minted by
   * this snapshot is `e{startingRefCounter + 1}`. Defaults to 0, so the first
   * ref is `e1` when unspecified. Used to persist a monotonic cross-tab counter
   * (`~/.scraper/counter-refs`).
   */
  startingRefCounter?: number;
  /** Artifact ID for this snapshot (e.g. `s47`). Rendered into the YAML header. */
  snapshotId: string;
  /** Canonical full targetId of the tab this snapshot came from. */
  targetId: string;
  /** Page URL at capture time. */
  url: string;
  /** Page title at capture time. */
  title: string;
  /**
   * Dialog observed during the command that produced this snapshot, or null
   * when no dialog fired. Always null for plain `scraper snapshot` calls
   * (which don't execute page JS); set by mutating commands that wrap their
   * work in `withDialogHandling`.
   */
  dialog: SnapshotDialog | null;
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
  /** Artifact ID assigned to this snapshot (e.g. `s47`). Echoed from the request. */
  snapshotId: string;
  /** Page title at capture time. Echoed from the request. Empty string is common. */
  title: string;
  /** Page URL at capture time. Echoed from the request. */
  url: string;
}
