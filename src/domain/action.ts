import type { SnapshotResult } from "./snapshot.ts";

/** Result of a mutating action (click, fill, navigate, etc.). */
export interface ActionResult {
  /** Updated snapshot, present when the caller requested --snapshot. */
  snapshot?: SnapshotResult;
}

/**
 * How to respond when a native JS dialog fires during a command. Defaults to
 * dismiss when omitted — see Tier B design §Dialog Handling. Kept as a flat
 * options bag rather than a discriminated union per the design rule "no
 * DialogPolicy type threaded through the domain."
 */
export interface DialogResponse {
  /** `true` calls CDP `Page.handleJavaScriptDialog` with `accept: true`; `false` dismisses. */
  accept: boolean;
  /** Text to send when accepting a `prompt()` dialog; ignored when dismissing. */
  promptText?: string;
}

/** Options common to all mutating actions. */
export interface ActionOptions {
  includeSnapshot?: boolean;
  /**
   * Dialog response policy for any dialog that opens during this command.
   * Omitting it (or setting `accept: false`) means dismiss — the safer default.
   */
  onDialog?: DialogResponse;
}
