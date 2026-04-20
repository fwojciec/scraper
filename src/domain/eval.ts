/** Result of evaluating a JS expression. */
export interface EvalResult {
  result: unknown;
}

/**
 * Scan a JS expression for `$ref("eN")` / `$ref('eN')` calls and return the
 * distinct ref tokens in order of first appearance.
 *
 * Negative lookbehind rejects `$reference(...)`, `my$ref(...)`, and
 * `obj.$ref(...)` so only the bare helper matches. A literal `$ref("...")`
 * inside a string or comment is not distinguishable from a real call without
 * JS tokenizing — the cost of a false positive is a wasted resolve (harmless)
 * or, if the literal ref is absent from `refs.<targetId>.json`, a spurious
 * stale-ref error. The workaround is to not embed literal `$ref("...")` text
 * in strings; the canonical uses (method calls, property access) are unaffected.
 */
export function scanRefs(expression: string): string[] {
  const re = /(?<![\w$.])\$ref\s*\(\s*(?:"([^"]*)"|'([^']*)')\s*\)/g;
  const seen = new Set<string>();
  const refs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(expression)) !== null) {
    const ref = match[1] ?? match[2] ?? "";
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

/**
 * Build the stale-ref error message per design doc §Handle Scheme. The leading
 * `error: ` prefix is added by the CLI; this returns just the body so the app
 * layer can throw it as a plain Error.
 */
export function formatStaleRefError(
  ref: string,
  targetId: string,
  currentRefs: readonly string[],
): string {
  return `ref ${ref} is stale — not in refs.${targetId}.json (current refs: ${
    summarizeRefs(currentRefs)
  }).\nRun \`scraper snapshot --tab ${targetId}\` and retry with a fresh ref.`;
}

function summarizeRefs(refs: readonly string[]): string {
  const nums: number[] = [];
  for (const r of refs) {
    const m = /^e(\d+)$/.exec(r);
    if (m) nums.push(Number(m[1]));
  }
  if (nums.length === 0) return "none";
  nums.sort((a, b) => a - b);
  if (nums.length === 1) return `e${nums[0]}`;
  return `e${nums[0]}..e${nums[nums.length - 1]}`;
}
