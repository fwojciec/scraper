/** Result of evaluating a JS expression. */
export interface EvalResult {
  result: unknown;
}

/**
 * Scan a JS expression for `$ref("eN")` / `$ref('eN')` calls and return the
 * distinct ref tokens in order of first appearance.
 *
 * The scanner distinguishes string literals (`"..."`, `'...'`) and template
 * literals (`` `...` ``, with `${...}` treated as a nested code context) so
 * a literal `$ref("e3")` inside a string is not mistaken for a call. Property
 * access and identifier prefixes (`$reference`, `my$ref`, `obj.$ref`) are
 * rejected by the same lookbehind rule as before.
 *
 * Deliberately does not recognize JS comments or regex literals:
 *   - Distinguishing `/` as comment-start vs. regex-start vs. division
 *     requires stateful lexing of the preceding token class. `scraper eval`
 *     accepts arbitrary JS expressions, so a wrong guess on a regex literal
 *     (e.g. `/^https?:\/\//`) can swallow a following `$ref(...)` and cause
 *     a runtime `$ref is not defined` error — a real regression.
 *   - Comments are extremely rare in single-line eval expressions; regex
 *     literals are common. The cost/benefit favors ignoring comments rather
 *     than risking regex-literal misparses.
 *
 * A stray `$ref("...")` inside a comment therefore counts as a match; the
 * cost is a harmless extra refs lookup or a spurious stale-ref error — the
 * same tradeoff the pre-tokenizer regex scanner accepted.
 */
export function scanRefs(expression: string): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  const src = expression;
  const len = src.length;
  const REF_AT = /^\$ref\s*\(\s*(?:"([^"]*)"|'([^']*)')\s*\)/;

  // Stack-based context: each frame is either { ctx: "code", depth } — plain
  // code, optionally nested inside a template interpolation; or { ctx: "tpl" }
  // — the literal text of a `...` template, which is skipped except for
  // `${` which pushes a new code frame. A `}` at depth 0 in a code frame that
  // lives above a template frame pops back to the enclosing template.
  type Frame = { ctx: "code"; depth: number } | { ctx: "tpl" };
  const stack: Frame[] = [{ ctx: "code", depth: 0 }];

  let i = 0;
  while (i < len) {
    const top = stack[stack.length - 1];
    const c = src[i];

    if (top.ctx === "tpl") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        stack.pop();
        i++;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        stack.push({ ctx: "code", depth: 0 });
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // ctx === "code"
    // Non-template string literal.
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < len) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Template literal — text is skipped, ${...} descends.
    if (c === "`") {
      stack.push({ ctx: "tpl" });
      i++;
      continue;
    }
    // Brace tracking for template-interpolation exit.
    if (c === "{") {
      top.depth++;
      i++;
      continue;
    }
    if (c === "}") {
      if (top.depth === 0 && stack.length > 1) {
        stack.pop();
        i++;
        continue;
      }
      if (top.depth > 0) top.depth--;
      i++;
      continue;
    }
    // `$ref(...)` call site.
    if (c === "$" && src.startsWith("$ref", i)) {
      const prev = i === 0 ? "" : src[i - 1];
      if (!/[\w$.]/.test(prev)) {
        const m = REF_AT.exec(src.slice(i));
        if (m) {
          const name = m[1] ?? m[2] ?? "";
          if (!seen.has(name)) {
            seen.add(name);
            refs.push(name);
          }
          i += m[0].length;
          continue;
        }
      }
    }
    i++;
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
