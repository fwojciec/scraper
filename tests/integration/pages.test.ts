/** Integration tests for page management: pages, page commands. */

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

Deno.test("pages lists the default tab in owned mode", async () => {
  const tmpHome = await Deno.makeTempDir();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    const pages = await runScraper(["pages"], env);
    assertEquals(pages.code, 0, `pages failed: ${pages.stderr}`);
    // Should list at least one page (the default about:blank tab)
    assert(pages.stdout.includes("about:blank"), `expected about:blank in: ${pages.stdout}`);
    // The default tab should be marked as active
    assert(pages.stdout.includes("*"), `expected active marker in: ${pages.stdout}`);

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

Deno.test("page switch and navigate work across tabs", async () => {
  const tmpHome = await Deno.makeTempDir();
  const fixtures = startFixtureServer();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    // Start Chrome
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    // Navigate default tab
    const nav = await runScraper(
      ["navigate", fixtures.url("bestseller-table.html")],
      env,
    );
    assertEquals(nav.code, 0, `navigate failed: ${nav.stderr}`);

    // List pages — should show our page
    const pages1 = await runScraper(["pages"], env);
    assertEquals(pages1.code, 0, `pages failed: ${pages1.stderr}`);
    assertStringIncludes(pages1.stdout, "bestseller-table.html");

    // Extract targetId from output — format: "* <targetId>  <title>  <url>"
    const lines = pages1.stdout.trim().split("\n");
    const activeLine = lines.find((l) => l.startsWith("*"));
    assert(activeLine, "should have an active page");
    const activeTargetId = activeLine.replace("*", "").trim().split(/\s+/)[0];

    // Switch to same page (should work without error)
    const pageCmd = await runScraper(["page", activeTargetId], env);
    assertEquals(pageCmd.code, 0, `page failed: ${pageCmd.stderr}`);
    assertStringIncludes(pageCmd.stdout, "switched to page");

    // Snapshot should work after page switch
    const snap = await runScraper(["snapshot"], env);
    assertEquals(snap.code, 0, `snapshot failed: ${snap.stderr}`);
    assert(snap.stdout.includes("table"), "snapshot should contain table role");

    const stop = await runScraper(["stop"], env);
    assertEquals(stop.code, 0, `stop failed: ${stop.stderr}`);
  } finally {
    try {
      const stateText = await Deno.readTextFile(`${tmpHome}/.scraper/chrome.json`);
      const state = JSON.parse(stateText);
      if (state.chromePid) Deno.kill(state.chromePid, "SIGTERM");
    } catch { /* state may not exist or Chrome may be dead */ }
    await fixtures.close();
    try {
      await Deno.remove(tmpHome, { recursive: true });
    } catch { /* best effort */ }
  }
});

Deno.test("page with invalid targetId returns error", async () => {
  const tmpHome = await Deno.makeTempDir();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    const page = await runScraper(["page", "nonexistent-id"], env);
    assertEquals(page.code, 1);
    assertStringIncludes(page.stderr, "no page with targetId");

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

Deno.test("navigate invalidates refs", async () => {
  const tmpHome = await Deno.makeTempDir();
  const fixtures = startFixtureServer();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    // Navigate and snapshot to create refs
    await runScraper(["navigate", fixtures.url("bestseller-table.html")], env);
    const snap = await runScraper(["snapshot"], env);
    assertEquals(snap.code, 0, `snapshot failed: ${snap.stderr}`);

    // Verify refs.json exists
    const refsText = await Deno.readTextFile(`${tmpHome}/.scraper/refs.json`);
    const refs = JSON.parse(refsText);
    assert(Object.keys(refs).length > 0, "refs should not be empty after snapshot");

    // Navigate again — should invalidate refs
    await runScraper(["navigate", "about:blank"], env);

    // Verify refs.json is gone
    try {
      await Deno.stat(`${tmpHome}/.scraper/refs.json`);
      throw new Error("refs.json should have been removed after navigate");
    } catch (e) {
      assert(e instanceof Deno.errors.NotFound, "refs.json should not exist after navigate");
    }

    const stop = await runScraper(["stop"], env);
    assertEquals(stop.code, 0, `stop failed: ${stop.stderr}`);
  } finally {
    try {
      const stateText = await Deno.readTextFile(`${tmpHome}/.scraper/chrome.json`);
      const state = JSON.parse(stateText);
      if (state.chromePid) Deno.kill(state.chromePid, "SIGTERM");
    } catch { /* state may not exist or Chrome may be dead */ }
    await fixtures.close();
    try {
      await Deno.remove(tmpHome, { recursive: true });
    } catch { /* best effort */ }
  }
});

Deno.test("state file includes mode field", async () => {
  const tmpHome = await Deno.makeTempDir();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    const stateText = await Deno.readTextFile(`${tmpHome}/.scraper/chrome.json`);
    const state = JSON.parse(stateText);
    assertEquals(state.mode, "owned");
    assert(state.chromePid, "should have chromePid");
    assert(state.cdpPort, "should have cdpPort");
    assert(state.userDataDir, "should have userDataDir");
    assert(state.targetId, "should have targetId");

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
