/** Integration tests for navigation/state behavior with real Chrome. */

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
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

Deno.test("concurrent snapshots allocate distinct artifact ids", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("bestseller-table.html")],
      rt.env,
    );
    // Race two snapshots against the same tab. Without the state lock, both
    // processes read the same `counter`, both mint `sN`, and one overwrites
    // the other's YAML on disk.
    const [r1, r2] = await Promise.all([
      runScraper(["snapshot", "--tab", rt.targetId], rt.env),
      runScraper(["snapshot", "--tab", rt.targetId], rt.env),
    ]);
    assertEquals(r1.code, 0, `snapshot #1 failed: ${r1.stderr}`);
    assertEquals(r2.code, 0, `snapshot #2 failed: ${r2.stderr}`);
    const idOf = (out: string) => out.match(/snapshot (s\d+)/)?.[1];
    const id1 = idOf(r1.stdout);
    const id2 = idOf(r2.stdout);
    assert(id1 !== undefined, `snapshot #1 pointer missing: ${r1.stdout}`);
    assert(id2 !== undefined, `snapshot #2 pointer missing: ${r2.stdout}`);
    assertNotEquals(id1, id2, "concurrent snapshots must not collide on sN");
    for (const id of [id1!, id2!]) {
      const yaml = await Deno.readTextFile(`${rt.tmpHome}/.scraper/${id}.yaml`);
      assertStringIncludes(
        yaml,
        `snapshot: ${id}`,
        `${id}.yaml must carry its own header, not the racing snapshot's`,
      );
    }
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
