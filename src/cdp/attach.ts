/** Attach to a user's running Chrome via DevToolsActivePort. */

export interface DevToolsActivePort {
  port: number;
  wsPath: string;
}

/**
 * Locate the running Chrome's DevTools WebSocket.
 *
 * Tries two mechanisms, in order:
 *   1. `DevToolsActivePort` in the user data dir (written when Chrome is
 *      launched with `--remote-debugging-port=<n>`).
 *   2. HTTP discovery via `/json/version` on `SCRAPER_DEBUG_PORT` (default
 *      9222) — for a CDP server running on a known port when the file is
 *      unavailable. Note: the `chrome://inspect` "Remote debugging" toggle
 *      runs Chrome's MCP server on 9222, NOT a CDP server, so this fallback
 *      does not rescue that case.
 */
export async function readDevToolsActivePort(
  userDataDir: string,
): Promise<DevToolsActivePort> {
  const filePath = `${userDataDir}/DevToolsActivePort`;
  let content: string;
  try {
    content = await Deno.readTextFile(filePath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return await discoverViaHttp();
    }
    throw e;
  }
  const lines = content.trim().split("\n");
  if (lines.length < 2) {
    throw new Error(`DevToolsActivePort has unexpected format: ${content.trim()}`);
  }
  const port = parseInt(lines[0], 10);
  if (isNaN(port)) {
    throw new Error(`DevToolsActivePort has non-numeric port: ${lines[0]}`);
  }
  const wsPath = lines[1];
  return { port, wsPath };
}

async function discoverViaHttp(): Promise<DevToolsActivePort> {
  const portEnv = Deno.env.get("SCRAPER_DEBUG_PORT");
  if (portEnv === "") {
    throw notFoundError();
  }
  const port = portEnv === undefined ? 9222 : parseInt(portEnv, 10);
  if (isNaN(port)) {
    throw new Error(`SCRAPER_DEBUG_PORT has non-numeric value: ${portEnv}`);
  }
  const url = `http://127.0.0.1:${port}/json/version`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw notFoundError();
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw notFoundError();
  }
  const body = await res.json() as { webSocketDebuggerUrl?: unknown };
  const wsUrl = body.webSocketDebuggerUrl;
  if (typeof wsUrl !== "string") {
    throw new Error(`/json/version missing webSocketDebuggerUrl at ${url}`);
  }
  return parseBrowserWsUrl(wsUrl);
}

function notFoundError(): Error {
  return new Error(
    "DevToolsActivePort not found and no CDP server responding on " +
      "SCRAPER_DEBUG_PORT (default 9222) — relaunch Chrome with " +
      "--remote-debugging-port=0 so it writes the port file. " +
      "Note: the chrome://inspect 'Remote debugging' toggle serves an MCP " +
      "endpoint on 9222, not CDP, and is not compatible with scraper.",
  );
}

/** Parse a `ws://host:port/path` URL into `{ port, wsPath }`. */
export function parseBrowserWsUrl(wsUrl: string): DevToolsActivePort {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    throw new Error(`could not parse ws URL: ${wsUrl}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`expected ws:// URL, got ${wsUrl}`);
  }
  if (!url.port) {
    throw new Error(`ws URL missing port: ${wsUrl}`);
  }
  const port = parseInt(url.port, 10);
  if (isNaN(port)) {
    throw new Error(`ws URL has non-numeric port: ${wsUrl}`);
  }
  const wsPath = url.pathname + url.search;
  return { port, wsPath };
}

/** Get the default Chrome user data directory for the current platform and channel. */
export function defaultUserDataDir(channel?: string, os?: string): string {
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME environment variable is not set");

  const platform = os ?? Deno.build.os;

  if (platform === "darwin") {
    return `${home}/Library/Application Support/${chromeDirMac(channel)}`;
  }
  if (platform === "linux") {
    return `${home}/.config/${chromeDirLinux(channel)}`;
  }
  throw new Error(`unsupported platform: ${platform}`);
}

function chromeDirMac(channel?: string): string {
  switch (channel) {
    case "beta":
      return "Google/Chrome Beta";
    case "canary":
      return "Google/Chrome Canary";
    case "dev":
      return "Google/Chrome Dev";
    case "stable":
    case undefined:
      return "Google/Chrome";
    default:
      throw new Error(`unknown Chrome channel: ${channel}`);
  }
}

function chromeDirLinux(channel?: string): string {
  switch (channel) {
    case "beta":
      return "google-chrome-beta";
    case "dev":
      return "google-chrome-unstable";
    case "canary":
      throw new Error("Chrome Canary is not available on Linux");
    case "stable":
    case undefined:
      return "google-chrome";
    default:
      throw new Error(`unknown Chrome channel: ${channel}`);
  }
}
