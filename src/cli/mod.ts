// Adapter: CLI (Deno.args). Stateless HTTP client to daemon.

/** PID file format written by the daemon and read by CLI commands. */
export interface PidFile {
  pid: number;
  port: number;
  cdpPort: number;
}

/** Options for the start command. */
export interface StartOptions {
  port: number;
  chromePath?: string;
  evalTimeout?: number;
}

/** Dependencies injected from main.ts composition root. */
export interface CliDeps {
  fetch: typeof globalThis.fetch;
  readPidFile(): Promise<PidFile | null>;
  writePidFile(pf: PidFile): Promise<void>;
  removePidFile(): Promise<void>;
  isProcessAlive(pid: number): boolean;
  killProcess(pid: number): void;
  spawnDaemon(opts: StartOptions): Promise<PidFile>;
  stdout(s: string): void;
  stderr(s: string): void;
}

const USAGE = `Usage: scraper <command> [options]

Commands:
  start       Launch the daemon (Chrome + HTTP server)
  stop        Stop the daemon
  navigate    Navigate a page to a URL
  pages       List open pages
  snapshot    Generate an ARIA snapshot
  eval        Evaluate JavaScript in a page
  screenshot  Capture a screenshot
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

async function daemonFetch(
  deps: CliDeps,
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const pf = await deps.readPidFile();
  if (!pf) {
    deps.stderr("error: daemon is not running (no PID file)\n");
    return null;
  }
  try {
    return await deps.fetch(`http://127.0.0.1:${pf.port}${path}`, init);
  } catch (err) {
    deps.stderr(
      `error: cannot connect to daemon: ${err instanceof Error ? err.message : err}\n`,
    );
    return null;
  }
}

async function handleDaemonResponse(
  deps: CliDeps,
  res: Response,
): Promise<unknown | null> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "unknown error" }));
    deps.stderr(`error: ${body.error ?? "unknown error"}\n`);
    return null;
  }
  return await res.json();
}

async function handleStart(args: string[], deps: CliDeps): Promise<number> {
  const { flags } = parseFlags(args);
  const [port = 3222, portErr] = flagNumber(flags, "port");
  if (portErr) {
    deps.stderr(`error: ${portErr}\n`);
    return 1;
  }
  const chromePath = flagString(flags, "chrome-path");
  const [evalTimeout, etErr] = flagNumber(flags, "eval-timeout");
  if (etErr) {
    deps.stderr(`error: ${etErr}\n`);
    return 1;
  }

  const existing = await deps.readPidFile();
  if (existing) {
    if (deps.isProcessAlive(existing.pid)) {
      deps.stdout(
        `daemon already running (pid ${existing.pid}, port ${existing.port})\n`,
      );
      return 0;
    }
    await deps.removePidFile();
  }

  let pf: PidFile | undefined;
  try {
    pf = await deps.spawnDaemon({ port, chromePath, evalTimeout });
    await deps.writePidFile(pf);
    deps.stdout(`daemon started (pid ${pf.pid}, port ${pf.port})\n`);
    return 0;
  } catch (err) {
    if (pf) {
      try {
        deps.killProcess(pf.pid);
      } catch { /* already dead */ }
    }
    deps.stderr(
      `error: failed to start daemon: ${err instanceof Error ? err.message : err}\n`,
    );
    return 1;
  }
}

async function handleStop(deps: CliDeps): Promise<number> {
  const pf = await deps.readPidFile();
  if (!pf) {
    deps.stderr("error: daemon is not running (no PID file)\n");
    return 1;
  }

  try {
    const res = await deps.fetch(`http://127.0.0.1:${pf.port}/shutdown`, {
      method: "POST",
    });
    if (!res.ok) {
      deps.stderr("warning: daemon returned non-ok on shutdown\n");
    }
  } catch {
    // Daemon unreachable — either already dead or PID is stale.
    // Do NOT SIGTERM: we cannot verify the PID still belongs to the daemon,
    // so signaling it risks killing an unrelated process.
    deps.stderr("warning: daemon unreachable, cleaning up stale PID file\n");
  }

  await deps.removePidFile();
  deps.stdout("daemon stopped\n");
  return 0;
}

async function handleNavigate(args: string[], deps: CliDeps): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const url = positional[0];
  if (!url) {
    deps.stderr("error: url is required\nUsage: scraper navigate <url> [--name N]\n");
    return 1;
  }
  const name = flagString(flags, "name");
  const body: Record<string, unknown> = { url };
  if (name) body.name = name;

  const res = await daemonFetch(deps, "/pages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res) return 1;

  const data = await handleDaemonResponse(deps, res);
  if (!data) return 1;

  const page = data as { name: string; url: string };
  deps.stdout(`${page.name}\t${page.url}\n`);
  return 0;
}

async function handlePages(deps: CliDeps): Promise<number> {
  const res = await daemonFetch(deps, "/pages");
  if (!res) return 1;

  const data = await handleDaemonResponse(deps, res);
  if (!data) return 1;

  const pages = data as Array<{ name: string; url: string }>;
  if (pages.length === 0) {
    deps.stdout("(no pages)\n");
    return 0;
  }

  const nameWidth = Math.max(4, ...pages.map((p) => p.name.length));
  deps.stdout(`${"NAME".padEnd(nameWidth)}  URL\n`);
  for (const p of pages) {
    deps.stdout(`${p.name.padEnd(nameWidth)}  ${p.url}\n`);
  }
  return 0;
}

async function handleSnapshot(args: string[], deps: CliDeps): Promise<number> {
  const { flags } = parseFlags(args);
  const body: Record<string, unknown> = {};
  const name = flagString(flags, "name");
  if (name) body.name = name;
  const [maxDepth, mdErr] = flagNumber(flags, "max-depth");
  if (mdErr) {
    deps.stderr(`error: ${mdErr}\n`);
    return 1;
  }
  if (maxDepth !== undefined) body.maxDepth = maxDepth;
  const [maxNodes, mnErr] = flagNumber(flags, "max-nodes");
  if (mnErr) {
    deps.stderr(`error: ${mnErr}\n`);
    return 1;
  }
  if (maxNodes !== undefined) body.maxNodes = maxNodes;
  const selector = flagString(flags, "selector");
  if (selector) body.selector = selector;

  const res = await daemonFetch(deps, "/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res) return 1;

  const data = await handleDaemonResponse(deps, res);
  if (!data) return 1;

  const { yaml } = data as { yaml: string };
  deps.stdout(yaml);
  return 0;
}

async function handleEval(args: string[], deps: CliDeps): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const expression = positional[0];
  if (!expression) {
    deps.stderr(
      "error: expression is required\nUsage: scraper eval '<expression>' [--name N]\n",
    );
    return 1;
  }
  const name = flagString(flags, "name");
  const body: Record<string, unknown> = { expression };
  if (name) body.name = name;

  const res = await daemonFetch(deps, "/eval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res) return 1;

  const data = await handleDaemonResponse(deps, res);
  if (!data) return 1;

  const { result } = data as { result: unknown };
  deps.stdout(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

async function handleScreenshot(args: string[], deps: CliDeps): Promise<number> {
  const { flags } = parseFlags(args);
  const name = flagString(flags, "name");
  const fullPage = flagBoolean(flags, "full-page");
  const body: Record<string, unknown> = {};
  if (name) body.name = name;
  if (fullPage) body.fullPage = true;

  const res = await daemonFetch(deps, "/screenshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res) return 1;

  const data = await handleDaemonResponse(deps, res);
  if (!data) return 1;

  const { path } = data as { path: string };
  deps.stdout(path + "\n");
  return 0;
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
    case "pages":
      return handlePages(deps);
    case "snapshot":
      return handleSnapshot(rest, deps);
    case "eval":
      return handleEval(rest, deps);
    case "screenshot":
      return handleScreenshot(rest, deps);
    default:
      deps.stderr(`error: unknown command '${command}'\n${USAGE}`);
      return Promise.resolve(1);
  }
}
