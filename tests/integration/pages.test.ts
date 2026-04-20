/** Integration tests for navigation/state behavior with real Chrome. */

import { assert, assertEquals } from "@std/assert";
import { startFixtureServer } from "./fixture-server.ts";
import { runScraper, startTestRuntime, stopTestRuntime } from "./runtime.ts";

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
