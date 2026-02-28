import { assertEquals, assertStringIncludes } from "@std/assert";
import { type CliDeps, runCli } from "./mod.ts";

function stubDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    startChrome: () =>
      Promise.resolve({ status: "started" as const, chromePid: 456, cdpPort: 9222 }),
    stopChrome: () => Promise.resolve(),
    navigate: () => Promise.resolve(),
    snapshot: () => Promise.resolve({ yaml: "- heading" }),
    evaluate: () => Promise.resolve({ result: null }),
    screenshot: () => Promise.resolve("/tmp/shot.png"),
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
        return Promise.resolve();
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

// --- snapshot ---

Deno.test("snapshot prints YAML", async () => {
  const io = capture();
  const yaml = '- main:\n    - heading "Hello"';
  const code = await runCli(
    ["snapshot"],
    stubDeps({
      snapshot: () => Promise.resolve({ yaml }),
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
      snapshot: (opts) => {
        receivedOpts = { ...opts };
        return Promise.resolve({ yaml: "- heading" });
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
