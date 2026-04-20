/**
 * Pure retention policy for the `~/.scraper/` artifact directory.
 *
 * Adapters enumerate the directory and delete; this module only decides which
 * names go. Keeps the Tier B rule ("newest 20, nothing over 24h") unit-testable
 * without touching a real filesystem or clock.
 */

/**
 * Match snapshot YAML (`sN.yaml`) and screenshot PNG (`shotN.png`) artifacts.
 * Deliberately excludes `refs.<targetId>.json` and the `counter`/`counter-refs`
 * files — retention must never remove per-tab ref state or the monotonic id
 * counters (see Tier B design §Cleanup).
 */
const ARTIFACT_RE = /^(?:s\d+\.yaml|shot\d+\.png)$/;

export function isArtifactFile(name: string): boolean {
  return ARTIFACT_RE.test(name);
}

/** A single retention candidate. `name` is relative to the artifact directory. */
export interface ArtifactEntry {
  name: string;
  /** Modification time in milliseconds since epoch. */
  mtimeMs: number;
}

export interface RetentionPolicy {
  /** Keep at most this many newest artifacts. */
  maxCount: number;
  /** Delete anything whose age exceeds this (i.e. `nowMs - mtimeMs > maxAgeMs`). */
  maxAgeMs: number;
  /** Current time in ms since epoch. Injected so tests can stub the clock. */
  nowMs: number;
}

/**
 * Return the names of entries that should be deleted under `policy`. An entry
 * is dropped when it falls outside the newest `maxCount` OR when its age
 * exceeds `maxAgeMs`. Order of returned names is unspecified — callers that
 * care should sort.
 */
export function selectDeletions(
  entries: readonly ArtifactEntry[],
  policy: RetentionPolicy,
): string[] {
  const sorted = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cutoff = policy.nowMs - policy.maxAgeMs;
  const toDelete: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    if (i >= policy.maxCount || entry.mtimeMs < cutoff) {
      toDelete.push(entry.name);
    }
  }
  return toDelete;
}
