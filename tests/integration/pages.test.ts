/** Integration tests for navigation/state behavior with real Chrome. */

import { assert, assertEquals } from "@std/assert";
import { startFixtureServer } from "./fixture-server.ts";
import { runScraper, startTestRuntime, stopTestRuntime } from "./runtime.ts";

Deno.test("navigate invalidates that tab's refs", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("bestseller-table.html")],
      rt.env,
    );
    const snap = await runScraper(["snapshot", "--tab", rt.targetId], rt.env);
    assertEquals(snap.code, 0, `snapshot failed: ${snap.stderr}`);

    const refsPath = `${rt.tmpHome}/.scraper/refs.${rt.targetId}.json`;
    const refsText = await Deno.readTextFile(refsPath);
    const refs = JSON.parse(refsText);
    assert(Object.keys(refs).length > 0, "refs should not be empty after snapshot");

    await runScraper(["navigate", "--tab", rt.targetId, "about:blank"], rt.env);

    try {
      await Deno.stat(refsPath);
      throw new Error(`${refsPath} should have been removed after navigate`);
    } catch (e) {
      assert(e instanceof Deno.errors.NotFound, `${refsPath} should not exist after navigate`);
    }
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("counter-refs advances monotonically across snapshots", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("bestseller-table.html")],
      rt.env,
    );
    const first = await runScraper(["snapshot", "--tab", rt.targetId], rt.env);
    assertEquals(first.code, 0, `first snapshot failed: ${first.stderr}`);

    const counterPath = `${rt.tmpHome}/.scraper/counter-refs`;
    const afterFirst = Number((await Deno.readTextFile(counterPath)).trim());
    assert(afterFirst > 0, `counter-refs should be > 0 after a snapshot, got ${afterFirst}`);

    const second = await runScraper(["snapshot", "--tab", rt.targetId], rt.env);
    assertEquals(second.code, 0, `second snapshot failed: ${second.stderr}`);

    const afterSecond = Number((await Deno.readTextFile(counterPath)).trim());
    assert(
      afterSecond > afterFirst,
      `counter-refs should advance (was ${afterFirst}, now ${afterSecond})`,
    );

    const refsText = await Deno.readTextFile(
      `${rt.tmpHome}/.scraper/refs.${rt.targetId}.json`,
    );
    const refsFile = JSON.parse(refsText) as {
      snapshotId: string;
      refs: Record<string, number>;
    };
    assert(refsFile.snapshotId.startsWith("s"), "refs file should include snapshotId");
    const refNumbers = Object.keys(refsFile.refs).map((r) => Number(r.slice(1)));
    assert(
      refNumbers.every((n) => n > afterFirst),
      `post-second-snapshot refs should be > first counter (${afterFirst}), got ${refNumbers}`,
    );
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("no persisted active target: ~/.scraper/target is never written", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("bestseller-table.html")],
      rt.env,
    );
    await runScraper(["snapshot", "--tab", rt.targetId], rt.env);

    try {
      await Deno.stat(`${rt.tmpHome}/.scraper/target`);
      throw new Error("~/.scraper/target should not exist under stateless addressing");
    } catch (e) {
      assert(e instanceof Deno.errors.NotFound, "target file must not be written");
    }
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});
