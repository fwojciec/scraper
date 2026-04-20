/** Test-only headless Chrome launcher for integration tests. */

export interface TestChrome {
  pid: number;
  port: number;
  userDataDir: string;
  process: Deno.ChildProcess;
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
      const which = new Deno.Command("which", { args: [p], stdout: "null", stderr: "null" });
      const { success } = which.outputSync();
      if (success) return p;
    } catch {
      continue;
    }
  }
  throw new Error("Chrome not found. Set chromePath option.");
}

/** Poll for DevToolsActivePort, then verify /json/version responds. */
async function waitForDevToolsPort(
  userDataDir: string,
  maxRetries = 40,
  delay = 250,
): Promise<number> {
  const portFile = `${userDataDir}/DevToolsActivePort`;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const content = await Deno.readTextFile(portFile);
      const lines = content.trim().split("\n");
      if (lines.length >= 2) {
        const port = parseInt(lines[0], 10);
        if (!isNaN(port)) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            await res.body?.cancel();
            if (res.ok) return port;
          } catch {
            // CDP server not reachable yet
          }
        }
      }
    } catch {
      // File not written yet
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`Chrome did not write DevToolsActivePort in ${userDataDir}`);
}

export interface LaunchOptions {
  chromePath?: string;
  userDataDir?: string;
}

/**
 * Launch headless Chrome with `--remote-debugging-port=0` so Chrome writes
 * DevToolsActivePort to the user-data-dir — which is how the scraper (and real
 * Chrome users) discover the port.
 */
export async function launchTestChrome(options?: LaunchOptions): Promise<TestChrome> {
  const chromePath = options?.chromePath ?? findChromePath();
  const userDataDir = options?.userDataDir ?? Deno.makeTempDirSync({ prefix: "scraper-test-" });

  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
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
    "about:blank",
  ];

  const command = new Deno.Command(chromePath, { args, stdout: "null", stderr: "null" });
  const process = command.spawn();

  try {
    const port = await waitForDevToolsPort(userDataDir);
    return { pid: process.pid, port, userDataDir, process };
  } catch (err) {
    try {
      process.kill("SIGTERM");
    } catch { /* already dead */ }
    try {
      await process.status;
    } catch { /* already exited */ }
    try {
      await Deno.remove(userDataDir, { recursive: true });
    } catch { /* best effort */ }
    throw err;
  }
}

export async function killTestChrome(chrome: TestChrome): Promise<void> {
  try {
    chrome.process.kill("SIGTERM");
  } catch {
    // Already dead
  }
  try {
    await chrome.process.status;
  } catch {
    // Already exited
  }
  try {
    await Deno.remove(chrome.userDataDir, { recursive: true });
  } catch {
    // Best effort cleanup
  }
}
