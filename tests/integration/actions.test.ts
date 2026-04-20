/** Integration tests for click, fill, wait actions with real Chrome. */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { startFixtureServer } from "./fixture-server.ts";
import { runScraper, startTestRuntime, stopTestRuntime } from "./runtime.ts";

Deno.test("actions: click, fill, wait, navigate --snapshot", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();

  try {
    const nav = await runScraper(
      ["navigate", fixtures.url("actions.html")],
      rt.env,
    );
    assertEquals(nav.code, 0, `navigate failed: ${nav.stderr}`);

    const snap = await runScraper(["snapshot"], rt.env);
    assertEquals(snap.code, 0, `snapshot failed: ${snap.stderr}`);
    assert(snap.stdout.includes("textbox"), "should contain textbox role");
    assert(snap.stdout.includes("button"), "should contain button role");
    assert(snap.stdout.includes("ref="), "should have refs");

    const refsPath = `${rt.tmpHome}/.scraper/refs.json`;
    const refsText = await Deno.readTextFile(refsPath);
    const refs = JSON.parse(refsText);
    assert(Object.keys(refs).length > 0, "refs.json should have entries");

    const fill = await runScraper(
      ["fill", "--selector", "#name-input", "Alice"],
      rt.env,
    );
    assertEquals(fill.code, 0, `fill failed: ${fill.stderr}`);
    assertStringIncludes(fill.stdout, "filled");

    const click = await runScraper(
      ["click", "--selector", "#greet-btn"],
      rt.env,
    );
    assertEquals(click.code, 0, `click failed: ${click.stderr}`);
    assertStringIncludes(click.stdout, "clicked");

    const wait = await runScraper(
      ["wait", "--text", "Hello, Alice!"],
      rt.env,
    );
    assertEquals(wait.code, 0, `wait failed: ${wait.stderr}`);
    assertStringIncludes(wait.stdout, "found text");

    const evalResult = await runScraper(
      ["eval", "document.getElementById('output').textContent"],
      rt.env,
    );
    assertEquals(evalResult.code, 0, `eval failed: ${evalResult.stderr}`);
    assertStringIncludes(evalResult.stdout, "Hello, Alice!");

    const navSnap = await runScraper(
      ["navigate", fixtures.url("actions.html"), "--snapshot"],
      rt.env,
    );
    assertEquals(navSnap.code, 0, `navigate --snapshot failed: ${navSnap.stderr}`);
    assertStringIncludes(navSnap.stderr, "navigated to");
    assert(navSnap.stdout.includes("textbox"), "snapshot YAML should be on stdout");

    const newRefsText = await Deno.readTextFile(refsPath);
    const newRefs = JSON.parse(newRefsText);
    assert(
      Object.keys(newRefs).length > 0,
      "refs.json should have entries after navigate --snapshot",
    );

    const clickSnap = await runScraper(
      ["click", "--selector", "#greet-btn", "--snapshot"],
      rt.env,
    );
    assertEquals(clickSnap.code, 0, `click --snapshot failed: ${clickSnap.stderr}`);
    assertStringIncludes(clickSnap.stderr, "clicked");
    assert(clickSnap.stdout.includes("button"), "snapshot YAML should be on stdout");

    const waitSel = await runScraper(
      ["wait", "--selector", "#output"],
      rt.env,
    );
    assertEquals(waitSel.code, 0, `wait --selector failed: ${waitSel.stderr}`);
    assertStringIncludes(waitSel.stdout, "found element");

    const waitSelText = await runScraper(
      ["wait", "--selector", "#output", "--text", "enter a name"],
      rt.env,
    );
    assertEquals(waitSelText.code, 0, `wait --selector --text failed: ${waitSelText.stderr}`);
    assertStringIncludes(waitSelText.stdout, "found text");

    const navNoSnap = await runScraper(
      ["navigate", fixtures.url("actions.html")],
      rt.env,
    );
    assertEquals(navNoSnap.code, 0, `navigate (no --snapshot) failed: ${navNoSnap.stderr}`);
    try {
      await Deno.stat(refsPath);
      throw new Error("refs.json should have been deleted by navigate without --snapshot");
    } catch (e) {
      assert(e instanceof Deno.errors.NotFound, "refs.json should not exist");
    }

    const clickAmbiguous = await runScraper(
      ["click", "--selector", "input"],
      rt.env,
    );
    assertEquals(clickAmbiguous.code, 1, "ambiguous selector should fail");
    assertStringIncludes(clickAmbiguous.stderr, "matched");
    assertStringIncludes(clickAmbiguous.stderr, "expected exactly 1");

    const clickNoMatch = await runScraper(
      ["click", "--selector", "#nonexistent"],
      rt.env,
    );
    assertEquals(clickNoMatch.code, 1, "no-match selector should fail");
    assertStringIncludes(clickNoMatch.stderr, "did not match");

    const snap2 = await runScraper(["snapshot"], rt.env);
    assertEquals(snap2.code, 0, `snapshot2 failed: ${snap2.stderr}`);

    await runScraper(["navigate", fixtures.url("actions.html")], rt.env);

    const clickStale = await runScraper(
      ["click", "--ref", "e1"],
      rt.env,
    );
    assertEquals(clickStale.code, 1, "stale ref should fail");
    assertStringIncludes(clickStale.stderr, "no refs available");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("actions: click --ref uses persisted refs.json across processes", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();

  try {
    await runScraper(["navigate", fixtures.url("actions.html")], rt.env);

    const snap = await runScraper(["snapshot"], rt.env);
    assertEquals(snap.code, 0, `snapshot failed: ${snap.stderr}`);

    const refsText = await Deno.readTextFile(`${rt.tmpHome}/.scraper/refs.json`);
    const refs = JSON.parse(refsText);
    const refEntries = Object.entries(refs);
    assert(refEntries.length > 0, "should have refs");

    const firstRef = refEntries[0][0];

    const fill = await runScraper(
      ["fill", "--ref", firstRef, "Bob"],
      rt.env,
    );
    assertEquals(fill.code, 0, `fill --ref failed: ${fill.stderr}`);
    assertStringIncludes(fill.stdout, `filled ref ${firstRef}`);
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("actions: type, select, submit, press-key", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();

  try {
    const nav = await runScraper(
      ["navigate", fixtures.url("actions.html")],
      rt.env,
    );
    assertEquals(nav.code, 0, `navigate failed: ${nav.stderr}`);

    const typeResult = await runScraper(
      ["type", "--selector", "#name-input", "Alice"],
      rt.env,
    );
    assertEquals(typeResult.code, 0, `type failed: ${typeResult.stderr}`);
    assertStringIncludes(typeResult.stdout, "typed into");

    const typedValue = await runScraper(
      ["eval", "document.getElementById('name-input').value"],
      rt.env,
    );
    assertEquals(typedValue.code, 0, `eval typed value failed: ${typedValue.stderr}`);
    assertStringIncludes(typedValue.stdout, "Alice");

    const typedOutput = await runScraper(
      ["eval", "document.getElementById('typed-output').textContent"],
      rt.env,
    );
    assertEquals(typedOutput.code, 0);
    assertStringIncludes(typedOutput.stdout, "typed:Alice");

    const selectResult = await runScraper(
      ["select", "--selector", "#color-select", "blue"],
      rt.env,
    );
    assertEquals(selectResult.code, 0, `select failed: ${selectResult.stderr}`);
    assertStringIncludes(selectResult.stdout, "selected");

    const selectValue = await runScraper(
      ["eval", "document.getElementById('color-select').value"],
      rt.env,
    );
    assertEquals(selectValue.code, 0);
    assertStringIncludes(selectValue.stdout, "blue");

    const submitResult = await runScraper(
      ["submit", "--selector", "#test-form"],
      rt.env,
    );
    assertEquals(submitResult.code, 0, `submit failed: ${submitResult.stderr}`);
    assertStringIncludes(submitResult.stdout, "submitted");

    const submitOutput = await runScraper(
      ["eval", "document.getElementById('submit-output').textContent"],
      rt.env,
    );
    assertEquals(submitOutput.code, 0);
    assertStringIncludes(submitOutput.stdout, "submitted: name=Alice, color=blue");

    await runScraper(["fill", "--selector", "#name-input", ""], rt.env);
    await runScraper(["type", "--selector", "#name-input", "Bob"], rt.env);

    const pressResult = await runScraper(
      ["press-key", "Enter", "--selector", "#name-input"],
      rt.env,
    );
    assertEquals(pressResult.code, 0, `press-key failed: ${pressResult.stderr}`);
    assertStringIncludes(pressResult.stdout, "pressed Enter");

    const keypressOutput = await runScraper(
      ["eval", "document.getElementById('keypress-output').textContent"],
      rt.env,
    );
    assertEquals(keypressOutput.code, 0);
    assertStringIncludes(keypressOutput.stdout, "keydown:Enter");

    const typeSnap = await runScraper(
      ["type", "--selector", "#name-input", "X", "--snapshot"],
      rt.env,
    );
    assertEquals(typeSnap.code, 0, `type --snapshot failed: ${typeSnap.stderr}`);
    assertStringIncludes(typeSnap.stderr, "typed into");
    assert(typeSnap.stdout.includes("textbox"), "snapshot YAML should be on stdout");

    const selectBad = await runScraper(
      ["select", "--selector", "#color-select", "purple"],
      rt.env,
    );
    assertEquals(selectBad.code, 1, "select with invalid value should fail");
    assertStringIncludes(selectBad.stderr, "no option with value");

    const submitNoForm = await runScraper(
      ["submit", "--selector", "h1"],
      rt.env,
    );
    assertEquals(submitNoForm.code, 1, "submit on non-form element should fail");
    assertStringIncludes(submitNoForm.stderr, "no form found");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("actions: upload sets file on input[type=file]", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();

  try {
    await runScraper(["navigate", fixtures.url("actions.html")], rt.env);

    const tmpFile = await Deno.makeTempFile({ suffix: ".txt" });
    await Deno.writeTextFile(tmpFile, "test content");

    const upload = await runScraper(
      ["upload", "--selector", "#file-input", tmpFile],
      rt.env,
    );
    assertEquals(upload.code, 0, `upload failed: ${upload.stderr}`);
    assertStringIncludes(upload.stdout, "uploaded");

    const fileOutput = await runScraper(
      ["eval", "document.getElementById('file-output').textContent"],
      rt.env,
    );
    assertEquals(fileOutput.code, 0);
    assertStringIncludes(fileOutput.stdout, "file:");

    const uploadBad = await runScraper(
      ["upload", "--selector", "#name-input", tmpFile],
      rt.env,
    );
    assertEquals(uploadBad.code, 1, "upload on non-file input should fail");
    assertStringIncludes(uploadBad.stderr, "not a file input");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("actions: --on-dialog handles alert, confirm, prompt", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();

  try {
    await runScraper(["navigate", fixtures.url("actions.html")], rt.env);

    const alertClick = await runScraper(
      ["click", "--selector", "#alert-btn", "--on-dialog", "accept"],
      rt.env,
    );
    assertEquals(alertClick.code, 0, `alert click failed: ${alertClick.stderr}`);

    const alertOutput = await runScraper(
      ["eval", "document.getElementById('dialog-output').textContent"],
      rt.env,
    );
    assertEquals(alertOutput.code, 0);
    assertStringIncludes(alertOutput.stdout, "alert:done");

    const confirmClick = await runScraper(
      ["click", "--selector", "#confirm-btn", "--on-dialog", "dismiss"],
      rt.env,
    );
    assertEquals(confirmClick.code, 0, `confirm click failed: ${confirmClick.stderr}`);

    const confirmOutput = await runScraper(
      ["eval", "document.getElementById('dialog-output').textContent"],
      rt.env,
    );
    assertEquals(confirmOutput.code, 0);
    assertStringIncludes(confirmOutput.stdout, "confirm:false");

    const promptClick = await runScraper(
      ["click", "--selector", "#prompt-btn", "--on-dialog", "accept:hello"],
      rt.env,
    );
    assertEquals(promptClick.code, 0, `prompt click failed: ${promptClick.stderr}`);

    const promptOutput = await runScraper(
      ["eval", "document.getElementById('dialog-output').textContent"],
      rt.env,
    );
    assertEquals(promptOutput.code, 0);
    assertStringIncludes(promptOutput.stdout, "prompt:hello");

    const noDialogClick = await runScraper(
      ["click", "--selector", "#alert-btn"],
      rt.env,
    );
    assertEquals(noDialogClick.code, 1, "click triggering dialog without --on-dialog should fail");
    assertStringIncludes(noDialogClick.stderr, "a dialog appeared");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("actions: wait --selector detects attribute changes", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();

  try {
    await runScraper(["navigate", fixtures.url("actions.html")], rt.env);
    await runScraper(["click", "--selector", "#add-class-btn"], rt.env);

    const wait = await runScraper(
      ["wait", "--selector", "#attr-target.ready", "--timeout", "3000"],
      rt.env,
    );
    assertEquals(wait.code, 0, `wait --selector for class failed: ${wait.stderr}`);
    assertStringIncludes(wait.stdout, "found element");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("actions: wait --text detects style-driven visibility", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();

  try {
    await runScraper(["navigate", fixtures.url("actions.html")], rt.env);
    await runScraper(["click", "--selector", "#show-text-btn"], rt.env);

    const wait = await runScraper(
      ["wait", "--text", "Secret Text", "--timeout", "3000"],
      rt.env,
    );
    assertEquals(wait.code, 0, `wait --text for style visibility failed: ${wait.stderr}`);
    assertStringIncludes(wait.stdout, "found text");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("actions: wait --text in element detects ancestor visibility change", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();

  try {
    await runScraper(["navigate", fixtures.url("actions.html")], rt.env);
    await runScraper(["click", "--selector", "#show-ancestor-btn"], rt.env);

    const wait = await runScraper(
      ["wait", "--selector", "#nested-text", "--text", "Nested Secret", "--timeout", "3000"],
      rt.env,
    );
    assertEquals(
      wait.code,
      0,
      `wait --text in element for ancestor visibility failed: ${wait.stderr}`,
    );
    assertStringIncludes(wait.stdout, "found text");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});

Deno.test("actions: wait --timeout times out with clear error", async () => {
  const rt = await startTestRuntime();
  const fixtures = startFixtureServer();

  try {
    await runScraper(["navigate", fixtures.url("actions.html")], rt.env);

    const wait = await runScraper(
      ["wait", "--text", "nonexistent text", "--timeout", "1000"],
      rt.env,
    );
    assertEquals(wait.code, 1, "wait for missing text should fail");
    assertStringIncludes(wait.stderr, "timed out");
  } finally {
    await fixtures.close();
    await stopTestRuntime(rt);
  }
});
