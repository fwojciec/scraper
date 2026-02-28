/** Launch and kill headless Chrome with a dynamically allocated debugging port. */

export interface ChromeProcess {
  pid: number;
  port: number;
  process: Deno.ChildProcess;
  userDataDir: string;
}

export interface LaunchOptions {
  chromePath?: string;
  headless?: boolean;
}

/** Find a free TCP port by binding to :0 and reading the assigned port.
 *  Note: TOCTOU race exists between close and Chrome bind — unlikely in practice. */
function findFreePort(): number {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

/** Wait for Chrome's /json/version endpoint to become available. */
async function waitForChrome(port: number, maxRetries = 40, delay = 250): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      await res.body?.cancel();
      if (res.ok) return;
    } catch {
      // Chrome not ready yet
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`Chrome did not start on port ${port} after ${maxRetries} retries`);
}

function findChromePath(): string {
  const candidates: Record<string, string[]> = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    linux: [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
    ],
  };
  const os = Deno.build.os;
  const paths = candidates[os] ?? candidates["linux"];
  for (const p of paths) {
    try {
      if (p.startsWith("/")) {
        Deno.statSync(p);
        return p;
      }
      // Bare command name — verify it exists in PATH
      const which = new Deno.Command("which", { args: [p], stdout: "null", stderr: "null" });
      const { success } = which.outputSync();
      if (success) return p;
    } catch {
      continue;
    }
  }
  throw new Error("Chrome not found. Set chromePath option.");
}

/** Launch headless Chrome with a dynamic debugging port. */
export async function launchChrome(options?: LaunchOptions): Promise<ChromeProcess> {
  const port = findFreePort();
  const chromePath = options?.chromePath ?? findChromePath();
  const headless = options?.headless ?? true;

  const userDataDir = Deno.makeTempDirSync({ prefix: "scraper-chrome-" });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-translate",
    "--mute-audio",
    "--no-sandbox",
    "--use-mock-keychain",
  ];
  if (headless) {
    args.unshift("--headless=new");
  }
  args.push("about:blank");

  const command = new Deno.Command(chromePath, {
    args,
    stdout: "null",
    stderr: "null",
  });
  const process = command.spawn();
  const chrome: ChromeProcess = { pid: process.pid, port, process, userDataDir };

  try {
    await waitForChrome(port);
  } catch (error) {
    await killChrome(chrome);
    throw error;
  }

  return chrome;
}

/** Kill a Chrome process and clean up its user data directory. */
export async function killChrome(chrome: ChromeProcess): Promise<void> {
  try {
    chrome.process.kill("SIGTERM");
  } catch {
    // Already dead
  }
  // Wait for process to exit to avoid zombies
  try {
    await chrome.process.status;
  } catch {
    // Process already exited
  }
  try {
    await Deno.remove(chrome.userDataDir, { recursive: true });
  } catch {
    // Best effort cleanup
  }
}
