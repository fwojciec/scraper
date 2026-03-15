/** Attach to a user's running Chrome via DevToolsActivePort. */

export interface DevToolsActivePort {
  port: number;
  wsPath: string;
}

/**
 * Read Chrome's DevToolsActivePort file from the given user data directory.
 * Returns the port and WebSocket path for connecting to the browser.
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
      throw new Error(
        "DevToolsActivePort not found — enable remote debugging in chrome://inspect/#remote-debugging",
      );
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
      return "Google Chrome Beta";
    case "canary":
      return "Google Chrome Canary";
    case "dev":
      return "Google Chrome Dev";
    case "stable":
    case undefined:
      return "Google Chrome";
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
