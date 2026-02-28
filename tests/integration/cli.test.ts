/** CLI E2E smoke test: exercises the full public surface through main.ts. */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { startFixtureServer } from "./fixture-server.ts";

/** Resolve Deno's cache directory so it survives HOME override. */
async function denoDir(): Promise<string> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  });
  const { stdout } = await cmd.output();
  return JSON.parse(new TextDecoder().decode(stdout)).denoDir;
}

async function runScraper(
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

Deno.test("CLI E2E: start → navigate → snapshot → eval → screenshot → stop", async () => {
  const tmpHome = await Deno.makeTempDir();
  const fixtures = startFixtureServer();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    // Start Chrome
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);
    assertStringIncludes(start.stdout, "chrome started");

    // Start again — should report already running
    const start2 = await runScraper(["start"], env);
    assertEquals(start2.code, 0, `start2 failed: ${start2.stderr}`);
    assertStringIncludes(start2.stdout, "already running");

    // Navigate to fixture page
    const nav = await runScraper(
      ["navigate", fixtures.url("bestseller-table.html")],
      env,
    );
    assertEquals(nav.code, 0, `navigate failed: ${nav.stderr}`);
    assertStringIncludes(nav.stdout, "navigated to");

    // Snapshot
    const snap = await runScraper(["snapshot"], env);
    assertEquals(snap.code, 0, `snapshot failed: ${snap.stderr}`);
    assert(snap.stdout.includes("table"), "snapshot should contain table role");

    // Eval
    const evalResult = await runScraper(
      ["eval", "document.querySelector('h1').textContent"],
      env,
    );
    assertEquals(evalResult.code, 0, `eval failed: ${evalResult.stderr}`);
    assertStringIncludes(evalResult.stdout, "Top Bestselling Books");

    // Screenshot
    const shot = await runScraper(["screenshot"], env);
    assertEquals(shot.code, 0, `screenshot failed: ${shot.stderr}`);
    const screenshotPath = shot.stdout.trim();
    assert(screenshotPath.endsWith(".png"), "should produce a .png file");
    const stat = await Deno.stat(screenshotPath);
    assert(stat.size > 0, "screenshot file should not be empty");
    await Deno.remove(screenshotPath);

    // Stop
    const stop = await runScraper(["stop"], env);
    assertEquals(stop.code, 0, `stop failed: ${stop.stderr}`);
    assertStringIncludes(stop.stdout, "chrome stopped");

    // State file should be gone
    try {
      await Deno.stat(`${tmpHome}/.scraper/chrome.json`);
      throw new Error("state file should have been removed");
    } catch (e) {
      assert(e instanceof Deno.errors.NotFound, "state file should not exist after stop");
    }

    // Stop again — should error
    const stop2 = await runScraper(["stop"], env);
    assertEquals(stop2.code, 1);
    assertStringIncludes(stop2.stderr, "chrome is not running");
  } finally {
    // Best-effort cleanup: read state and kill Chrome if still running
    try {
      const stateText = await Deno.readTextFile(`${tmpHome}/.scraper/chrome.json`);
      const state = JSON.parse(stateText);
      if (state.chromePid) {
        Deno.kill(state.chromePid, "SIGTERM");
      }
    } catch { /* state may not exist or Chrome may be dead */ }
    await fixtures.close();
    try {
      await Deno.remove(tmpHome, { recursive: true });
    } catch { /* best effort */ }
  }
});

Deno.test("CLI E2E: start recovers after Chrome crashes", async () => {
  const tmpHome = await Deno.makeTempDir();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    // Start Chrome
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    // Kill Chrome out-of-band (simulate crash)
    const stateText = await Deno.readTextFile(`${tmpHome}/.scraper/chrome.json`);
    const state = JSON.parse(stateText);
    Deno.kill(state.chromePid, "SIGKILL");
    // Wait for process to die
    for (let i = 0; i < 20; i++) {
      try {
        const cmd = new Deno.Command("kill", { args: ["-0", String(state.chromePid)] });
        if (cmd.outputSync().code !== 0) break;
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // State file still exists (no graceful shutdown happened)
    const staleState = await Deno.stat(`${tmpHome}/.scraper/chrome.json`);
    assert(staleState.isFile, "state file should still exist after crash");

    // Start again — should detect dead Chrome, clean up, and launch fresh
    const start2 = await runScraper(["start"], env);
    assertEquals(start2.code, 0, `recovery start failed: ${start2.stderr}`);
    assertStringIncludes(start2.stdout, "chrome started");

    // Verify the new Chrome works
    const nav = await runScraper(
      ["navigate", "data:text/html,<h1>Recovered</h1>"],
      env,
    );
    assertEquals(nav.code, 0, `navigate after recovery failed: ${nav.stderr}`);

    const evalResult = await runScraper(
      ["eval", "document.querySelector('h1').textContent"],
      env,
    );
    assertEquals(evalResult.code, 0, `eval after recovery failed: ${evalResult.stderr}`);
    assertStringIncludes(evalResult.stdout, "Recovered");

    // Clean stop
    const stop = await runScraper(["stop"], env);
    assertEquals(stop.code, 0, `stop failed: ${stop.stderr}`);
  } finally {
    try {
      const stateText = await Deno.readTextFile(`${tmpHome}/.scraper/chrome.json`);
      const state = JSON.parse(stateText);
      if (state.chromePid) Deno.kill(state.chromePid, "SIGTERM");
    } catch { /* state may not exist or Chrome may be dead */ }
    try {
      await Deno.remove(tmpHome, { recursive: true });
    } catch { /* best effort */ }
  }
});
