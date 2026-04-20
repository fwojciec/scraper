/** Shared test-runtime helpers: run scraper subprocess, attach to a test Chrome. */

import { launchTestChrome, type TestChrome } from "./test-chrome.ts";

export async function denoDir(): Promise<string> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  });
  const { stdout } = await cmd.output();
  return JSON.parse(new TextDecoder().decode(stdout)).denoDir;
}

export async function runScraper(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "src/main.ts", ...args],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

export interface TestRuntime {
  env: Record<string, string>;
  chrome: TestChrome;
  tmpHome: string;
  targetId: string;
}

/** Discover the initial page target by polling Chrome's /json/list. */
async function discoverPageTarget(port: number): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        // deno-lint-ignore no-explicit-any
        const pageTarget = targets.find((t: any) => t.type === "page");
        if (pageTarget) return pageTarget.id;
      } else {
        await res.body?.cancel();
      }
    } catch { /* transport failure, retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("no page target found");
}

/**
 * Launch a test Chrome, point scraper at it, and return the initial page's
 * full targetId so callers can pass it via `--tab`. Tier B has no persisted
 * active target — every command addresses a tab explicitly.
 */
export async function startTestRuntime(): Promise<TestRuntime> {
  const tmpHome = await Deno.makeTempDir();
  const chrome = await launchTestChrome();
  const env = {
    ...Deno.env.toObject(),
    HOME: tmpHome,
    DENO_DIR: await denoDir(),
    SCRAPER_USER_DATA_DIR: chrome.userDataDir,
  };
  let targetId: string;
  try {
    targetId = await discoverPageTarget(chrome.port);
  } catch (err) {
    await stopTestRuntime({ chrome, tmpHome, env, targetId: "" });
    throw err;
  }
  return { env, chrome, tmpHome, targetId };
}

export async function stopTestRuntime(rt: {
  chrome: TestChrome;
  tmpHome: string;
  env?: Record<string, string>;
  targetId?: string;
}): Promise<void> {
  const { killTestChrome } = await import("./test-chrome.ts");
  try {
    await killTestChrome(rt.chrome);
  } catch { /* best effort */ }
  try {
    await Deno.remove(rt.tmpHome, { recursive: true });
  } catch { /* best effort */ }
}
