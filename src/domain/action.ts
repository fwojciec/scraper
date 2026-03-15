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

/**
 * What to wait for.
 * Valid combinations:
 * - { target: { selector } }              — wait for element to exist in DOM
 * - { text }                               — wait for text anywhere on page
 * - { target: { selector }, text }         — wait for text within element
 * - { target: { ref }, text }              — wait for text within ref'd element
 * Invalid: { target: { ref } } without text — ref already exists, nothing to wait for.
 */
export interface WaitOptions {
  /** Element to scope the wait to. */
  target?: import("./element.ts").ElementTarget;
  /** Text content to wait for (substring match). */
  text?: string;
  /** Timeout in ms (default 5000). */
  timeoutMs?: number;
}
