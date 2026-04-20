/** CLI E2E smoke test: exercises the full public surface through main.ts. */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { startFixtureServer } from "./fixture-server.ts";
import { runScraper, startTestRuntime, stopTestRuntime } from "./runtime.ts";

Deno.test("CLI E2E: attach → navigate → snapshot → eval → screenshot", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    const nav = await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("bestseller-table.html")],
      rt.env,
    );
    assertEquals(nav.code, 0, `navigate failed: ${nav.stderr}`);
    assertStringIncludes(nav.stdout, "navigated to");

    const snap = await runScraper(["snapshot", "--tab", rt.targetId], rt.env);
    assertEquals(snap.code, 0, `snapshot failed: ${snap.stderr}`);
    assert(snap.stdout.includes("table"), "snapshot should contain table role");

    const evalResult = await runScraper(
      ["eval", "--tab", rt.targetId, "document.querySelector('h1').textContent"],
      rt.env,
    );
    assertEquals(evalResult.code, 0, `eval failed: ${evalResult.stderr}`);
    assertStringIncludes(evalResult.stdout, "Top Bestselling Books");

    const shot = await runScraper(["screenshot", "--tab", rt.targetId], rt.env);
    assertEquals(shot.code, 0, `screenshot failed: ${shot.stderr}`);
    const screenshotPath = shot.stdout.trim();
    assert(screenshotPath.endsWith(".png"), "should produce a .png file");
    const stat = await Deno.stat(screenshotPath);
    assert(stat.size > 0, "screenshot file should not be empty");
    await Deno.remove(screenshotPath);
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI E2E: start/stop commands no longer exist", async () => {
  const rt = await startTestRuntime();
  try {
    const start = await runScraper(["start"], rt.env);
    assertEquals(start.code, 1);
    assertStringIncludes(start.stderr, "unknown command");

    const stop = await runScraper(["stop"], rt.env);
    assertEquals(stop.code, 1);
    assertStringIncludes(stop.stderr, "unknown command");

    // Usage help does not list start/stop
    const noArgs = await runScraper([], rt.env);
    assertEquals(noArgs.code, 1);
    assert(
      !noArgs.stderr.match(/^\s*(start|stop)\s/m),
      `usage should not list start/stop: ${noArgs.stderr}`,
    );
  } finally {
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI: no chrome.json is ever written", async () => {
  const rt = await startTestRuntime();
  try {
    // Run a variety of commands
    await runScraper(["navigate", "--tab", rt.targetId, "about:blank"], rt.env);
    await runScraper(["snapshot", "--tab", rt.targetId], rt.env);

    try {
      await Deno.stat(`${rt.tmpHome}/.scraper/chrome.json`);
      throw new Error("chrome.json should not exist");
    } catch (e) {
      assert(e instanceof Deno.errors.NotFound, "chrome.json must not be written");
    }
  } finally {
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI: stateless addressing — prefix and full id write to the same refs file", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("bestseller-table.html")],
      rt.env,
    );
    const shortPrefix = rt.targetId.slice(0, 4);
    const snapPrefix = await runScraper(["snapshot", "--tab", shortPrefix], rt.env);
    assertEquals(snapPrefix.code, 0, `snapshot via prefix failed: ${snapPrefix.stderr}`);

    const refsPath = `${rt.tmpHome}/.scraper/refs.${rt.targetId}.json`;
    await Deno.stat(refsPath);

    const snapFull = await runScraper(["snapshot", "--tab", rt.targetId], rt.env);
    assertEquals(snapFull.code, 0, `snapshot via full id failed: ${snapFull.stderr}`);
    await Deno.stat(refsPath);
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI: missing --tab reports the exact error text from the design doc", async () => {
  const rt = await startTestRuntime();
  try {
    const snap = await runScraper(["snapshot"], rt.env);
    assertEquals(snap.code, 1);
    assertStringIncludes(
      snap.stderr,
      "--tab <targetId> is required. Run `scraper tabs` to list tabs, or `scraper navigate --new <url>` to open a new one.",
    );
  } finally {
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI: missing --tab reports its error even when Chrome is unreachable", async () => {
  const emptyDir = await Deno.makeTempDir();
  const tmpHome = await Deno.makeTempDir();
  try {
    const env = {
      ...Deno.env.toObject(),
      HOME: tmpHome,
      SCRAPER_USER_DATA_DIR: emptyDir,
    };
    const snap = await runScraper(["snapshot"], env);
    assertEquals(snap.code, 1);
    assertStringIncludes(
      snap.stderr,
      "--tab <targetId> is required. Run `scraper tabs` to list tabs, or `scraper navigate --new <url>` to open a new one.",
    );
    assert(
      !snap.stderr.includes("DevToolsActivePort"),
      "should short-circuit before DevToolsActivePort read",
    );
  } finally {
    await Deno.remove(emptyDir, { recursive: true });
    await Deno.remove(tmpHome, { recursive: true });
  }
});

Deno.test("CLI: unknown --tab prefix reports no-match error", async () => {
  const rt = await startTestRuntime();
  try {
    const snap = await runScraper(["snapshot", "--tab", "ZZZZZZZZ"], rt.env);
    assertEquals(snap.code, 1);
    assertStringIncludes(
      snap.stderr,
      "no tab with prefix `ZZZZZZZZ`; run `scraper tabs` to see available tabs.",
    );
  } finally {
    await stopTestRuntime(rt);
  }
});
