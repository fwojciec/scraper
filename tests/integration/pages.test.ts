/** Integration tests for page management: pages, page commands. */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { startFixtureServer } from "./fixture-server.ts";
import { runScraper, startTestRuntime, stopTestRuntime } from "./runtime.ts";

Deno.test("pages lists the default tab", async () => {
  const rt = await startTestRuntime();
  try {
    const pages = await runScraper(["pages"], rt.env);
    assertEquals(pages.code, 0, `pages failed: ${pages.stderr}`);
    assert(pages.stdout.includes("about:blank"), `expected about:blank in: ${pages.stdout}`);
    // After startTestRuntime selects it, the tab is marked active
    assert(pages.stdout.includes("*"), `expected active marker in: ${pages.stdout}`);
  } finally {
    await stopTestRuntime(rt);
  }
});

Deno.test("page switch and navigate work across tabs", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    const nav = await runScraper(
      ["navigate", fixtures.url("bestseller-table.html")],
      rt.env,
    );
    assertEquals(nav.code, 0, `navigate failed: ${nav.stderr}`);

    const pages1 = await runScraper(["pages"], rt.env);
    assertEquals(pages1.code, 0, `pages failed: ${pages1.stderr}`);
    assertStringIncludes(pages1.stdout, "bestseller-table.html");

    const lines = pages1.stdout.trim().split("\n");
    const activeLine = lines.find((l) => l.startsWith("*"));
    assert(activeLine, "should have an active page");
    const activeTargetId = activeLine.replace("*", "").trim().split(/\s+/)[0];

    const pageCmd = await runScraper(["page", activeTargetId], rt.env);
    assertEquals(pageCmd.code, 0, `page failed: ${pageCmd.stderr}`);
    assertStringIncludes(pageCmd.stdout, "switched to page");

    const snap = await runScraper(["snapshot"], rt.env);
    assertEquals(snap.code, 0, `snapshot failed: ${snap.stderr}`);
    assert(snap.stdout.includes("table"), "snapshot should contain table role");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("page with invalid pageId returns error", async () => {
  const rt = await startTestRuntime();
  try {
    const page = await runScraper(["page", "nonexistent-id"], rt.env);
    assertEquals(page.code, 1);
    assertStringIncludes(page.stderr, "no page with id");
  } finally {
    await stopTestRuntime(rt);
  }
});

Deno.test("navigate invalidates refs", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    await runScraper(["navigate", fixtures.url("bestseller-table.html")], rt.env);
    const snap = await runScraper(["snapshot"], rt.env);
    assertEquals(snap.code, 0, `snapshot failed: ${snap.stderr}`);

    const refsText = await Deno.readTextFile(`${rt.tmpHome}/.scraper/refs.json`);
    const refs = JSON.parse(refsText);
    assert(Object.keys(refs).length > 0, "refs should not be empty after snapshot");

    await runScraper(["navigate", "about:blank"], rt.env);

    try {
      await Deno.stat(`${rt.tmpHome}/.scraper/refs.json`);
      throw new Error("refs.json should have been removed after navigate");
    } catch (e) {
      assert(e instanceof Deno.errors.NotFound, "refs.json should not exist after navigate");
    }
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("target file persists selected tab across commands", async () => {
  const rt = await startTestRuntime();
  try {
    const targetText = await Deno.readTextFile(`${rt.tmpHome}/.scraper/target`);
    assertEquals(targetText.trim(), rt.targetId);
  } finally {
    await stopTestRuntime(rt);
  }
});
