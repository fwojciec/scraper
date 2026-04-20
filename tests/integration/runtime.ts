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

/**
 * Launch a test Chrome, point scraper at it, and select the initial page.
 * Every scraper command is a separate process that attaches via DevToolsActivePort.
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
  // Select the initial about:blank page so subsequent commands have a target.
  const pages = await runScraper(["pages"], env);
  if (pages.code !== 0) {
    await stopTestRuntime({ chrome, tmpHome, env, targetId: "" });
    throw new Error(`pages failed during setup: ${pages.stderr}`);
  }
  // pages output is "  <targetId>  <title>  <url>"; first non-empty column is targetId.
  const firstLine = pages.stdout.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) {
    await stopTestRuntime({ chrome, tmpHome, env, targetId: "" });
    throw new Error(`no pages listed in test Chrome: ${pages.stdout}`);
  }
  const targetId = firstLine.replace(/^\*?\s*/, "").split(/\s+/)[0];
  const page = await runScraper(["page", targetId], env);
  if (page.code !== 0) {
    await stopTestRuntime({ chrome, tmpHome, env, targetId });
    throw new Error(`page failed during setup: ${page.stderr}`);
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
