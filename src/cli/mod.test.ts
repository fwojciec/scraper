import { assertEquals, assertStringIncludes } from "@std/assert";
import { type CliDeps, runCli } from "./mod.ts";
import type { ScraperApp } from "../domain/mod.ts";

function stubApp(overrides: Partial<ScraperApp> = {}): ScraperApp {
  return {
    navigate: () => Promise.resolve({}),
    snapshot: () => Promise.resolve({ yaml: "- heading", refs: {}, lastRefCounter: 0 }),
    evaluate: () => Promise.resolve({ result: null }),
    screenshot: () => Promise.resolve("/tmp/shot.png"),
    pages: () => Promise.resolve([]),
    selectPage: () => Promise.resolve(),
    wait: () => Promise.resolve(),
    upload: () => Promise.resolve({}),
    ...overrides,
  };
}

function stubDeps(
  overrides: {
    app?: Partial<ScraperApp>;
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
  } = {},
): CliDeps {
  return {
    app: stubApp(overrides.app),
    stdout: overrides.stdout ?? (() => {}),
    stderr: overrides.stderr ?? (() => {}),
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

Deno.test("usage no longer lists deleted commands", async () => {
  const io = capture();
  await runCli([], stubDeps({ stderr: io.stderr }));
  for (const cmd of ["click", "fill", "type", "select", "submit", "press-key", "pages", "page"]) {
    assertEquals(
      io.err.match(new RegExp(`^\\s+${cmd}\\b`, "m")),
      null,
      `usage should not list '${cmd}'`,
    );
  }
});

Deno.test("removed commands report as unknown", async () => {
  for (const cmd of ["click", "fill", "type", "select", "submit", "press-key", "pages", "page"]) {
    const io = capture();
    const code = await runCli([cmd], stubDeps({ stderr: io.stderr }));
    assertEquals(code, 1, `'${cmd}' should not be a known command`);
    assertStringIncludes(io.err, "unknown command");
  }
});

// --- navigate ---

Deno.test("navigate calls dep with url and prints confirmation", async () => {
  let navigatedUrl = "";
  const io = capture();
  const code = await runCli(
    ["navigate", "https://example.com"],
    stubDeps({
      app: {
        navigate: (url) => {
          navigatedUrl = url;
          return Promise.resolve({});
        },
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
      app: { navigate: () => Promise.reject(new Error("chrome is not running")) },
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
      app: {
        navigate: (_url, opts) => {
          assertEquals(opts?.includeSnapshot, true);
          return Promise.resolve({
            snapshot: { yaml: "- heading\n", refs: {}, lastRefCounter: 0 },
          });
        },
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
      app: { snapshot: () => Promise.resolve({ yaml, refs: {}, lastRefCounter: 0 }) },
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
      app: {
        snapshot: (opts: Record<string, unknown>) => {
          receivedOpts = { ...opts };
          return Promise.resolve({ yaml: "- heading", refs: {}, lastRefCounter: 0 });
        },
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
      app: { snapshot: () => Promise.reject(new Error("chrome is not running")) },
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
      app: {
        evaluate: (expr) => {
          receivedExpr = expr;
          return Promise.resolve({ result: { title: "Test" } });
        },
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
      app: { evaluate: () => Promise.reject(new Error("chrome is not running")) },
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
      app: { screenshot: () => Promise.resolve("/tmp/shot.png") },
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
      app: {
        screenshot: (fullPage) => {
          receivedFullPage = fullPage;
          return Promise.resolve("/tmp/shot.png");
        },
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
      app: { screenshot: () => Promise.reject(new Error("chrome is not running")) },
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "chrome is not running");
});

// --- wait ---

Deno.test("wait --selector calls dep with selector request", async () => {
  let receivedRequest: unknown;
  const io = capture();
  const code = await runCli(
    ["wait", "--selector", ".result"],
    stubDeps({
      app: {
        wait: (request) => {
          receivedRequest = request;
          return Promise.resolve();
        },
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedRequest, {
    kind: "selector",
    selector: ".result",
    timeoutMs: undefined,
  });
  assertStringIncludes(io.out, 'found element matching ".result"');
});

Deno.test("wait --text calls dep with text request", async () => {
  let receivedRequest: unknown;
  const io = capture();
  const code = await runCli(
    ["wait", "--text", "Success"],
    stubDeps({
      app: {
        wait: (request) => {
          receivedRequest = request;
          return Promise.resolve();
        },
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedRequest, { kind: "text", text: "Success", timeoutMs: undefined });
  assertStringIncludes(io.out, 'found text "Success"');
});

Deno.test("wait --ref --text calls dep with textInElement request", async () => {
  let receivedRequest: unknown;
  const io = capture();
  const code = await runCli(
    ["wait", "--ref", "e5", "--text", "Done"],
    stubDeps({
      app: {
        wait: (request) => {
          receivedRequest = request;
          return Promise.resolve();
        },
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedRequest, {
    kind: "textInElement",
    target: { ref: "e5" },
    text: "Done",
    timeoutMs: undefined,
  });
  assertStringIncludes(io.out, 'found text "Done" in ref e5');
});

Deno.test("wait --selector --text calls dep with textInElement request", async () => {
  let receivedRequest: unknown;
  const io = capture();
  const code = await runCli(
    ["wait", "--selector", ".result", "--text", "OK"],
    stubDeps({
      app: {
        wait: (request) => {
          receivedRequest = request;
          return Promise.resolve();
        },
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedRequest, {
    kind: "textInElement",
    target: { selector: ".result" },
    text: "OK",
    timeoutMs: undefined,
  });
  assertStringIncludes(io.out, 'found text "OK" in selector ".result"');
});

Deno.test("wait --timeout passes timeout to dep", async () => {
  let receivedRequest: unknown;
  const code = await runCli(
    ["wait", "--text", "OK", "--timeout", "3000"],
    stubDeps({
      app: {
        wait: (request) => {
          receivedRequest = request;
          return Promise.resolve();
        },
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals((receivedRequest as { timeoutMs: number }).timeoutMs, 3000);
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
      app: {
        wait: () => Promise.reject(new Error('timed out waiting for text "never" (5000ms)')),
      },
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "timed out");
});

// --- upload ---

Deno.test("upload --ref with path calls dep correctly", async () => {
  let receivedTarget: unknown;
  let receivedPath: string | undefined;
  const io = capture();
  const code = await runCli(
    ["upload", "--ref", "e4", "./document.pdf"],
    stubDeps({
      app: {
        upload: (target, filePath) => {
          receivedTarget = target;
          receivedPath = filePath;
          return Promise.resolve({});
        },
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
      app: {
        upload: (target) => {
          receivedTarget = target;
          return Promise.resolve({});
        },
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
      app: {
        upload: (_target, _path, opts) => {
          assertEquals(opts?.includeSnapshot, true);
          return Promise.resolve({
            snapshot: { yaml: "- textbox\n", refs: {}, lastRefCounter: 0 },
          });
        },
      },
      stdout: io.stdout,
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.err, "uploaded");
  assertStringIncludes(io.out, "- textbox");
});

Deno.test("navigate rejects --on-dialog with a clear error", async () => {
  const io = capture();
  const code = await runCli(
    ["navigate", "https://example.com", "--on-dialog", "accept"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "--on-dialog is not supported");
});

Deno.test("upload rejects --on-dialog with a clear error", async () => {
  const io = capture();
  const code = await runCli(
    ["upload", "--ref", "e4", "./photo.jpg", "--on-dialog", "accept"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "--on-dialog is not supported");
});

Deno.test("upload reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["upload", "--ref", "e4", "./photo.jpg"],
    stubDeps({
      app: { upload: () => Promise.reject(new Error("element is not a file input")) },
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "element is not a file input");
});
