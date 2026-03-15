// Adapter: CLI (Deno.args). Direct CDP operations, no HTTP server.

import type {
  ActionOptions,
  ActionResult,
  ElementTarget,
  PageInfo,
  SnapshotOptions,
  SnapshotResult,
  WaitOptions,
} from "../domain/mod.ts";

/** Result of starting Chrome. */
export interface StartResult {
  status: "started" | "already_running" | "attached";
  chromePid?: number;
  cdpPort: number;
}

/** Options for the start command. */
export interface StartOptions {
  chromePath?: string;
  attach?: boolean;
  channel?: string;
}

/** Dependencies injected from main.ts composition root. */
export interface CliDeps {
  startChrome(opts: StartOptions): Promise<StartResult>;
  stopChrome(): Promise<void>;
  navigate(url: string, opts?: ActionOptions): Promise<ActionResult>;
  snapshot(opts: SnapshotOptions): Promise<SnapshotResult>;
  evaluate(expression: string): Promise<{ result: unknown }>;
  screenshot(fullPage?: boolean): Promise<string>;
  listPages(): Promise<PageInfo[]>;
  selectPage(targetId: string): Promise<void>;
  click(target: ElementTarget, opts?: ActionOptions): Promise<ActionResult>;
  fill(target: ElementTarget, value: string, opts?: ActionOptions): Promise<ActionResult>;
  wait(opts: WaitOptions): Promise<void>;
  type(target: ElementTarget, text: string, opts?: ActionOptions): Promise<ActionResult>;
  selectOption(target: ElementTarget, value: string, opts?: ActionOptions): Promise<ActionResult>;
  submit(target: ElementTarget, opts?: ActionOptions): Promise<ActionResult>;
  pressKey(key: string, target?: ElementTarget, opts?: ActionOptions): Promise<ActionResult>;
  stdout(s: string): void;
  stderr(s: string): void;
}

const USAGE = `Usage: scraper <command> [options]

Commands:
  start       Launch or attach to Chrome
  stop        Stop Chrome
  navigate    Navigate to a URL
  snapshot    Generate an ARIA snapshot
  eval        Evaluate JavaScript
  screenshot  Capture a screenshot
  pages       List open tabs
  page        Switch active tab
  click       Click an element
  fill        Fill an input element
  type        Type text character by character
  select      Select a dropdown option
  submit      Submit a form
  press-key   Press a keyboard key
  wait        Wait for a condition
`;

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

/** Output an ActionResult: status to stderr, snapshot YAML to stdout. */
function outputActionResult(
  result: ActionResult,
  statusLine: string,
  deps: CliDeps,
): void {
  deps.stderr(statusLine + "\n");
  if (result.snapshot) {
    deps.stdout(result.snapshot.yaml);
  }
}

async function handleStart(args: string[], deps: CliDeps): Promise<number> {
  const { flags } = parseFlags(args);
  const chromePath = flagString(flags, "chrome-path");
  const attach = flagBoolean(flags, "attach");
  const channel = flagString(flags, "channel");

  try {
    const result = await deps.startChrome({ chromePath, attach, channel });
    if (result.status === "already_running") {
      if (result.chromePid) {
        deps.stdout(`chrome already running (pid ${result.chromePid})\n`);
      } else {
        deps.stdout(`already attached to Chrome (port ${result.cdpPort})\n`);
      }
    } else if (result.status === "attached") {
      deps.stdout(
        `attached to Chrome (port ${result.cdpPort}). Run 'scraper pages' to list tabs.\n`,
      );
    } else {
      deps.stdout(
        `chrome started (pid ${result.chromePid}, cdp port ${result.cdpPort})\n`,
      );
    }
    return 0;
  } catch (err) {
    deps.stderr(
      `error: failed to start chrome: ${err instanceof Error ? err.message : err}\n`,
    );
    return 1;
  }
}

async function handleStop(deps: CliDeps): Promise<number> {
  try {
    await deps.stopChrome();
    deps.stdout("chrome stopped\n");
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handleNavigate(args: string[], deps: CliDeps): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const url = positional[0];
  if (!url) {
    deps.stderr("error: url is required\nUsage: scraper navigate <url>\n");
    return 1;
  }

  const includeSnapshot = flagBoolean(flags, "snapshot");

  try {
    const result = await deps.navigate(url, { includeSnapshot });
    if (result.snapshot) {
      outputActionResult(result, `navigated to ${url}`, deps);
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
    const result = await deps.snapshot({ maxDepth, maxNodes, selector });
    deps.stdout(result.yaml);
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handleEval(args: string[], deps: CliDeps): Promise<number> {
  const { positional } = parseFlags(args);
  const expression = positional[0];
  if (!expression) {
    deps.stderr("error: expression is required\nUsage: scraper eval '<expression>'\n");
    return 1;
  }

  try {
    const { result } = await deps.evaluate(expression);
    deps.stdout(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handleScreenshot(args: string[], deps: CliDeps): Promise<number> {
  const { flags } = parseFlags(args);
  const fullPage = flagBoolean(flags, "full-page");

  try {
    const path = await deps.screenshot(fullPage || undefined);
    deps.stdout(path + "\n");
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handlePages(deps: CliDeps): Promise<number> {
  try {
    const pages = await deps.listPages();
    if (pages.length === 0) {
      deps.stdout("no open tabs\n");
      return 0;
    }
    for (const page of pages) {
      const marker = page.active ? "* " : "  ";
      deps.stdout(`${marker}${page.targetId}  ${page.title}  ${page.url}\n`);
    }
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handlePage(args: string[], deps: CliDeps): Promise<number> {
  const { positional } = parseFlags(args);
  const targetId = positional[0];
  if (!targetId) {
    deps.stderr("error: targetId is required\nUsage: scraper page <targetId>\n");
    return 1;
  }

  try {
    await deps.selectPage(targetId);
    deps.stdout(`switched to page ${targetId}\n`);
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handleClick(args: string[], deps: CliDeps): Promise<number> {
  const { flags } = parseFlags(args);
  const [target, targetErr] = parseTarget(flags);
  if (targetErr) {
    deps.stderr(`error: ${targetErr}\nUsage: scraper click --ref <ref> | --selector <css>\n`);
    return 1;
  }

  const includeSnapshot = flagBoolean(flags, "snapshot");

  try {
    const result = await deps.click(target!, { includeSnapshot });
    const label = "ref" in target! ? `ref ${target!.ref}` : `selector "${target!.selector}"`;
    if (result.snapshot) {
      outputActionResult(result, `clicked ${label}`, deps);
    } else {
      deps.stdout(`clicked ${label}\n`);
    }
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handleFill(args: string[], deps: CliDeps): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const [target, targetErr] = parseTarget(flags);
  if (targetErr) {
    deps.stderr(
      `error: ${targetErr}\nUsage: scraper fill --ref <ref> | --selector <css> <value>\n`,
    );
    return 1;
  }

  const value = positional[0];
  if (value === undefined) {
    deps.stderr("error: value is required\nUsage: scraper fill --ref <ref> <value>\n");
    return 1;
  }

  const includeSnapshot = flagBoolean(flags, "snapshot");

  try {
    const result = await deps.fill(target!, value, { includeSnapshot });
    const label = "ref" in target! ? `ref ${target!.ref}` : `selector "${target!.selector}"`;
    if (result.snapshot) {
      outputActionResult(result, `filled ${label}`, deps);
    } else {
      deps.stdout(`filled ${label}\n`);
    }
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
        "Usage: scraper wait --selector <css> | --text '<text>' | --ref <ref> --text '<text>'\n",
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

  const target: import("../domain/mod.ts").ElementTarget | undefined = ref
    ? { ref }
    : selector
    ? { selector }
    : undefined;

  try {
    await deps.wait({ target, text, timeoutMs });
    if (text && target) {
      const label = "ref" in target ? `ref ${target.ref}` : `selector "${target.selector}"`;
      deps.stdout(`found text "${text}" in ${label}\n`);
    } else if (text) {
      deps.stdout(`found text "${text}"\n`);
    } else if (target && "selector" in target) {
      deps.stdout(`found element matching "${target.selector}"\n`);
    }
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handleType(args: string[], deps: CliDeps): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const [target, targetErr] = parseTarget(flags);
  if (targetErr) {
    deps.stderr(
      `error: ${targetErr}\nUsage: scraper type --ref <ref> | --selector <css> <text>\n`,
    );
    return 1;
  }

  const text = positional[0];
  if (text === undefined) {
    deps.stderr("error: text is required\nUsage: scraper type --ref <ref> <text>\n");
    return 1;
  }

  const includeSnapshot = flagBoolean(flags, "snapshot");

  try {
    const result = await deps.type(target!, text, { includeSnapshot });
    const label = "ref" in target! ? `ref ${target!.ref}` : `selector "${target!.selector}"`;
    if (result.snapshot) {
      outputActionResult(result, `typed into ${label}`, deps);
    } else {
      deps.stdout(`typed into ${label}\n`);
    }
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handleSelect(args: string[], deps: CliDeps): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const [target, targetErr] = parseTarget(flags);
  if (targetErr) {
    deps.stderr(
      `error: ${targetErr}\nUsage: scraper select --ref <ref> | --selector <css> <value>\n`,
    );
    return 1;
  }

  const value = positional[0];
  if (value === undefined) {
    deps.stderr("error: value is required\nUsage: scraper select --ref <ref> <value>\n");
    return 1;
  }

  const includeSnapshot = flagBoolean(flags, "snapshot");

  try {
    const result = await deps.selectOption(target!, value, { includeSnapshot });
    const label = "ref" in target! ? `ref ${target!.ref}` : `selector "${target!.selector}"`;
    if (result.snapshot) {
      outputActionResult(result, `selected "${value}" in ${label}`, deps);
    } else {
      deps.stdout(`selected "${value}" in ${label}\n`);
    }
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handleSubmit(args: string[], deps: CliDeps): Promise<number> {
  const { flags } = parseFlags(args);
  const [target, targetErr] = parseTarget(flags);
  if (targetErr) {
    deps.stderr(
      `error: ${targetErr}\nUsage: scraper submit --ref <ref> | --selector <css>\n`,
    );
    return 1;
  }

  const includeSnapshot = flagBoolean(flags, "snapshot");

  try {
    const result = await deps.submit(target!, { includeSnapshot });
    const label = "ref" in target! ? `ref ${target!.ref}` : `selector "${target!.selector}"`;
    if (result.snapshot) {
      outputActionResult(result, `submitted ${label}`, deps);
    } else {
      deps.stdout(`submitted ${label}\n`);
    }
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

async function handlePressKey(args: string[], deps: CliDeps): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const key = positional[0];
  if (!key) {
    deps.stderr(
      "error: key is required\nUsage: scraper press-key <key> [--ref <ref> | --selector <css>]\n",
    );
    return 1;
  }

  const ref = flagString(flags, "ref");
  const selector = flagString(flags, "selector");

  if (ref && selector) {
    deps.stderr("error: provide either --ref or --selector, not both\n");
    return 1;
  }

  const target: ElementTarget | undefined = ref ? { ref } : selector ? { selector } : undefined;

  const includeSnapshot = flagBoolean(flags, "snapshot");

  try {
    const result = await deps.pressKey(key, target, { includeSnapshot });
    let statusLine: string;
    if (target) {
      const label = "ref" in target ? `ref ${target.ref}` : `selector "${target.selector}"`;
      statusLine = `pressed ${key} on ${label}`;
    } else {
      statusLine = `pressed ${key}`;
    }
    if (result.snapshot) {
      outputActionResult(result, statusLine, deps);
    } else {
      deps.stdout(statusLine + "\n");
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
    case "start":
      return handleStart(rest, deps);
    case "stop":
      return handleStop(deps);
    case "navigate":
      return handleNavigate(rest, deps);
    case "snapshot":
      return handleSnapshot(rest, deps);
    case "eval":
      return handleEval(rest, deps);
    case "screenshot":
      return handleScreenshot(rest, deps);
    case "pages":
      return handlePages(deps);
    case "page":
      return handlePage(rest, deps);
    case "click":
      return handleClick(rest, deps);
    case "fill":
      return handleFill(rest, deps);
    case "type":
      return handleType(rest, deps);
    case "select":
      return handleSelect(rest, deps);
    case "submit":
      return handleSubmit(rest, deps);
    case "press-key":
      return handlePressKey(rest, deps);
    case "wait":
      return handleWait(rest, deps);
    default:
      deps.stderr(`error: unknown command '${command}'\n${USAGE}`);
      return Promise.resolve(1);
  }
}
