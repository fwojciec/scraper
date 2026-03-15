// Adapter: CLI (Deno.args). Direct CDP operations, no HTTP server.

import type { PageInfo, SnapshotOptions, SnapshotResult } from "../domain/mod.ts";

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
  navigate(url: string): Promise<void>;
  snapshot(opts: SnapshotOptions): Promise<SnapshotResult>;
  evaluate(expression: string): Promise<{ result: unknown }>;
  screenshot(fullPage?: boolean): Promise<string>;
  listPages(): Promise<PageInfo[]>;
  selectPage(targetId: string): Promise<void>;
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
  const { positional } = parseFlags(args);
  const url = positional[0];
  if (!url) {
    deps.stderr("error: url is required\nUsage: scraper navigate <url>\n");
    return 1;
  }

  try {
    await deps.navigate(url);
    deps.stdout(`navigated to ${url}\n`);
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
    default:
      deps.stderr(`error: unknown command '${command}'\n${USAGE}`);
      return Promise.resolve(1);
  }
}
