/** Integration tests for click, fill, wait actions with real Chrome. */

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

Deno.test("actions: click, fill, wait, navigate --snapshot", async () => {
  const tmpHome = await Deno.makeTempDir();
  const fixtures = startFixtureServer();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    // Start Chrome
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    // Navigate to actions fixture
    const nav = await runScraper(
      ["navigate", fixtures.url("actions.html")],
      env,
    );
    assertEquals(nav.code, 0, `navigate failed: ${nav.stderr}`);

    // Snapshot to get refs
    const snap = await runScraper(["snapshot"], env);
    assertEquals(snap.code, 0, `snapshot failed: ${snap.stderr}`);
    assert(snap.stdout.includes("textbox"), "should contain textbox role");
    assert(snap.stdout.includes("button"), "should contain button role");
    assert(snap.stdout.includes("ref="), "should have refs");

    // Verify refs.json was written
    const refsPath = `${tmpHome}/.scraper/refs.json`;
    const refsText = await Deno.readTextFile(refsPath);
    const refs = JSON.parse(refsText);
    assert(Object.keys(refs).length > 0, "refs.json should have entries");

    // Fill the name input using --selector
    const fill = await runScraper(
      ["fill", "--selector", "#name-input", "Alice"],
      env,
    );
    assertEquals(fill.code, 0, `fill failed: ${fill.stderr}`);
    assertStringIncludes(fill.stdout, "filled");

    // Click the greet button using --selector
    const click = await runScraper(
      ["click", "--selector", "#greet-btn"],
      env,
    );
    assertEquals(click.code, 0, `click failed: ${click.stderr}`);
    assertStringIncludes(click.stdout, "clicked");

    // Wait for the greeting text to appear
    const wait = await runScraper(
      ["wait", "--text", "Hello, Alice!"],
      env,
    );
    assertEquals(wait.code, 0, `wait failed: ${wait.stderr}`);
    assertStringIncludes(wait.stdout, "found text");

    // Verify the DOM state via eval
    const evalResult = await runScraper(
      ["eval", "document.getElementById('output').textContent"],
      env,
    );
    assertEquals(evalResult.code, 0, `eval failed: ${evalResult.stderr}`);
    assertStringIncludes(evalResult.stdout, "Hello, Alice!");

    // Test navigate --snapshot: outputs YAML and persists new refs
    const navSnap = await runScraper(
      ["navigate", fixtures.url("actions.html"), "--snapshot"],
      env,
    );
    assertEquals(navSnap.code, 0, `navigate --snapshot failed: ${navSnap.stderr}`);
    assertStringIncludes(navSnap.stderr, "navigated to");
    assert(navSnap.stdout.includes("textbox"), "snapshot YAML should be on stdout");

    // Verify refs.json was updated (should have entries)
    const newRefsText = await Deno.readTextFile(refsPath);
    const newRefs = JSON.parse(newRefsText);
    assert(
      Object.keys(newRefs).length > 0,
      "refs.json should have entries after navigate --snapshot",
    );

    // Test click --snapshot: performs click then snapshots
    const clickSnap = await runScraper(
      ["click", "--selector", "#greet-btn", "--snapshot"],
      env,
    );
    assertEquals(clickSnap.code, 0, `click --snapshot failed: ${clickSnap.stderr}`);
    assertStringIncludes(clickSnap.stderr, "clicked");
    assert(clickSnap.stdout.includes("button"), "snapshot YAML should be on stdout");

    // Test wait --selector: wait for element to exist
    const waitSel = await runScraper(
      ["wait", "--selector", "#output"],
      env,
    );
    assertEquals(waitSel.code, 0, `wait --selector failed: ${waitSel.stderr}`);
    assertStringIncludes(waitSel.stdout, "found element");

    // Test wait --selector --text: wait for text within element
    const waitSelText = await runScraper(
      ["wait", "--selector", "#output", "--text", "enter a name"],
      env,
    );
    assertEquals(waitSelText.code, 0, `wait --selector --text failed: ${waitSelText.stderr}`);
    assertStringIncludes(waitSelText.stdout, "found text");

    // Test navigate without --snapshot deletes refs.json
    const navNoSnap = await runScraper(
      ["navigate", fixtures.url("actions.html")],
      env,
    );
    assertEquals(navNoSnap.code, 0, `navigate (no --snapshot) failed: ${navNoSnap.stderr}`);
    try {
      await Deno.stat(refsPath);
      throw new Error("refs.json should have been deleted by navigate without --snapshot");
    } catch (e) {
      assert(e instanceof Deno.errors.NotFound, "refs.json should not exist");
    }

    // Test ambiguous selector error (>1 match)
    const clickAmbiguous = await runScraper(
      ["click", "--selector", "input"],
      env,
    );
    assertEquals(clickAmbiguous.code, 1, "ambiguous selector should fail");
    assertStringIncludes(clickAmbiguous.stderr, "matched");
    assertStringIncludes(clickAmbiguous.stderr, "expected exactly 1");

    // Test no-match selector error
    const clickNoMatch = await runScraper(
      ["click", "--selector", "#nonexistent"],
      env,
    );
    assertEquals(clickNoMatch.code, 1, "no-match selector should fail");
    assertStringIncludes(clickNoMatch.stderr, "did not match");

    // Test stale ref error: snapshot, navigate (clears refs), try to click old ref
    const snap2 = await runScraper(["snapshot"], env);
    assertEquals(snap2.code, 0, `snapshot2 failed: ${snap2.stderr}`);

    // Navigate clears refs.json
    await runScraper(["navigate", fixtures.url("actions.html")], env);

    // Now trying --ref should fail with "no refs available"
    const clickStale = await runScraper(
      ["click", "--ref", "e1"],
      env,
    );
    assertEquals(clickStale.code, 1, "stale ref should fail");
    assertStringIncludes(clickStale.stderr, "no refs available");

    // Stop
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

Deno.test("actions: click --ref uses persisted refs.json across processes", async () => {
  const tmpHome = await Deno.makeTempDir();
  const fixtures = startFixtureServer();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    // Start and navigate
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    await runScraper(["navigate", fixtures.url("actions.html")], env);

    // Snapshot (process 1) — persists refs.json
    const snap = await runScraper(["snapshot"], env);
    assertEquals(snap.code, 0, `snapshot failed: ${snap.stderr}`);

    // Read refs.json to find a ref for the name input
    const refsText = await Deno.readTextFile(`${tmpHome}/.scraper/refs.json`);
    const refs = JSON.parse(refsText);
    const refEntries = Object.entries(refs);
    assert(refEntries.length > 0, "should have refs");

    // Find the ref for the name input by looking at snapshot YAML
    // The textbox refs should be in the YAML — find the first ref
    const firstRef = refEntries[0][0];

    // Fill using --ref (process 2) — reads refs.json from disk
    const fill = await runScraper(
      ["fill", "--ref", firstRef, "Bob"],
      env,
    );
    assertEquals(fill.code, 0, `fill --ref failed: ${fill.stderr}`);
    assertStringIncludes(fill.stdout, `filled ref ${firstRef}`);

    // Stop
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

Deno.test("actions: type, select, submit, press-key", async () => {
  const tmpHome = await Deno.makeTempDir();
  const fixtures = startFixtureServer();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    // Start Chrome
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    // Navigate to actions fixture
    const nav = await runScraper(
      ["navigate", fixtures.url("actions.html")],
      env,
    );
    assertEquals(nav.code, 0, `navigate failed: ${nav.stderr}`);

    // --- type: types text character by character ---
    const typeResult = await runScraper(
      ["type", "--selector", "#name-input", "Alice"],
      env,
    );
    assertEquals(typeResult.code, 0, `type failed: ${typeResult.stderr}`);
    assertStringIncludes(typeResult.stdout, "typed into");

    // Verify the input value was set via typing
    const typedValue = await runScraper(
      ["eval", "document.getElementById('name-input').value"],
      env,
    );
    assertEquals(typedValue.code, 0, `eval typed value failed: ${typedValue.stderr}`);
    assertStringIncludes(typedValue.stdout, "Alice");

    // Verify input event fired (tracked by typed-output div)
    const typedOutput = await runScraper(
      ["eval", "document.getElementById('typed-output').textContent"],
      env,
    );
    assertEquals(typedOutput.code, 0);
    assertStringIncludes(typedOutput.stdout, "typed:Alice");

    // --- select: selects a dropdown option ---
    const selectResult = await runScraper(
      ["select", "--selector", "#color-select", "blue"],
      env,
    );
    assertEquals(selectResult.code, 0, `select failed: ${selectResult.stderr}`);
    assertStringIncludes(selectResult.stdout, "selected");

    // Verify the select value
    const selectValue = await runScraper(
      ["eval", "document.getElementById('color-select').value"],
      env,
    );
    assertEquals(selectValue.code, 0);
    assertStringIncludes(selectValue.stdout, "blue");

    // --- submit: submits the form ---
    const submitResult = await runScraper(
      ["submit", "--selector", "#test-form"],
      env,
    );
    assertEquals(submitResult.code, 0, `submit failed: ${submitResult.stderr}`);
    assertStringIncludes(submitResult.stdout, "submitted");

    // Verify the form was submitted (tracked by submit-output div)
    const submitOutput = await runScraper(
      ["eval", "document.getElementById('submit-output').textContent"],
      env,
    );
    assertEquals(submitOutput.code, 0);
    assertStringIncludes(submitOutput.stdout, "submitted: name=Alice, color=blue");

    // --- press-key: dispatches a key event ---
    // Clear the name input first
    await runScraper(["fill", "--selector", "#name-input", ""], env);

    // Type something then press Enter to verify keydown events
    await runScraper(["type", "--selector", "#name-input", "Bob"], env);

    const pressResult = await runScraper(
      ["press-key", "Enter", "--selector", "#name-input"],
      env,
    );
    assertEquals(pressResult.code, 0, `press-key failed: ${pressResult.stderr}`);
    assertStringIncludes(pressResult.stdout, "pressed Enter");

    // Verify keydown event was captured
    const keypressOutput = await runScraper(
      ["eval", "document.getElementById('keypress-output').textContent"],
      env,
    );
    assertEquals(keypressOutput.code, 0);
    assertStringIncludes(keypressOutput.stdout, "keydown:Enter");

    // --- type --snapshot ---
    const typeSnap = await runScraper(
      ["type", "--selector", "#name-input", "X", "--snapshot"],
      env,
    );
    assertEquals(typeSnap.code, 0, `type --snapshot failed: ${typeSnap.stderr}`);
    assertStringIncludes(typeSnap.stderr, "typed into");
    assert(typeSnap.stdout.includes("textbox"), "snapshot YAML should be on stdout");

    // --- select with invalid value ---
    const selectBad = await runScraper(
      ["select", "--selector", "#color-select", "purple"],
      env,
    );
    assertEquals(selectBad.code, 1, "select with invalid value should fail");
    assertStringIncludes(selectBad.stderr, "no option with value");

    // --- submit without form ---
    const submitNoForm = await runScraper(
      ["submit", "--selector", "h1"],
      env,
    );
    assertEquals(submitNoForm.code, 1, "submit on non-form element should fail");
    assertStringIncludes(submitNoForm.stderr, "no form found");

    // Stop
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

Deno.test("actions: upload sets file on input[type=file]", async () => {
  const tmpHome = await Deno.makeTempDir();
  const fixtures = startFixtureServer();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    await runScraper(["navigate", fixtures.url("actions.html")], env);

    // Create a temp file to upload
    const tmpFile = await Deno.makeTempFile({ suffix: ".txt" });
    await Deno.writeTextFile(tmpFile, "test content");

    // Upload the file
    const upload = await runScraper(
      ["upload", "--selector", "#file-input", tmpFile],
      env,
    );
    assertEquals(upload.code, 0, `upload failed: ${upload.stderr}`);
    assertStringIncludes(upload.stdout, "uploaded");

    // Verify the file was set (change event updates file-output div)
    const fileOutput = await runScraper(
      ["eval", "document.getElementById('file-output').textContent"],
      env,
    );
    assertEquals(fileOutput.code, 0);
    assertStringIncludes(fileOutput.stdout, "file:");

    // Upload on non-file-input should fail
    const uploadBad = await runScraper(
      ["upload", "--selector", "#name-input", tmpFile],
      env,
    );
    assertEquals(uploadBad.code, 1, "upload on non-file input should fail");
    assertStringIncludes(uploadBad.stderr, "not a file input");

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

Deno.test("actions: --on-dialog handles alert, confirm, prompt", async () => {
  const tmpHome = await Deno.makeTempDir();
  const fixtures = startFixtureServer();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    await runScraper(["navigate", fixtures.url("actions.html")], env);

    // Click alert button with --on-dialog accept
    const alertClick = await runScraper(
      ["click", "--selector", "#alert-btn", "--on-dialog", "accept"],
      env,
    );
    assertEquals(alertClick.code, 0, `alert click failed: ${alertClick.stderr}`);

    // Verify alert was handled and page continued
    const alertOutput = await runScraper(
      ["eval", "document.getElementById('dialog-output').textContent"],
      env,
    );
    assertEquals(alertOutput.code, 0);
    assertStringIncludes(alertOutput.stdout, "alert:done");

    // Click confirm button with --on-dialog dismiss
    const confirmClick = await runScraper(
      ["click", "--selector", "#confirm-btn", "--on-dialog", "dismiss"],
      env,
    );
    assertEquals(confirmClick.code, 0, `confirm click failed: ${confirmClick.stderr}`);

    const confirmOutput = await runScraper(
      ["eval", "document.getElementById('dialog-output').textContent"],
      env,
    );
    assertEquals(confirmOutput.code, 0);
    assertStringIncludes(confirmOutput.stdout, "confirm:false");

    // Click prompt button with --on-dialog accept:hello
    const promptClick = await runScraper(
      ["click", "--selector", "#prompt-btn", "--on-dialog", "accept:hello"],
      env,
    );
    assertEquals(promptClick.code, 0, `prompt click failed: ${promptClick.stderr}`);

    const promptOutput = await runScraper(
      ["eval", "document.getElementById('dialog-output').textContent"],
      env,
    );
    assertEquals(promptOutput.code, 0);
    assertStringIncludes(promptOutput.stdout, "prompt:hello");

    // Click alert button WITHOUT --on-dialog → should fail
    const noDialogClick = await runScraper(
      ["click", "--selector", "#alert-btn"],
      env,
    );
    assertEquals(noDialogClick.code, 1, "click triggering dialog without --on-dialog should fail");
    assertStringIncludes(noDialogClick.stderr, "a dialog appeared");

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

Deno.test("actions: wait --selector detects attribute changes", async () => {
  const tmpHome = await Deno.makeTempDir();
  const fixtures = startFixtureServer();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    await runScraper(["navigate", fixtures.url("actions.html")], env);

    // Click button that adds .ready class after 200ms
    await runScraper(["click", "--selector", "#add-class-btn"], env);

    // Wait for the class to be added
    const wait = await runScraper(
      ["wait", "--selector", "#attr-target.ready", "--timeout", "3000"],
      env,
    );
    assertEquals(wait.code, 0, `wait --selector for class failed: ${wait.stderr}`);
    assertStringIncludes(wait.stdout, "found element");

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

Deno.test("actions: wait --text detects style-driven visibility", async () => {
  const tmpHome = await Deno.makeTempDir();
  const fixtures = startFixtureServer();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    await runScraper(["navigate", fixtures.url("actions.html")], env);

    // Click button that removes display:none after 200ms
    await runScraper(["click", "--selector", "#show-text-btn"], env);

    // Wait for hidden text to become visible
    const wait = await runScraper(
      ["wait", "--text", "Secret Text", "--timeout", "3000"],
      env,
    );
    assertEquals(wait.code, 0, `wait --text for style visibility failed: ${wait.stderr}`);
    assertStringIncludes(wait.stdout, "found text");

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

Deno.test("actions: wait --text in element detects ancestor visibility change", async () => {
  const tmpHome = await Deno.makeTempDir();
  const fixtures = startFixtureServer();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    await runScraper(["navigate", fixtures.url("actions.html")], env);

    // Click button that removes display:none from parent after 200ms
    await runScraper(["click", "--selector", "#show-ancestor-btn"], env);

    // Wait for text in nested element to become visible via ancestor change
    const wait = await runScraper(
      ["wait", "--selector", "#nested-text", "--text", "Nested Secret", "--timeout", "3000"],
      env,
    );
    assertEquals(
      wait.code,
      0,
      `wait --text in element for ancestor visibility failed: ${wait.stderr}`,
    );
    assertStringIncludes(wait.stdout, "found text");

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

Deno.test("actions: wait --timeout times out with clear error", async () => {
  const tmpHome = await Deno.makeTempDir();
  const fixtures = startFixtureServer();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };

  try {
    const start = await runScraper(["start"], env);
    assertEquals(start.code, 0, `start failed: ${start.stderr}`);

    await runScraper(["navigate", fixtures.url("actions.html")], env);

    // Wait for text that doesn't exist with short timeout
    const wait = await runScraper(
      ["wait", "--text", "nonexistent text", "--timeout", "1000"],
      env,
    );
    assertEquals(wait.code, 1, "wait for missing text should fail");
    assertStringIncludes(wait.stderr, "timed out");

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
