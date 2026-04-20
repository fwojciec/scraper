/** CLI E2E smoke test: exercises the full public surface through main.ts. */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
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

Deno.test("CLI: back-to-back snapshots produce s1.yaml then s2.yaml with parseable headers", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("bestseller-table.html")],
      rt.env,
    );
    const first = await runScraper(["snapshot", "--tab", rt.targetId], rt.env);
    assertEquals(first.code, 0, `first snapshot failed: ${first.stderr}`);
    const second = await runScraper(["snapshot", "--tab", rt.targetId], rt.env);
    assertEquals(second.code, 0, `second snapshot failed: ${second.stderr}`);

    const s1 = await Deno.readTextFile(`${rt.tmpHome}/.scraper/s1.yaml`);
    const s2 = await Deno.readTextFile(`${rt.tmpHome}/.scraper/s2.yaml`);

    const parsed1 = parseYaml(s1) as Record<string, unknown>;
    assertEquals(parsed1.snapshot, "s1");
    assertEquals(parsed1.targetId, rt.targetId);
    assertEquals(typeof parsed1.url, "string");
    assertEquals(typeof parsed1.title, "string");
    assertEquals(parsed1.dialog, null);
    assert(Array.isArray(parsed1.tree), "tree should be a sequence");

    const parsed2 = parseYaml(s2) as Record<string, unknown>;
    assertEquals(parsed2.snapshot, "s2");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI: screenshot writes shot{N}.png into ~/.scraper using the shared artifact counter", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("bestseller-table.html")],
      rt.env,
    );
    const snap = await runScraper(["snapshot", "--tab", rt.targetId], rt.env);
    assertEquals(snap.code, 0);
    const shot = await runScraper(["screenshot", "--tab", rt.targetId], rt.env);
    assertEquals(shot.code, 0, `screenshot failed: ${shot.stderr}`);
    const shotPath = shot.stdout.trim();
    // Shared counter: first snapshot consumed s1; this screenshot consumes shot2.
    assertEquals(shotPath, `${rt.tmpHome}/.scraper/shot2.png`);
    const stat = await Deno.stat(shotPath);
    assert(stat.size > 0, "screenshot file should not be empty");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
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
