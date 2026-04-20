// Adapter: CLI (Deno.args). Direct CDP operations, no HTTP server.

import type { ElementTarget, ScraperApp, WaitRequest } from "../domain/mod.ts";

/** Dependencies injected from main.ts composition root. */
export interface CliDeps {
  app: ScraperApp;
  /**
   * Resolve `--tab <input>` (a prefix or a full targetId) to the canonical
   * full targetId by consulting Chrome's live tab list. Throws with the
   * exact error text specified by the Tier B design (missing flag, no match,
   * ambiguous prefix). Wired in `src/main.ts` via `canonicalizeTargetId`.
   */
  canonicalizeTab(input: string): Promise<string>;
  stdout(s: string): void;
  stderr(s: string): void;
}

const USAGE = `Usage: scraper <command> [options]

Commands:
  navigate    Navigate to a URL
  snapshot    Generate an ARIA snapshot
  eval        Evaluate JavaScript
  screenshot  Capture a screenshot
  upload      Upload a file to an input
  wait        Wait for a condition
`;

/** Flags that never take a value argument. */
const BOOLEAN_FLAGS = new Set(["snapshot", "full-page"]);

function parseFlags(
  args: string[],
): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith("--")) {
      const raw = args[i].slice(2);
      const eqIdx = raw.indexOf("=");
      if (eqIdx !== -1) {
        flags[raw.slice(0, eqIdx)] = raw.slice(eqIdx + 1);
        i++;
      } else if (BOOLEAN_FLAGS.has(raw)) {
        flags[raw] = true;
        i++;
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[raw] = args[i + 1];
        i += 2;
      } else {
        flags[raw] = true;
        i++;
      }
    } else {
      positional.push(args[i]);
      i++;
    }
  }
  return { positional, flags };
}

function flagString(flags: Record<string, string | true>, key: string): string | undefined {
  const val = flags[key];
  return typeof val === "string" ? val : undefined;
}

function flagNumber(
  flags: Record<string, string | true>,
  key: string,
): [number | undefined, string | undefined] {
  const val = flags[key];
  if (val === undefined) return [undefined, undefined];
  if (val === true || val === "") return [undefined, `--${key} requires a value`];
  const n = Number(val);
  if (Number.isNaN(n)) return [undefined, `--${key} must be a number, got '${val}'`];
  return [n, undefined];
}

function flagBoolean(flags: Record<string, string | true>, key: string): boolean {
  return flags[key] === true;
}

/**
 * Resolve `--tab <input>` from the parsed flags to the canonical full targetId.
 * Returns `[id, undefined]` on success, `[undefined, errorText]` on failure.
 * All error text (missing flag, no match, ambiguous prefix) comes from
 * `canonicalizeTab` per the Tier B design doc §Active Target Selection.
 */
async function resolveTabFlag(
  flags: Record<string, string | true>,
  deps: CliDeps,
): Promise<[string | undefined, string | undefined]> {
  const input = flagString(flags, "tab") ?? "";
  try {
    const canonical = await deps.canonicalizeTab(input);
    return [canonical, undefined];
  } catch (err) {
    return [undefined, err instanceof Error ? err.message : String(err)];
  }
}

/** Parse --ref or --selector from flags. Returns [target, error]. */
function parseTarget(
  flags: Record<string, string | true>,
): [ElementTarget | undefined, string | undefined] {
  const ref = flagString(flags, "ref");
  const selector = flagString(flags, "selector");

  if (ref && selector) {
    return [undefined, "provide either --ref or --selector, not both"];
  }
  if (ref) return [{ ref }, undefined];
  if (selector) return [{ selector }, undefined];
  return [undefined, "either --ref or --selector is required"];
}

async function handleNavigate(args: string[], deps: CliDeps): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const url = positional[0];
  if (!url) {
    deps.stderr("error: url is required\nUsage: scraper navigate --tab <targetId> <url>\n");
    return 1;
  }

  if ("on-dialog" in flags) {
    deps.stderr("error: --on-dialog is not supported in this build\n");
    return 1;
  }

  const [targetId, tabErr] = await resolveTabFlag(flags, deps);
  if (tabErr) {
    deps.stderr(`error: ${tabErr}\n`);
    return 1;
  }

  const includeSnapshot = flagBoolean(flags, "snapshot");

  try {
    const result = await deps.app.navigate(targetId!, url, { includeSnapshot });
    if (result.snapshot) {
      deps.stderr(`navigated to ${url}\n`);
      deps.stdout(result.snapshot.yaml);
    } else {
      deps.stdout(`navigated to ${url}\n`);
    }
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handleSnapshot(args: string[], deps: CliDeps): Promise<number> {
  const { flags } = parseFlags(args);
  const [targetId, tabErr] = await resolveTabFlag(flags, deps);
  if (tabErr) {
    deps.stderr(`error: ${tabErr}\n`);
    return 1;
  }
  const [maxDepth, mdErr] = flagNumber(flags, "max-depth");
  if (mdErr) {
    deps.stderr(`error: ${mdErr}\n`);
    return 1;
  }
  const [maxNodes, mnErr] = flagNumber(flags, "max-nodes");
  if (mnErr) {
    deps.stderr(`error: ${mnErr}\n`);
    return 1;
  }
  const selector = flagString(flags, "selector");

  try {
    const result = await deps.app.snapshot(targetId!, { maxDepth, maxNodes, selector });
    deps.stdout(result.yaml);
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handleEval(args: string[], deps: CliDeps): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const expression = positional[0];
  if (!expression) {
    deps.stderr(
      "error: expression is required\nUsage: scraper eval --tab <targetId> '<expression>'\n",
    );
    return 1;
  }

  const [targetId, tabErr] = await resolveTabFlag(flags, deps);
  if (tabErr) {
    deps.stderr(`error: ${tabErr}\n`);
    return 1;
  }

  try {
    const { result } = await deps.app.evaluate(targetId!, expression);
    deps.stdout(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handleScreenshot(args: string[], deps: CliDeps): Promise<number> {
  const { flags } = parseFlags(args);
  const [targetId, tabErr] = await resolveTabFlag(flags, deps);
  if (tabErr) {
    deps.stderr(`error: ${tabErr}\n`);
    return 1;
  }
  const fullPage = flagBoolean(flags, "full-page");

  try {
    const path = await deps.app.screenshot(targetId!, fullPage || undefined);
    deps.stdout(path + "\n");
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handleWait(args: string[], deps: CliDeps): Promise<number> {
  const { flags } = parseFlags(args);

  const ref = flagString(flags, "ref");
  const selector = flagString(flags, "selector");
  const text = flagString(flags, "text");
  const [timeoutMs, timeoutErr] = flagNumber(flags, "timeout");
  if (timeoutErr) {
    deps.stderr(`error: ${timeoutErr}\n`);
    return 1;
  }

  // Validate combinations
  if (!ref && !selector && !text) {
    deps.stderr(
      "error: at least one of --selector, --text, or --ref --text is required\n" +
        "Usage: scraper wait --tab <targetId> --selector <css> | --text '<text>' | --ref <ref> --text '<text>'\n",
    );
    return 1;
  }

  if (ref && selector) {
    deps.stderr("error: provide either --ref or --selector, not both\n");
    return 1;
  }

  if (ref && !text) {
    deps.stderr("error: --ref requires --text (a ref names an existing element)\n");
    return 1;
  }

  const [targetId, tabErr] = await resolveTabFlag(flags, deps);
  if (tabErr) {
    deps.stderr(`error: ${tabErr}\n`);
    return 1;
  }

  // Build discriminated WaitRequest from flags
  let request: WaitRequest;
  if (text && (ref || selector)) {
    const target: ElementTarget = ref ? { ref } : { selector: selector! };
    request = { kind: "textInElement", target, text, timeoutMs };
  } else if (text) {
    request = { kind: "text", text, timeoutMs };
  } else {
    request = { kind: "selector", selector: selector!, timeoutMs };
  }

  try {
    await deps.app.wait(targetId!, request);
    if (request.kind === "textInElement") {
      const label = "ref" in request.target
        ? `ref ${request.target.ref}`
        : `selector "${request.target.selector}"`;
      deps.stdout(`found text "${request.text}" in ${label}\n`);
    } else if (request.kind === "text") {
      deps.stdout(`found text "${request.text}"\n`);
    } else {
      deps.stdout(`found element matching "${request.selector}"\n`);
    }
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handleUpload(args: string[], deps: CliDeps): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const [target, targetErr] = parseTarget(flags);
  if (targetErr) {
    deps.stderr(
      `error: ${targetErr}\nUsage: scraper upload --tab <targetId> --ref <ref> | --selector <css> <path>\n`,
    );
    return 1;
  }

  const filePath = positional[0];
  if (filePath === undefined) {
    deps.stderr(
      "error: file path is required\nUsage: scraper upload --tab <targetId> --ref <ref> <path>\n",
    );
    return 1;
  }

  if ("on-dialog" in flags) {
    deps.stderr("error: --on-dialog is not supported in this build\n");
    return 1;
  }

  const [targetId, tabErr] = await resolveTabFlag(flags, deps);
  if (tabErr) {
    deps.stderr(`error: ${tabErr}\n`);
    return 1;
  }

  const includeSnapshot = flagBoolean(flags, "snapshot");

  try {
    const result = await deps.app.upload(targetId!, target!, filePath, { includeSnapshot });
    const label = "ref" in target! ? `ref ${target!.ref}` : `selector "${target!.selector}"`;
    if (result.snapshot) {
      deps.stderr(`uploaded to ${label}\n`);
      deps.stdout(result.snapshot.yaml);
    } else {
      deps.stdout(`uploaded to ${label}\n`);
    }
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

/** Run the CLI with the given arguments and dependencies. Returns exit code. */
export function runCli(args: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = args;

  if (!command) {
    deps.stderr(USAGE);
    return Promise.resolve(1);
  }

  switch (command) {
    case "navigate":
      return handleNavigate(rest, deps);
    case "snapshot":
      return handleSnapshot(rest, deps);
    case "eval":
      return handleEval(rest, deps);
    case "screenshot":
      return handleScreenshot(rest, deps);
    case "upload":
      return handleUpload(rest, deps);
    case "wait":
      return handleWait(rest, deps);
    default:
      deps.stderr(`error: unknown command '${command}'\n${USAGE}`);
      return Promise.resolve(1);
  }
}
