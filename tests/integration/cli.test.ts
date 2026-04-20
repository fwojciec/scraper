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
    // navigate auto-snapshots and emits `navigated · snapshot s{N} · ...`.
    const navLines = nav.stdout.split("\n").filter((l) => l.length > 0);
    assertEquals(navLines.length, 1, `expected single pointer line, got: ${nav.stdout}`);
    assert(
      /^navigated · snapshot s\d+ · .+ · \d+ refs · \d+B$/.test(navLines[0]),
      `pointer should match design format, got: ${navLines[0]}`,
    );

    const snap = await runScraper(["snapshot", "--tab", rt.targetId], rt.env);
    assertEquals(snap.code, 0, `snapshot failed: ${snap.stderr}`);
    // Stdout is the one-line pointer (see design §Snapshot Artifact). The
    // full YAML tree lives in ~/.scraper/s{N}.yaml; we verify it separately
    // via other tests so don't assert ARIA roles on stdout here.
    const pointerLines = snap.stdout.split("\n").filter((l) => l.length > 0);
    assertEquals(pointerLines.length, 1, `expected single pointer line, got: ${snap.stdout}`);
    const pointer = pointerLines[0];
    assert(
      /^snapshot s\d+ · .+ · \d+ refs · \d+B$/.test(pointer),
      `pointer should match design format, got: ${pointer}`,
    );
    assert(pointer.includes("Bestsellers"), "pointer label should be the page title");

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

Deno.test("CLI E2E: eval resolves $ref to a live DOM element from refs.<targetId>.json", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("actions.html")],
      rt.env,
    );
    const snap = await runScraper(["snapshot", "--tab", rt.targetId], rt.env);
    assertEquals(snap.code, 0, `snapshot failed: ${snap.stderr}`);
    // Read back the refs file to pick a real textbox ref for the form's
    // "Name" input — ref numbering is monotonic across tabs so the ref
    // number is not hardcodable across test runs.
    const refsPath = `${rt.tmpHome}/.scraper/refs.${rt.targetId}.json`;
    const refsJson = JSON.parse(await Deno.readTextFile(refsPath)) as {
      refs: Record<string, number>;
    };
    const refToken = Object.keys(refsJson.refs)[0];
    assert(refToken?.startsWith("e"), `expected an ref token, got: ${refToken}`);

    // Mutate the element through $ref, then read back through $ref to prove the
    // same node is resolved on both calls.
    const set = await runScraper(
      ["eval", "--tab", rt.targetId, `$ref("${refToken}").setAttribute("data-x", "yes")`],
      rt.env,
    );
    assertEquals(set.code, 0, `eval set failed: ${set.stderr}`);

    const get = await runScraper(
      ["eval", "--tab", rt.targetId, `$ref("${refToken}").getAttribute("data-x")`],
      rt.env,
    );
    assertEquals(get.code, 0, `eval get failed: ${get.stderr}`);
    assertStringIncludes(get.stdout, '"yes"');
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI E2E: eval with a stale $ref prints the design-doc error and exits 1", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("actions.html")],
      rt.env,
    );
    await runScraper(["snapshot", "--tab", rt.targetId], rt.env);
    // Any ref counter far above anything a single snapshot would mint on the
    // fixture is guaranteed stale — the monotonic counter ensures a ref that
    // "should exist" is either in the current refs file or nowhere at all.
    const stale = await runScraper(
      ["eval", "--tab", rt.targetId, `$ref("e9999").click()`],
      rt.env,
    );
    assertEquals(stale.code, 1);
    assertStringIncludes(
      stale.stderr,
      `ref e9999 is stale — not in refs.${rt.targetId}.json (current refs:`,
    );
    assertStringIncludes(
      stale.stderr,
      `Run \`scraper snapshot --tab ${rt.targetId}\``,
    );
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
    // Shared counter: navigate auto-snapshots (s1), explicit snapshot above
    // (s2), this screenshot consumes shot3.
    assertEquals(shotPath, `${rt.tmpHome}/.scraper/shot3.png`);
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

Deno.test("CLI: tabs prints full targetId + URL + title for the live page tab", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("bestseller-table.html")],
      rt.env,
    );
    const result = await runScraper(["tabs"], rt.env);
    assertEquals(result.code, 0, `tabs failed: ${result.stderr}`);
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    const line = lines.find((l) => l.startsWith(rt.targetId));
    assert(line !== undefined, `expected a line starting with targetId, got: ${result.stdout}`);
    assertStringIncludes(line, "bestseller-table.html");
    // Titles are JSON-encoded so an empty-title tab still renders a visible `""`.
    assertStringIncludes(line, '"');
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI: tabs removes refs.<targetId>.json for targetIds no longer in /json/list", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    // Create real refs for the live tab so we can confirm cleanup spares it.
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("bestseller-table.html")],
      rt.env,
    );
    await runScraper(["snapshot", "--tab", rt.targetId], rt.env);
    const liveRefs = `${rt.tmpHome}/.scraper/refs.${rt.targetId}.json`;
    await Deno.stat(liveRefs);

    // Plant a refs file for a fake, long-dead targetId.
    const deadId = "DEADBEEF00000000000000000000BEEF";
    const deadRefs = `${rt.tmpHome}/.scraper/refs.${deadId}.json`;
    await Deno.writeTextFile(deadRefs, '{"snapshotId":"s0","refs":{}}');

    const result = await runScraper(["tabs"], rt.env);
    assertEquals(result.code, 0, `tabs failed: ${result.stderr}`);

    // Live tab's refs file must still exist; dead tab's must be gone.
    await Deno.stat(liveRefs);
    try {
      await Deno.stat(deadRefs);
      throw new Error(`${deadRefs} should have been cleaned up`);
    } catch (e) {
      assert(e instanceof Deno.errors.NotFound, `${deadRefs} should not exist after tabs`);
    }
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI: tabs is a no-op (exit 0) when ~/.scraper does not exist yet", async () => {
  const rt = await startTestRuntime();
  try {
    // Fresh HOME — the scraper state dir has not been created.
    try {
      await Deno.stat(`${rt.tmpHome}/.scraper`);
      throw new Error("state dir should not exist yet");
    } catch (e) {
      assert(e instanceof Deno.errors.NotFound);
    }
    const result = await runScraper(["tabs"], rt.env);
    assertEquals(result.code, 0, `tabs failed: ${result.stderr}`);
  } finally {
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI: navigate --new opens a new tab, prints its targetId, and auto-snapshots", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    const nav = await runScraper(
      ["navigate", "--new", fixtures.url("bestseller-table.html")],
      rt.env,
    );
    assertEquals(nav.code, 0, `navigate --new failed: ${nav.stderr}`);
    const lines = nav.stdout.split("\n").filter((l) => l.length > 0);
    assertEquals(lines.length, 2, `expected 2 stdout lines, got: ${nav.stdout}`);
    const newTargetId = lines[0];
    // Full 32-hex targetId so agents can copy any prefix to address it.
    assert(/^[0-9A-F]{32}$/.test(newTargetId), `expected hex targetId, got: ${newTargetId}`);
    // Distinct from the runtime's initial page tab.
    assert(
      newTargetId !== rt.targetId,
      `--new should open a different tab, got the existing one: ${newTargetId}`,
    );
    assert(
      /^snapshot s\d+ · .+ · \d+ refs · \d+B$/.test(lines[1]),
      `pointer should match design format, got: ${lines[1]}`,
    );

    // The new tab is addressable on subsequent commands by any prefix.
    const tabs = await runScraper(["tabs"], rt.env);
    assertStringIncludes(tabs.stdout, newTargetId);

    const evalResult = await runScraper(
      ["eval", "--tab", newTargetId.slice(0, 8), "document.querySelector('h1').textContent"],
      rt.env,
    );
    assertEquals(evalResult.code, 0, `eval against new tab failed: ${evalResult.stderr}`);
    assertStringIncludes(evalResult.stdout, "Top Bestselling Books");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI: navigate --new waits for network idle before snapshotting", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    const nav = await runScraper(
      ["navigate", "--new", fixtures.url("slow-loading.html")],
      rt.env,
    );
    assertEquals(nav.code, 0, `navigate --new failed: ${nav.stderr}`);
    const lines = nav.stdout.split("\n").filter((l) => l.length > 0);
    const newTargetId = lines[0];
    // The slow-loading fixture starts an in-flight fetch from JS that doesn't
    // resolve for ~1500ms — well past waitForNetworkIdle's 500ms grace. If
    // the auto-snapshot ran before network idle, the heading would still
    // read "Pending"; if it waited, it must read "Ready".
    const snapshotPath = `${rt.tmpHome}/.scraper/s1.yaml`;
    const yaml = await Deno.readTextFile(snapshotPath);
    assertStringIncludes(
      yaml,
      "Ready",
      `snapshot should reflect post-load state; got: ${yaml}`,
    );
    assert(
      !yaml.includes("Pending"),
      `snapshot should not still show pre-load state; got: ${yaml}`,
    );
    // Sanity-check the new tab is real and addressable.
    assert(/^[0-9A-F]{32}$/.test(newTargetId), `expected hex targetId, got: ${newTargetId}`);
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI: navigate --tab and --new are mutually exclusive", async () => {
  const rt = await startTestRuntime();
  try {
    const result = await runScraper(
      ["navigate", "--new", "--tab", rt.targetId, "https://example.com"],
      rt.env,
    );
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "mutually exclusive");
  } finally {
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI: wait --selector auto-snapshots and emits `waited · snapshot ...` pointer", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    // navigate auto-snapshots → s1.yaml
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("actions.html")],
      rt.env,
    );
    // Trigger the class addition that occurs ~200ms later. The selector
    // `#attr-target.ready` only matches after that setTimeout fires, so the
    // wait must observe a DOM mutation, not an initial match.
    await runScraper(
      ["eval", "--tab", rt.targetId, "document.getElementById('add-class-btn').click()"],
      rt.env,
    );
    const result = await runScraper(
      ["wait", "--tab", rt.targetId, "--selector", "#attr-target.ready"],
      rt.env,
    );
    assertEquals(result.code, 0, `wait failed: ${result.stderr}`);
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    assertEquals(lines.length, 1, `expected single pointer line, got: ${result.stdout}`);
    assert(
      /^waited · snapshot s\d+ · .+ · \d+ refs · \d+B$/.test(lines[0]),
      `pointer should match design format, got: ${lines[0]}`,
    );
    // Auto-snapshot produced a new YAML file — the one after the initial
    // navigate's s1.yaml.
    await Deno.stat(`${rt.tmpHome}/.scraper/s2.yaml`);
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI: wait --text auto-snapshots when the text appears", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("actions.html")],
      rt.env,
    );
    // show-text-btn reveals "Secret Text" ~200ms after click by toggling
    // display:none. The wait must succeed after that change.
    await runScraper(
      ["eval", "--tab", rt.targetId, "document.getElementById('show-text-btn').click()"],
      rt.env,
    );
    const result = await runScraper(
      ["wait", "--tab", rt.targetId, "--text", "Secret Text"],
      rt.env,
    );
    assertEquals(result.code, 0, `wait failed: ${result.stderr}`);
    assertStringIncludes(result.stdout, "waited · snapshot s");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("CLI: upload --selector sets the file on the input (visible via eval)", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  const tmpFile = await Deno.makeTempFile({ prefix: "scraper-upload-", suffix: ".txt" });
  await Deno.writeTextFile(tmpFile, "hello upload");
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("actions.html")],
      rt.env,
    );
    const upload = await runScraper(
      ["upload", "--tab", rt.targetId, "--selector", "input[type=file]", tmpFile],
      rt.env,
    );
    assertEquals(upload.code, 0, `upload failed: ${upload.stderr}`);
    // Stdout reports the resolved target so the agent knows which control was hit.
    assertStringIncludes(upload.stdout, "uploaded to selector");
    // Verify the upload landed by reading the input's FileList back through eval.
    const filename = tmpFile.split("/").pop() ?? "";
    const verify = await runScraper(
      [
        "eval",
        "--tab",
        rt.targetId,
        `document.getElementById('file-input').files[0].name`,
      ],
      rt.env,
    );
    assertEquals(verify.code, 0, `eval failed: ${verify.stderr}`);
    assertStringIncludes(verify.stdout, JSON.stringify(filename));
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
    try {
      await Deno.remove(tmpFile);
    } catch { /* best effort */ }
  }
});

Deno.test("CLI: upload --ref resolves backendNodeId and sets the file", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  const tmpFile = await Deno.makeTempFile({ prefix: "scraper-upload-", suffix: ".dat" });
  await Deno.writeTextFile(tmpFile, "ref upload payload");
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("actions.html")],
      rt.env,
    );
    // navigate auto-snapshots and writes refs.<targetId>.json. The file input
    // is one of several form refs; find it by tagName/type via $ref so this
    // test stays robust to ARIA-tree ordering changes.
    const refsPath = `${rt.tmpHome}/.scraper/refs.${rt.targetId}.json`;
    const refsJson = JSON.parse(await Deno.readTextFile(refsPath)) as {
      refs: Record<string, number>;
    };
    let fileRef: string | undefined;
    for (const candidate of Object.keys(refsJson.refs)) {
      const probe = await runScraper(
        [
          "eval",
          "--tab",
          rt.targetId,
          `$ref("${candidate}").tagName === "INPUT" && $ref("${candidate}").type === "file"`,
        ],
        rt.env,
      );
      if (probe.code === 0 && probe.stdout.trim() === "true") {
        fileRef = candidate;
        break;
      }
    }
    assert(
      fileRef !== undefined,
      `expected to find a ref for the file input; refs: ${Object.keys(refsJson.refs).join(",")}`,
    );

    const upload = await runScraper(
      ["upload", "--tab", rt.targetId, "--ref", fileRef!, tmpFile],
      rt.env,
    );
    assertEquals(upload.code, 0, `upload failed: ${upload.stderr}`);
    assertStringIncludes(upload.stdout, `uploaded to ref ${fileRef}`);

    const filename = tmpFile.split("/").pop() ?? "";
    const verify = await runScraper(
      [
        "eval",
        "--tab",
        rt.targetId,
        `$ref("${fileRef}").files[0].name`,
      ],
      rt.env,
    );
    assertEquals(verify.code, 0, `eval failed: ${verify.stderr}`);
    assertStringIncludes(verify.stdout, JSON.stringify(filename));
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
    try {
      await Deno.remove(tmpFile);
    } catch { /* best effort */ }
  }
});

Deno.test("CLI: upload with stale --ref reports the canonical stale-ref error", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  const tmpFile = await Deno.makeTempFile({ prefix: "scraper-upload-", suffix: ".txt" });
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("actions.html")],
      rt.env,
    );
    // Refs are minted monotonically; e9999 is far above anything a single
    // snapshot of the fixture would hand out, so the lookup must miss.
    const upload = await runScraper(
      ["upload", "--tab", rt.targetId, "--ref", "e9999", tmpFile],
      rt.env,
    );
    assertEquals(upload.code, 1);
    assertStringIncludes(upload.stderr, "ref e9999 is stale");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
    try {
      await Deno.remove(tmpFile);
    } catch { /* best effort */ }
  }
});

Deno.test("CLI: upload of a non-file input rejects with a clear error", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  const tmpFile = await Deno.makeTempFile({ prefix: "scraper-upload-", suffix: ".txt" });
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("actions.html")],
      rt.env,
    );
    // Targeting the text input should be rejected by the upload check —
    // DOM.setFileInputFiles only makes sense on input[type=file].
    const upload = await runScraper(
      ["upload", "--tab", rt.targetId, "--selector", "#name-input", tmpFile],
      rt.env,
    );
    assertEquals(upload.code, 1);
    assertStringIncludes(upload.stderr, "not a file input");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
    try {
      await Deno.remove(tmpFile);
    } catch { /* best effort */ }
  }
});

Deno.test("CLI: wait timeout exits 1 with a clear error and no pointer on stdout", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();
  try {
    await runScraper(
      ["navigate", "--tab", rt.targetId, fixtures.url("actions.html")],
      rt.env,
    );
    // Short timeout so the test stays fast. The fixture never renders this
    // text, so the wait must hit its deadline.
    const result = await runScraper(
      [
        "wait",
        "--tab",
        rt.targetId,
        "--text",
        "this text will never appear",
        "--timeout",
        "300",
      ],
      rt.env,
    );
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "timed out waiting for text");
    assertStringIncludes(result.stderr, "this text will never appear");
    // No pointer on failure — success-only contract.
    assertEquals(result.stdout, "");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});
