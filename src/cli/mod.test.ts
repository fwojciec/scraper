import { assertEquals, assertStringIncludes } from "@std/assert";
import { type CliDeps, runCli } from "./mod.ts";

function stubDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    startChrome: () =>
      Promise.resolve({ status: "started" as const, chromePid: 456, cdpPort: 9222 }),
    stopChrome: () => Promise.resolve(),
    navigate: () => Promise.resolve({}),
    snapshot: () => Promise.resolve({ yaml: "- heading", refs: {} }),
    evaluate: () => Promise.resolve({ result: null }),
    screenshot: () => Promise.resolve("/tmp/shot.png"),
    listPages: () => Promise.resolve([]),
    selectPage: () => Promise.resolve(),
    click: () => Promise.resolve({}),
    fill: () => Promise.resolve({}),
    wait: () => Promise.resolve(),
    type: () => Promise.resolve({}),
    selectOption: () => Promise.resolve({}),
    submit: () => Promise.resolve({}),
    pressKey: () => Promise.resolve({}),
    upload: () => Promise.resolve({}),
    stdout: () => {},
    stderr: () => {},
    ...overrides,
  };
}

function capture() {
  let out = "";
  let err = "";
  return {
    stdout(s: string) {
      out += s;
    },
    stderr(s: string) {
      err += s;
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

// --- No command / unknown command ---

Deno.test("no command prints usage and returns 1", async () => {
  const io = capture();
  const code = await runCli([], stubDeps({ stderr: io.stderr }));
  assertEquals(code, 1);
  assertStringIncludes(io.err, "Usage:");
});

Deno.test("unknown command prints error and returns 1", async () => {
  const io = capture();
  const code = await runCli(["bogus"], stubDeps({ stderr: io.stderr }));
  assertEquals(code, 1);
  assertStringIncludes(io.err, "unknown command");
  assertStringIncludes(io.err, "bogus");
});

// --- start ---

Deno.test("start prints started message with pid and port", async () => {
  const io = capture();
  const code = await runCli(
    ["start"],
    stubDeps({
      startChrome: () =>
        Promise.resolve({ status: "started" as const, chromePid: 456, cdpPort: 9222 }),
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.out, "chrome started");
  assertStringIncludes(io.out, "456");
  assertStringIncludes(io.out, "9222");
});

Deno.test("start with already running prints info", async () => {
  const io = capture();
  const code = await runCli(
    ["start"],
    stubDeps({
      startChrome: () =>
        Promise.resolve({ status: "already_running" as const, chromePid: 123, cdpPort: 9222 }),
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.out, "already running");
  assertStringIncludes(io.out, "123");
});

Deno.test("start passes --chrome-path option", async () => {
  let receivedPath: string | undefined;
  const code = await runCli(
    ["start", "--chrome-path", "/usr/bin/chromium"],
    stubDeps({
      startChrome: (opts) => {
        receivedPath = opts.chromePath;
        return Promise.resolve({ status: "started" as const, chromePid: 456, cdpPort: 9222 });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedPath, "/usr/bin/chromium");
});

Deno.test("start reports failure", async () => {
  const io = capture();
  const code = await runCli(
    ["start"],
    stubDeps({
      startChrome: () => Promise.reject(new Error("Chrome not found")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "Chrome not found");
});

// --- stop ---

Deno.test("stop prints chrome stopped", async () => {
  const io = capture();
  const code = await runCli(
    ["stop"],
    stubDeps({ stdout: io.stdout }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.out, "chrome stopped");
});

Deno.test("stop reports error", async () => {
  const io = capture();
  const code = await runCli(
    ["stop"],
    stubDeps({
      stopChrome: () => Promise.reject(new Error("chrome is not running")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "chrome is not running");
});

// --- navigate ---

Deno.test("navigate calls dep with url and prints confirmation", async () => {
  let navigatedUrl = "";
  const io = capture();
  const code = await runCli(
    ["navigate", "https://example.com"],
    stubDeps({
      navigate: (url) => {
        navigatedUrl = url;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(navigatedUrl, "https://example.com");
  assertStringIncludes(io.out, "https://example.com");
});

Deno.test("navigate without url returns error", async () => {
  const io = capture();
  const code = await runCli(["navigate"], stubDeps({ stderr: io.stderr }));
  assertEquals(code, 1);
  assertStringIncludes(io.err, "url is required");
});

Deno.test("navigate reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["navigate", "https://example.com"],
    stubDeps({
      navigate: () => Promise.reject(new Error("chrome is not running")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "chrome is not running");
});

Deno.test("navigate --snapshot outputs YAML to stdout and status to stderr", async () => {
  const io = capture();
  const code = await runCli(
    ["navigate", "https://example.com", "--snapshot"],
    stubDeps({
      navigate: (_url, opts) => {
        assertEquals(opts?.includeSnapshot, true);
        return Promise.resolve({ snapshot: { yaml: "- heading\n", refs: {} } });
      },
      stdout: io.stdout,
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.err, "navigated to https://example.com");
  assertStringIncludes(io.out, "- heading");
});

// --- snapshot ---

Deno.test("snapshot prints YAML", async () => {
  const io = capture();
  const yaml = '- main:\n    - heading "Hello"';
  const code = await runCli(
    ["snapshot"],
    stubDeps({
      snapshot: () => Promise.resolve({ yaml, refs: {} }),
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(io.out, yaml);
});

Deno.test("snapshot passes all options", async () => {
  let receivedOpts: Record<string, unknown> = {};
  const code = await runCli(
    ["snapshot", "--max-depth", "5", "--max-nodes", "100", "--selector", "#main"],
    stubDeps({
      snapshot: (opts: Record<string, unknown>) => {
        receivedOpts = { ...opts };
        return Promise.resolve({ yaml: "- heading", refs: {} });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedOpts.maxDepth, 5);
  assertEquals(receivedOpts.maxNodes, 100);
  assertEquals(receivedOpts.selector, "#main");
});

Deno.test("snapshot rejects malformed --max-depth", async () => {
  const io = capture();
  const code = await runCli(
    ["snapshot", "--max-depth", "deep"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "--max-depth must be a number");
});

Deno.test("snapshot reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["snapshot"],
    stubDeps({
      snapshot: () => Promise.reject(new Error("chrome is not running")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "chrome is not running");
});

// --- eval ---

Deno.test("eval calls dep with expression and prints JSON result", async () => {
  let receivedExpr = "";
  const io = capture();
  const code = await runCli(
    ["eval", "document.title"],
    stubDeps({
      evaluate: (expr) => {
        receivedExpr = expr;
        return Promise.resolve({ result: { title: "Test" } });
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedExpr, "document.title");
  assertEquals(io.out, JSON.stringify({ title: "Test" }, null, 2) + "\n");
});

Deno.test("eval without expression returns error", async () => {
  const io = capture();
  const code = await runCli(["eval"], stubDeps({ stderr: io.stderr }));
  assertEquals(code, 1);
  assertStringIncludes(io.err, "expression is required");
});

Deno.test("eval reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["eval", "1+1"],
    stubDeps({
      evaluate: () => Promise.reject(new Error("chrome is not running")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "chrome is not running");
});

// --- screenshot ---

Deno.test("screenshot prints path", async () => {
  const io = capture();
  const code = await runCli(
    ["screenshot"],
    stubDeps({
      screenshot: () => Promise.resolve("/tmp/shot.png"),
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(io.out, "/tmp/shot.png\n");
});

Deno.test("screenshot passes --full-page option", async () => {
  let receivedFullPage: boolean | undefined;
  const code = await runCli(
    ["screenshot", "--full-page"],
    stubDeps({
      screenshot: (fullPage) => {
        receivedFullPage = fullPage;
        return Promise.resolve("/tmp/shot.png");
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedFullPage, true);
});

Deno.test("screenshot reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["screenshot"],
    stubDeps({
      screenshot: () => Promise.reject(new Error("chrome is not running")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "chrome is not running");
});

// --- start --attach ---

Deno.test("start --attach prints attached message with port", async () => {
  const io = capture();
  const code = await runCli(
    ["start", "--attach"],
    stubDeps({
      startChrome: (opts) => {
        assertEquals(opts.attach, true);
        return Promise.resolve({ status: "attached" as const, cdpPort: 9333 });
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.out, "attached to Chrome");
  assertStringIncludes(io.out, "9333");
  assertStringIncludes(io.out, "scraper pages");
});

Deno.test("start --attach --channel passes channel option", async () => {
  let receivedChannel: string | undefined;
  const code = await runCli(
    ["start", "--attach", "--channel", "beta"],
    stubDeps({
      startChrome: (opts) => {
        receivedChannel = opts.channel;
        return Promise.resolve({ status: "attached" as const, cdpPort: 9333 });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedChannel, "beta");
});

Deno.test("start already attached prints info without pid", async () => {
  const io = capture();
  const code = await runCli(
    ["start", "--attach"],
    stubDeps({
      startChrome: () => Promise.resolve({ status: "already_running" as const, cdpPort: 9333 }),
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.out, "already attached");
  assertStringIncludes(io.out, "9333");
});

// --- pages ---

Deno.test("pages lists open tabs", async () => {
  const io = capture();
  const code = await runCli(
    ["pages"],
    stubDeps({
      listPages: () =>
        Promise.resolve([
          { pageId: "abc", url: "https://example.com", title: "Example", active: true },
          { pageId: "def", url: "about:blank", title: "", active: false },
        ]),
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.out, "* abc");
  assertStringIncludes(io.out, "Example");
  assertStringIncludes(io.out, "  def");
});

Deno.test("pages shows message when no tabs", async () => {
  const io = capture();
  const code = await runCli(
    ["pages"],
    stubDeps({
      listPages: () => Promise.resolve([]),
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.out, "no open tabs");
});

Deno.test("pages reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["pages"],
    stubDeps({
      listPages: () => Promise.reject(new Error("chrome is not running")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "chrome is not running");
});

// --- page ---

Deno.test("page switches active tab", async () => {
  let receivedId = "";
  const io = capture();
  const code = await runCli(
    ["page", "abc-123"],
    stubDeps({
      selectPage: (id) => {
        receivedId = id;
        return Promise.resolve();
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedId, "abc-123");
  assertStringIncludes(io.out, "switched to page abc-123");
});

Deno.test("page without pageId returns error", async () => {
  const io = capture();
  const code = await runCli(["page"], stubDeps({ stderr: io.stderr }));
  assertEquals(code, 1);
  assertStringIncludes(io.err, "pageId is required");
});

Deno.test("page reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["page", "abc-123"],
    stubDeps({
      selectPage: () => Promise.reject(new Error("no page with id")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "no page with id");
});

// --- click ---

Deno.test("click --ref calls dep with ref target", async () => {
  let receivedTarget: unknown;
  const io = capture();
  const code = await runCli(
    ["click", "--ref", "e5"],
    stubDeps({
      click: (target) => {
        receivedTarget = target;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTarget, { ref: "e5" });
  assertStringIncludes(io.out, "clicked ref e5");
});

Deno.test("click --selector calls dep with selector target", async () => {
  let receivedTarget: unknown;
  const io = capture();
  const code = await runCli(
    ["click", "--selector", "#btn"],
    stubDeps({
      click: (target) => {
        receivedTarget = target;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTarget, { selector: "#btn" });
  assertStringIncludes(io.out, 'clicked selector "#btn"');
});

Deno.test("click without target returns error", async () => {
  const io = capture();
  const code = await runCli(["click"], stubDeps({ stderr: io.stderr }));
  assertEquals(code, 1);
  assertStringIncludes(io.err, "either --ref or --selector is required");
});

Deno.test("click with both --ref and --selector returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["click", "--ref", "e5", "--selector", "#btn"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "not both");
});

Deno.test("click --snapshot outputs YAML", async () => {
  const io = capture();
  const code = await runCli(
    ["click", "--ref", "e5", "--snapshot"],
    stubDeps({
      click: (_target, opts) => {
        assertEquals(opts?.includeSnapshot, true);
        return Promise.resolve({ snapshot: { yaml: "- button\n", refs: {} } });
      },
      stdout: io.stdout,
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.err, "clicked ref e5");
  assertStringIncludes(io.out, "- button");
});

Deno.test("click reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["click", "--ref", "e5"],
    stubDeps({
      click: () => Promise.reject(new Error("ref e5 is stale")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "ref e5 is stale");
});

// --- fill ---

Deno.test("fill --ref with value calls dep correctly", async () => {
  let receivedTarget: unknown;
  let receivedValue: string | undefined;
  const io = capture();
  const code = await runCli(
    ["fill", "--ref", "e3", "hello world"],
    stubDeps({
      fill: (target, value) => {
        receivedTarget = target;
        receivedValue = value;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTarget, { ref: "e3" });
  assertEquals(receivedValue, "hello world");
  assertStringIncludes(io.out, "filled ref e3");
});

Deno.test("fill --selector with value calls dep correctly", async () => {
  let receivedTarget: unknown;
  const io = capture();
  const code = await runCli(
    ["fill", "--selector", "input[name=email]", "test@example.com"],
    stubDeps({
      fill: (target) => {
        receivedTarget = target;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTarget, { selector: "input[name=email]" });
});

Deno.test("fill without value returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["fill", "--ref", "e3"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "value is required");
});

Deno.test("fill without target returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["fill", "hello"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "either --ref or --selector is required");
});

Deno.test("fill --snapshot outputs YAML", async () => {
  const io = capture();
  const code = await runCli(
    ["fill", "--ref", "e3", "hello", "--snapshot"],
    stubDeps({
      fill: (_target, _value, opts) => {
        assertEquals(opts?.includeSnapshot, true);
        return Promise.resolve({ snapshot: { yaml: "- textbox\n", refs: {} } });
      },
      stdout: io.stdout,
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.err, "filled ref e3");
  assertStringIncludes(io.out, "- textbox");
});

Deno.test("fill reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["fill", "--ref", "e3", "hello"],
    stubDeps({
      fill: () => Promise.reject(new Error("chrome is not running")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "chrome is not running");
});

// --- wait ---

Deno.test("wait --selector calls dep with selector target", async () => {
  let receivedOpts: unknown;
  const io = capture();
  const code = await runCli(
    ["wait", "--selector", ".result"],
    stubDeps({
      wait: (opts) => {
        receivedOpts = opts;
        return Promise.resolve();
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedOpts, {
    target: { selector: ".result" },
    text: undefined,
    timeoutMs: undefined,
  });
  assertStringIncludes(io.out, 'found element matching ".result"');
});

Deno.test("wait --text calls dep with text only", async () => {
  let receivedOpts: unknown;
  const io = capture();
  const code = await runCli(
    ["wait", "--text", "Success"],
    stubDeps({
      wait: (opts) => {
        receivedOpts = opts;
        return Promise.resolve();
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedOpts, { target: undefined, text: "Success", timeoutMs: undefined });
  assertStringIncludes(io.out, 'found text "Success"');
});

Deno.test("wait --ref --text calls dep with ref target and text", async () => {
  let receivedOpts: unknown;
  const io = capture();
  const code = await runCli(
    ["wait", "--ref", "e5", "--text", "Done"],
    stubDeps({
      wait: (opts) => {
        receivedOpts = opts;
        return Promise.resolve();
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedOpts, { target: { ref: "e5" }, text: "Done", timeoutMs: undefined });
  assertStringIncludes(io.out, 'found text "Done" in ref e5');
});

Deno.test("wait --selector --text calls dep with selector and text", async () => {
  let receivedOpts: unknown;
  const io = capture();
  const code = await runCli(
    ["wait", "--selector", ".result", "--text", "OK"],
    stubDeps({
      wait: (opts) => {
        receivedOpts = opts;
        return Promise.resolve();
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedOpts, { target: { selector: ".result" }, text: "OK", timeoutMs: undefined });
  assertStringIncludes(io.out, 'found text "OK" in selector ".result"');
});

Deno.test("wait --timeout passes timeout to dep", async () => {
  let receivedOpts: unknown;
  const code = await runCli(
    ["wait", "--text", "OK", "--timeout", "3000"],
    stubDeps({
      wait: (opts) => {
        receivedOpts = opts;
        return Promise.resolve();
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals((receivedOpts as { timeoutMs: number }).timeoutMs, 3000);
});

Deno.test("wait --ref without --text returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["wait", "--ref", "e5"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "--ref requires --text");
});

Deno.test("wait without any condition returns error", async () => {
  const io = capture();
  const code = await runCli(["wait"], stubDeps({ stderr: io.stderr }));
  assertEquals(code, 1);
  assertStringIncludes(io.err, "at least one of");
});

Deno.test("wait --ref and --selector returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["wait", "--ref", "e5", "--selector", ".x", "--text", "hi"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "not both");
});

Deno.test("wait reports timeout error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["wait", "--text", "never"],
    stubDeps({
      wait: () => Promise.reject(new Error('timed out waiting for text "never" (5000ms)')),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "timed out");
});

// --- type ---

Deno.test("type --ref with text calls dep correctly", async () => {
  let receivedTarget: unknown;
  let receivedText: string | undefined;
  const io = capture();
  const code = await runCli(
    ["type", "--ref", "e3", "hello world"],
    stubDeps({
      type: (target, text) => {
        receivedTarget = target;
        receivedText = text;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTarget, { ref: "e3" });
  assertEquals(receivedText, "hello world");
  assertStringIncludes(io.out, "typed into ref e3");
});

Deno.test("type --selector with text calls dep correctly", async () => {
  let receivedTarget: unknown;
  const io = capture();
  const code = await runCli(
    ["type", "--selector", "#input", "test"],
    stubDeps({
      type: (target) => {
        receivedTarget = target;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTarget, { selector: "#input" });
  assertStringIncludes(io.out, 'typed into selector "#input"');
});

Deno.test("type without text returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["type", "--ref", "e3"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "text is required");
});

Deno.test("type without target returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["type", "hello"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "either --ref or --selector is required");
});

Deno.test("type --snapshot outputs YAML", async () => {
  const io = capture();
  const code = await runCli(
    ["type", "--ref", "e3", "hello", "--snapshot"],
    stubDeps({
      type: (_target, _text, opts) => {
        assertEquals(opts?.includeSnapshot, true);
        return Promise.resolve({ snapshot: { yaml: "- textbox\n", refs: {} } });
      },
      stdout: io.stdout,
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.err, "typed into ref e3");
  assertStringIncludes(io.out, "- textbox");
});

Deno.test("type reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["type", "--ref", "e3", "hello"],
    stubDeps({
      type: () => Promise.reject(new Error("chrome is not running")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "chrome is not running");
});

// --- select ---

Deno.test("select --ref with value calls dep correctly", async () => {
  let receivedTarget: unknown;
  let receivedValue: string | undefined;
  const io = capture();
  const code = await runCli(
    ["select", "--ref", "e3", "red"],
    stubDeps({
      selectOption: (target, value) => {
        receivedTarget = target;
        receivedValue = value;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTarget, { ref: "e3" });
  assertEquals(receivedValue, "red");
  assertStringIncludes(io.out, 'selected "red" in ref e3');
});

Deno.test("select --selector with value calls dep correctly", async () => {
  let receivedTarget: unknown;
  const io = capture();
  const code = await runCli(
    ["select", "--selector", "#color", "blue"],
    stubDeps({
      selectOption: (target) => {
        receivedTarget = target;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTarget, { selector: "#color" });
  assertStringIncludes(io.out, 'selected "blue" in selector "#color"');
});

Deno.test("select without value returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["select", "--ref", "e3"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "value is required");
});

Deno.test("select without target returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["select", "red"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "either --ref or --selector is required");
});

Deno.test("select --snapshot outputs YAML", async () => {
  const io = capture();
  const code = await runCli(
    ["select", "--ref", "e3", "red", "--snapshot"],
    stubDeps({
      selectOption: (_target, _value, opts) => {
        assertEquals(opts?.includeSnapshot, true);
        return Promise.resolve({ snapshot: { yaml: "- combobox\n", refs: {} } });
      },
      stdout: io.stdout,
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.err, 'selected "red" in ref e3');
  assertStringIncludes(io.out, "- combobox");
});

Deno.test("select reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["select", "--ref", "e3", "red"],
    stubDeps({
      selectOption: () => Promise.reject(new Error("chrome is not running")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "chrome is not running");
});

// --- submit ---

Deno.test("submit --ref calls dep correctly", async () => {
  let receivedTarget: unknown;
  const io = capture();
  const code = await runCli(
    ["submit", "--ref", "e2"],
    stubDeps({
      submit: (target) => {
        receivedTarget = target;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTarget, { ref: "e2" });
  assertStringIncludes(io.out, "submitted ref e2");
});

Deno.test("submit --selector calls dep correctly", async () => {
  let receivedTarget: unknown;
  const io = capture();
  const code = await runCli(
    ["submit", "--selector", "form"],
    stubDeps({
      submit: (target) => {
        receivedTarget = target;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTarget, { selector: "form" });
  assertStringIncludes(io.out, 'submitted selector "form"');
});

Deno.test("submit without target returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["submit"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "either --ref or --selector is required");
});

Deno.test("submit --snapshot outputs YAML", async () => {
  const io = capture();
  const code = await runCli(
    ["submit", "--ref", "e2", "--snapshot"],
    stubDeps({
      submit: (_target, opts) => {
        assertEquals(opts?.includeSnapshot, true);
        return Promise.resolve({ snapshot: { yaml: "- form\n", refs: {} } });
      },
      stdout: io.stdout,
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.err, "submitted ref e2");
  assertStringIncludes(io.out, "- form");
});

Deno.test("submit reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["submit", "--ref", "e2"],
    stubDeps({
      submit: () => Promise.reject(new Error("no form found")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "no form found");
});

// --- press-key ---

Deno.test("press-key with key name calls dep correctly", async () => {
  let receivedKey: string | undefined;
  const io = capture();
  const code = await runCli(
    ["press-key", "Enter"],
    stubDeps({
      pressKey: (key) => {
        receivedKey = key;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedKey, "Enter");
  assertStringIncludes(io.out, "pressed Enter");
});

Deno.test("press-key with --ref focuses element first", async () => {
  let receivedKey: string | undefined;
  let receivedTarget: unknown;
  const io = capture();
  const code = await runCli(
    ["press-key", "Tab", "--ref", "e5"],
    stubDeps({
      pressKey: (key, target) => {
        receivedKey = key;
        receivedTarget = target;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedKey, "Tab");
  assertEquals(receivedTarget, { ref: "e5" });
  assertStringIncludes(io.out, "pressed Tab on ref e5");
});

Deno.test("press-key with --selector focuses element first", async () => {
  let receivedTarget: unknown;
  const io = capture();
  const code = await runCli(
    ["press-key", "Escape", "--selector", "#modal"],
    stubDeps({
      pressKey: (_key, target) => {
        receivedTarget = target;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTarget, { selector: "#modal" });
  assertStringIncludes(io.out, 'pressed Escape on selector "#modal"');
});

Deno.test("press-key without key returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["press-key"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "key is required");
});

Deno.test("press-key --snapshot outputs YAML", async () => {
  const io = capture();
  const code = await runCli(
    ["press-key", "Enter", "--snapshot"],
    stubDeps({
      pressKey: (_key, _target, opts) => {
        assertEquals(opts?.includeSnapshot, true);
        return Promise.resolve({ snapshot: { yaml: "- button\n", refs: {} } });
      },
      stdout: io.stdout,
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.err, "pressed Enter");
  assertStringIncludes(io.out, "- button");
});

Deno.test("press-key reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["press-key", "Enter"],
    stubDeps({
      pressKey: () => Promise.reject(new Error("chrome is not running")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "chrome is not running");
});

// --- upload ---

Deno.test("upload --ref with path calls dep correctly", async () => {
  let receivedTarget: unknown;
  let receivedPath: string | undefined;
  const io = capture();
  const code = await runCli(
    ["upload", "--ref", "e4", "./document.pdf"],
    stubDeps({
      upload: (target, filePath) => {
        receivedTarget = target;
        receivedPath = filePath;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTarget, { ref: "e4" });
  assertEquals(receivedPath, "./document.pdf");
  assertStringIncludes(io.out, "uploaded");
});

Deno.test("upload --selector with path calls dep correctly", async () => {
  let receivedTarget: unknown;
  const io = capture();
  const code = await runCli(
    ["upload", "--selector", "input[type=file]", "./photo.jpg"],
    stubDeps({
      upload: (target) => {
        receivedTarget = target;
        return Promise.resolve({});
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTarget, { selector: "input[type=file]" });
  assertStringIncludes(io.out, "uploaded");
});

Deno.test("upload without path returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["upload", "--ref", "e4"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "file path is required");
});

Deno.test("upload without target returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["upload", "./photo.jpg"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "either --ref or --selector is required");
});

Deno.test("upload --snapshot outputs YAML", async () => {
  const io = capture();
  const code = await runCli(
    ["upload", "--ref", "e4", "./photo.jpg", "--snapshot"],
    stubDeps({
      upload: (_target, _path, opts) => {
        assertEquals(opts?.includeSnapshot, true);
        return Promise.resolve({ snapshot: { yaml: "- textbox\n", refs: {} } });
      },
      stdout: io.stdout,
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.err, "uploaded");
  assertStringIncludes(io.out, "- textbox");
});

Deno.test("upload reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["upload", "--ref", "e4", "./photo.jpg"],
    stubDeps({
      upload: () => Promise.reject(new Error("element is not a file input")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "element is not a file input");
});

// --- --on-dialog flag ---

Deno.test("click --on-dialog accept passes policy to dep", async () => {
  let receivedOpts: unknown;
  const code = await runCli(
    ["click", "--ref", "e5", "--on-dialog", "accept"],
    stubDeps({
      click: (_target, opts) => {
        receivedOpts = opts;
        return Promise.resolve({});
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(
    (receivedOpts as { onDialog: unknown }).onDialog,
    { action: "accept" },
  );
});

Deno.test("click --on-dialog dismiss passes policy to dep", async () => {
  let receivedOpts: unknown;
  const code = await runCli(
    ["click", "--ref", "e5", "--on-dialog", "dismiss"],
    stubDeps({
      click: (_target, opts) => {
        receivedOpts = opts;
        return Promise.resolve({});
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(
    (receivedOpts as { onDialog: unknown }).onDialog,
    { action: "dismiss" },
  );
});

Deno.test("click --on-dialog accept:answer passes prompt text", async () => {
  let receivedOpts: unknown;
  const code = await runCli(
    ["click", "--ref", "e5", "--on-dialog", "accept:hello"],
    stubDeps({
      click: (_target, opts) => {
        receivedOpts = opts;
        return Promise.resolve({});
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(
    (receivedOpts as { onDialog: unknown }).onDialog,
    { action: "accept", text: "hello" },
  );
});

Deno.test("navigate --on-dialog accept passes policy", async () => {
  let receivedOpts: unknown;
  const code = await runCli(
    ["navigate", "https://example.com", "--on-dialog", "accept"],
    stubDeps({
      navigate: (_url, opts) => {
        receivedOpts = opts;
        return Promise.resolve({});
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(
    (receivedOpts as { onDialog: unknown }).onDialog,
    { action: "accept" },
  );
});

Deno.test("fill --on-dialog dismiss passes policy", async () => {
  let receivedOpts: unknown;
  const code = await runCli(
    ["fill", "--ref", "e3", "hello", "--on-dialog", "dismiss"],
    stubDeps({
      fill: (_target, _value, opts) => {
        receivedOpts = opts;
        return Promise.resolve({});
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(
    (receivedOpts as { onDialog: unknown }).onDialog,
    { action: "dismiss" },
  );
});

Deno.test("--on-dialog with invalid value returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["click", "--ref", "e5", "--on-dialog", "bogus"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "invalid --on-dialog value");
});
