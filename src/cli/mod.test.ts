import { assertEquals, assertStringIncludes } from "@std/assert";
import { type CliDeps, runCli, type TabInfo } from "./mod.ts";
import type { ScraperApp } from "../domain/mod.ts";

const FULL_TAB = "4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2";

function stubApp(overrides: Partial<ScraperApp> = {}): ScraperApp {
  return {
    navigate: () =>
      Promise.resolve({
        snapshot: {
          yaml: "- heading",
          refs: {},
          lastRefCounter: 0,
          snapshotId: "s1",
          title: "",
          url: "https://example.com/",
        },
      }),
    navigateNew: () =>
      Promise.resolve({
        targetId: FULL_TAB,
        snapshot: {
          yaml: "- heading",
          refs: {},
          lastRefCounter: 0,
          snapshotId: "s1",
          title: "",
          url: "about:blank",
        },
      }),
    snapshot: () =>
      Promise.resolve({
        yaml: "- heading",
        refs: {},
        lastRefCounter: 0,
        snapshotId: "s1",
        title: "",
        url: "https://example.com/",
      }),
    evaluate: () => Promise.resolve({ result: null }),
    screenshot: () => Promise.resolve("/tmp/shot.png"),
    wait: () =>
      Promise.resolve({
        snapshot: {
          yaml: "- heading",
          refs: {},
          lastRefCounter: 0,
          snapshotId: "s1",
          title: "",
          url: "https://example.com/",
        },
      }),
    upload: () => Promise.resolve({}),
    ...overrides,
  };
}

/**
 * Default canonicalizeTab that echoes the prefix to the full fixture id.
 * Override per-test for missing-flag / no-match / ambiguous scenarios.
 */
function stubCanonicalize(
  impl?: (input: string) => Promise<string>,
): (input: string) => Promise<string> {
  return impl ?? ((input: string) => {
    if (!input) {
      return Promise.reject(
        new Error(
          "--tab <targetId> is required. Run `scraper tabs` to list tabs, or `scraper navigate --new <url>` to open a new one.",
        ),
      );
    }
    if (FULL_TAB.startsWith(input)) return Promise.resolve(FULL_TAB);
    return Promise.reject(
      new Error(`no tab with prefix \`${input}\`; run \`scraper tabs\` to see available tabs.`),
    );
  });
}

function stubDeps(
  overrides: {
    app?: Partial<ScraperApp>;
    canonicalizeTab?: (input: string) => Promise<string>;
    listTabs?: () => Promise<TabInfo[]>;
    cleanupDeadRefs?: (liveIds: readonly string[]) => Promise<void>;
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
  } = {},
): CliDeps {
  return {
    app: stubApp(overrides.app),
    canonicalizeTab: stubCanonicalize(overrides.canonicalizeTab),
    listTabs: overrides.listTabs ?? (() => Promise.resolve([])),
    cleanupDeadRefs: overrides.cleanupDeadRefs ?? (() => Promise.resolve()),
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

// --- --tab canonicalization + error paths (shared across commands) ---

Deno.test("tab-scoped command without --tab reports missing-flag error verbatim", async () => {
  for (
    const argv of [
      ["navigate", "https://example.com"],
      ["snapshot"],
      ["eval", "document.title"],
      ["screenshot"],
      ["upload", "--ref", "e4", "./photo.jpg"],
      ["wait", "--text", "hi"],
    ]
  ) {
    const io = capture();
    const code = await runCli(argv, stubDeps({ stderr: io.stderr }));
    assertEquals(code, 1, `${argv[0]} without --tab should fail`);
    assertStringIncludes(
      io.err,
      "--tab <targetId> is required. Run `scraper tabs` to list tabs, or `scraper navigate --new <url>` to open a new one.",
    );
  }
});

Deno.test("--tab with unknown prefix reports no-match error verbatim", async () => {
  const io = capture();
  const code = await runCli(
    ["snapshot", "--tab", "zzzz"],
    stubDeps({
      canonicalizeTab: (input) =>
        Promise.reject(
          new Error(`no tab with prefix \`${input}\`; run \`scraper tabs\` to see available tabs.`),
        ),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(
    io.err,
    "no tab with prefix `zzzz`; run `scraper tabs` to see available tabs.",
  );
});

Deno.test("--tab with ambiguous prefix reports error with match count", async () => {
  const io = capture();
  const code = await runCli(
    ["snapshot", "--tab", "4A"],
    stubDeps({
      canonicalizeTab: (input) =>
        Promise.reject(
          new Error(
            `ambiguous prefix \`${input}\`, matches 3 tabs; provide more characters (full IDs are printed by \`scraper tabs\`).`,
          ),
        ),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(
    io.err,
    "ambiguous prefix `4A`, matches 3 tabs; provide more characters (full IDs are printed by `scraper tabs`).",
  );
});

Deno.test("--tab prefix is canonicalized and the full id is passed to the app", async () => {
  let receivedTargetId = "";
  const code = await runCli(
    ["snapshot", "--tab", "4AE7"],
    stubDeps({
      app: {
        snapshot: (targetId) => {
          receivedTargetId = targetId;
          return Promise.resolve({
            yaml: "",
            refs: {},
            lastRefCounter: 0,
            snapshotId: "s1",
            title: "",
            url: "https://example.com/",
          });
        },
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTargetId, FULL_TAB);
});

Deno.test("--tab full id is a no-op canonicalization (same id passed through)", async () => {
  let receivedTargetId = "";
  const code = await runCli(
    ["snapshot", "--tab", FULL_TAB],
    stubDeps({
      app: {
        snapshot: (targetId) => {
          receivedTargetId = targetId;
          return Promise.resolve({
            yaml: "",
            refs: {},
            lastRefCounter: 0,
            snapshotId: "s1",
            title: "",
            url: "https://example.com/",
          });
        },
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedTargetId, FULL_TAB);
});

// --- navigate ---

Deno.test("navigate --tab auto-snapshots and prints `navigated · snapshot ...` pointer", async () => {
  let navigatedUrl = "";
  let includeSnapshotArg: boolean | undefined;
  const io = capture();
  const yaml = "snapshot: s47\ntree: []\n";
  const expectedBytes = new TextEncoder().encode(yaml).byteLength;
  const code = await runCli(
    ["navigate", "--tab", "4AE7", "https://example.com"],
    stubDeps({
      app: {
        navigate: (_targetId, url, opts) => {
          navigatedUrl = url;
          includeSnapshotArg = opts?.includeSnapshot;
          return Promise.resolve({
            snapshot: {
              yaml,
              refs: { e1: 1, e2: 2, e3: 3 },
              lastRefCounter: 3,
              snapshotId: "s47",
              title: "Direct Medical Reimbursement",
              url: "https://example.com/",
            },
          });
        },
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(navigatedUrl, "https://example.com");
  // Auto-snapshot: navigate must always request a snapshot from the app.
  assertEquals(includeSnapshotArg, true);
  assertEquals(
    io.out,
    `navigated · snapshot s47 · Direct Medical Reimbursement · 3 refs · ${expectedBytes}B\n`,
  );
});

Deno.test("navigate without url returns error listing both --tab and --new usage", async () => {
  const io = capture();
  const code = await runCli(
    ["navigate", "--tab", "4AE7"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "url is required");
  assertStringIncludes(io.err, "--tab");
  assertStringIncludes(io.err, "--new");
});

Deno.test("navigate --new without url returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["navigate", "--new"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "url is required");
});

Deno.test("navigate reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["navigate", "--tab", "4AE7", "https://example.com"],
    stubDeps({
      app: { navigate: () => Promise.reject(new Error("chrome is not running")) },
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "chrome is not running");
});

Deno.test("navigate --new prints full targetId then snapshot pointer line", async () => {
  let receivedUrl = "";
  const io = capture();
  const yaml = "snapshot: s47\ntree: []\n";
  const expectedBytes = new TextEncoder().encode(yaml).byteLength;
  const code = await runCli(
    ["navigate", "--new", "https://example.com"],
    stubDeps({
      app: {
        navigateNew: (url) => {
          receivedUrl = url;
          return Promise.resolve({
            targetId: FULL_TAB,
            snapshot: {
              yaml,
              refs: { e1: 1 },
              lastRefCounter: 1,
              snapshotId: "s47",
              title: "Example Domain",
              url: "https://example.com/",
            },
          });
        },
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedUrl, "https://example.com");
  assertEquals(
    io.out,
    `${FULL_TAB}\nsnapshot s47 · Example Domain · 1 refs · ${expectedBytes}B\n`,
  );
});

Deno.test("navigate --new and --tab are mutually exclusive", async () => {
  const io = capture();
  const code = await runCli(
    ["navigate", "--new", "--tab", "4AE7", "https://example.com"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "mutually exclusive");
});

Deno.test("navigate --new reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["navigate", "--new", "https://example.com"],
    stubDeps({
      app: { navigateNew: () => Promise.reject(new Error("could not create target")) },
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "could not create target");
});

// --- snapshot ---

Deno.test("snapshot prints the one-line pointer (id · title · refs · bytes)", async () => {
  const io = capture();
  const yaml = 'snapshot: s47\ntree:\n  - heading "Hello"\n';
  const expectedBytes = new TextEncoder().encode(yaml).byteLength;
  const code = await runCli(
    ["snapshot", "--tab", "4AE7"],
    stubDeps({
      app: {
        snapshot: () =>
          Promise.resolve({
            yaml,
            refs: { e1: 10, e2: 20 },
            lastRefCounter: 2,
            snapshotId: "s47",
            title: "Direct Medical Reimbursement",
            url: "https://memberforms.uhc.com/",
          }),
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  // One line, trailing newline, exact pointer shape from the design doc.
  assertEquals(
    io.out,
    `snapshot s47 · Direct Medical Reimbursement · 2 refs · ${expectedBytes}B\n`,
  );
});

Deno.test("snapshot pointer flattens newlines/tabs in title to preserve one-line contract", async () => {
  const io = capture();
  const code = await runCli(
    ["snapshot", "--tab", "4AE7"],
    stubDeps({
      app: {
        snapshot: () =>
          Promise.resolve({
            yaml: "tree: []\n",
            refs: {},
            lastRefCounter: 0,
            snapshotId: "s9",
            title: "Dialog\nAppeared\there",
            url: "https://example.com/",
          }),
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  // Must be exactly one line (plus trailing newline).
  const lines = io.out.split("\n").filter((l) => l.length > 0);
  assertEquals(lines.length, 1, `expected 1 line, got: ${JSON.stringify(io.out)}`);
  assertStringIncludes(lines[0], "Dialog Appeared here");
});

Deno.test("snapshot pointer falls back to url when title is empty", async () => {
  const io = capture();
  const code = await runCli(
    ["snapshot", "--tab", "4AE7"],
    stubDeps({
      app: {
        snapshot: () =>
          Promise.resolve({
            yaml: "tree: []\n",
            refs: {},
            lastRefCounter: 0,
            snapshotId: "s3",
            title: "",
            url: "https://example.com/blank",
          }),
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.out, "snapshot s3 · https://example.com/blank · 0 refs");
});

Deno.test("snapshot passes all options", async () => {
  let receivedOpts: Record<string, unknown> = {};
  const code = await runCli(
    [
      "snapshot",
      "--tab",
      "4AE7",
      "--max-depth",
      "5",
      "--max-nodes",
      "100",
      "--selector",
      "#main",
    ],
    stubDeps({
      app: {
        snapshot: (_targetId, opts: Record<string, unknown>) => {
          receivedOpts = { ...opts };
          return Promise.resolve({
            yaml: "- heading",
            refs: {},
            lastRefCounter: 0,
            snapshotId: "s1",
            title: "",
            url: "https://example.com/",
          });
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
    ["snapshot", "--tab", "4AE7", "--max-depth", "deep"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "--max-depth must be a number");
});

Deno.test("snapshot reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["snapshot", "--tab", "4AE7"],
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
    ["eval", "--tab", "4AE7", "document.title"],
    stubDeps({
      app: {
        evaluate: (_targetId, expr) => {
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
  const code = await runCli(
    ["eval", "--tab", "4AE7"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "expression is required");
});

Deno.test("eval reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["eval", "--tab", "4AE7", "1+1"],
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
    ["screenshot", "--tab", "4AE7"],
    stubDeps({
      app: { screenshot: () => Promise.resolve("/tmp/shot.png") },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(io.out, "/tmp/shot.png\n");
});

Deno.test("screenshot reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["screenshot", "--tab", "4AE7"],
    stubDeps({
      app: { screenshot: () => Promise.reject(new Error("chrome is not running")) },
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "chrome is not running");
});

// --- wait ---

/**
 * The CLI always passes `includeSnapshot: true` to the app per design
 * (§Auto-snapshot rule). Helper ensures the stub returns a snapshot so tests
 * can assert the pointer contract without repeating the YAML boilerplate.
 */
function waitStubResolving(
  tap: (targetId: string, request: unknown, opts: unknown) => void,
) {
  return (targetId: string, request: unknown, opts: unknown) => {
    tap(targetId, request, opts);
    return Promise.resolve({
      snapshot: {
        yaml: "tree: []\n",
        refs: {},
        lastRefCounter: 0,
        snapshotId: "s1",
        title: "After Wait",
        url: "https://example.com/",
      },
    });
  };
}

Deno.test("wait --selector calls dep with selector request", async () => {
  let receivedRequest: unknown;
  let receivedOpts: unknown;
  const io = capture();
  const code = await runCli(
    ["wait", "--tab", "4AE7", "--selector", ".result"],
    stubDeps({
      app: {
        wait: waitStubResolving((_t, r, o) => {
          receivedRequest = r;
          receivedOpts = o;
        }),
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  // Default timeout of 30s must be applied at the CLI layer so the app layer
  // always sees an explicit value (design doc §Wait Semantics).
  assertEquals(receivedRequest, {
    kind: "selector",
    selector: ".result",
    timeoutMs: 30_000,
  });
  // Auto-snapshot: wait must always request a snapshot from the app.
  assertEquals((receivedOpts as { includeSnapshot?: boolean })?.includeSnapshot, true);
  assertStringIncludes(io.out, "waited · snapshot s1 · After Wait · 0 refs · ");
});

Deno.test("wait --text calls dep with text request", async () => {
  let receivedRequest: unknown;
  const io = capture();
  const code = await runCli(
    ["wait", "--tab", "4AE7", "--text", "Success"],
    stubDeps({
      app: {
        wait: waitStubResolving((_t, r) => {
          receivedRequest = r;
        }),
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedRequest, { kind: "text", text: "Success", timeoutMs: 30_000 });
  assertStringIncludes(io.out, "waited · snapshot s1 · After Wait · ");
});

Deno.test("wait --ref --text calls dep with textInElement request", async () => {
  let receivedRequest: unknown;
  const io = capture();
  const code = await runCli(
    ["wait", "--tab", "4AE7", "--ref", "e5", "--text", "Done"],
    stubDeps({
      app: {
        wait: waitStubResolving((_t, r) => {
          receivedRequest = r;
        }),
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedRequest, {
    kind: "textInElement",
    target: { ref: "e5" },
    text: "Done",
    timeoutMs: 30_000,
  });
  assertStringIncludes(io.out, "waited · snapshot s1 · After Wait · ");
});

Deno.test("wait --selector --text calls dep with textInElement request", async () => {
  let receivedRequest: unknown;
  const io = capture();
  const code = await runCli(
    ["wait", "--tab", "4AE7", "--selector", ".result", "--text", "OK"],
    stubDeps({
      app: {
        wait: waitStubResolving((_t, r) => {
          receivedRequest = r;
        }),
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(receivedRequest, {
    kind: "textInElement",
    target: { selector: ".result" },
    text: "OK",
    timeoutMs: 30_000,
  });
  assertStringIncludes(io.out, "waited · snapshot s1 · After Wait · ");
});

Deno.test("wait --timeout overrides the default timeout passed to the dep", async () => {
  let receivedRequest: unknown;
  const code = await runCli(
    ["wait", "--tab", "4AE7", "--text", "OK", "--timeout", "3000"],
    stubDeps({
      app: {
        wait: waitStubResolving((_t, r) => {
          receivedRequest = r;
        }),
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals((receivedRequest as { timeoutMs: number }).timeoutMs, 3000);
});

Deno.test("wait success emits `waited · snapshot ...` pointer", async () => {
  const io = capture();
  const yaml = "tree:\n  - heading\n";
  const expectedBytes = new TextEncoder().encode(yaml).byteLength;
  const code = await runCli(
    ["wait", "--tab", "4AE7", "--text", "Ready"],
    stubDeps({
      app: {
        wait: () =>
          Promise.resolve({
            snapshot: {
              yaml,
              refs: { e1: 1, e2: 2 },
              lastRefCounter: 2,
              snapshotId: "s12",
              title: "Form Loaded",
              url: "https://example.com/",
            },
          }),
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(
    io.out,
    `waited · snapshot s12 · Form Loaded · 2 refs · ${expectedBytes}B\n`,
  );
});

Deno.test("wait --ref without --text returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["wait", "--tab", "4AE7", "--ref", "e5"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "--ref requires --text");
});

Deno.test("wait without any condition returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["wait", "--tab", "4AE7"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "at least one of");
});

Deno.test("wait --ref and --selector returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["wait", "--tab", "4AE7", "--ref", "e5", "--selector", ".x", "--text", "hi"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "not both");
});

Deno.test("wait reports timeout error from dep (no pointer on failure)", async () => {
  const io = capture();
  const code = await runCli(
    ["wait", "--tab", "4AE7", "--text", "never"],
    stubDeps({
      app: {
        wait: () => Promise.reject(new Error('timed out waiting for text "never" (30000ms)')),
      },
      stdout: io.stdout,
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "timed out");
  // Snapshot pointer must NOT appear on timeout — only on success.
  assertEquals(io.out, "");
});

// --- upload ---

Deno.test("upload --ref with path calls dep correctly", async () => {
  let receivedTarget: unknown;
  let receivedPath: string | undefined;
  const io = capture();
  const code = await runCli(
    ["upload", "--tab", "4AE7", "--ref", "e4", "./document.pdf"],
    stubDeps({
      app: {
        upload: (_targetId, target, filePath) => {
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
    ["upload", "--tab", "4AE7", "--selector", "input[type=file]", "./photo.jpg"],
    stubDeps({
      app: {
        upload: (_targetId, target) => {
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
    ["upload", "--tab", "4AE7", "--ref", "e4"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "file path is required");
});

Deno.test("upload without target returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["upload", "--tab", "4AE7", "./photo.jpg"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "either --ref or --selector is required");
});

Deno.test("upload rejects --snapshot with a clear error (no auto-snapshot per design)", async () => {
  const io = capture();
  let appCalled = false;
  const code = await runCli(
    ["upload", "--tab", "4AE7", "--ref", "e4", "./photo.jpg", "--snapshot"],
    stubDeps({
      app: {
        upload: () => {
          appCalled = true;
          return Promise.resolve({});
        },
      },
      stdout: io.stdout,
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertEquals(appCalled, false, "upload must not reach the app layer when --snapshot is given");
  assertStringIncludes(io.err, "--snapshot is not supported on upload");
  assertStringIncludes(io.err, "scraper snapshot --tab");
});

Deno.test("upload does not pass includeSnapshot to the app layer", async () => {
  let receivedOpts: unknown;
  const code = await runCli(
    ["upload", "--tab", "4AE7", "--ref", "e4", "./photo.jpg"],
    stubDeps({
      app: {
        upload: (_targetId, _target, _path, opts) => {
          receivedOpts = opts;
          return Promise.resolve({});
        },
      },
    }),
  );
  assertEquals(code, 0);
  // The CLI must never opt into a snapshot for upload — the agent runs
  // `scraper snapshot --tab <id>` explicitly per the Tier B design.
  assertEquals(
    (receivedOpts as { includeSnapshot?: boolean } | undefined)?.includeSnapshot,
    undefined,
  );
});

Deno.test("navigate rejects --snapshot with a clear migration message", async () => {
  const io = capture();
  const code = await runCli(
    ["navigate", "--tab", "4AE7", "https://example.com", "--snapshot"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "--snapshot is no longer needed");
  assertStringIncludes(io.err, "auto-snapshots");
});

Deno.test("navigate rejects --on-dialog with a clear error", async () => {
  const io = capture();
  const code = await runCli(
    ["navigate", "--tab", "4AE7", "https://example.com", "--on-dialog", "accept"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "--on-dialog is not supported");
});

Deno.test("upload rejects --on-dialog with a clear error", async () => {
  const io = capture();
  const code = await runCli(
    ["upload", "--tab", "4AE7", "--ref", "e4", "./photo.jpg", "--on-dialog", "accept"],
    stubDeps({ stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "--on-dialog is not supported");
});

Deno.test("upload reports error from dep", async () => {
  const io = capture();
  const code = await runCli(
    ["upload", "--tab", "4AE7", "--ref", "e4", "./photo.jpg"],
    stubDeps({
      app: { upload: () => Promise.reject(new Error("element is not a file input")) },
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "element is not a file input");
});

// --- tabs ---

const TAB_A = "4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2";
const TAB_B = "9F3BA1C2D7E4F1A8B5C3E9F6A4D2B0C5";

Deno.test("tabs lists full targetId, URL, and title for every live page tab", async () => {
  const io = capture();
  const code = await runCli(
    ["tabs"],
    stubDeps({
      listTabs: () =>
        Promise.resolve([
          { id: TAB_A, url: "https://example.com/form", title: "Direct Medical Reimbursement" },
          { id: TAB_B, url: "https://mail.google.com/", title: "Inbox" },
        ]),
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  // Each tab's full id, url, and title appear on a single line.
  assertStringIncludes(io.out, TAB_A);
  assertStringIncludes(io.out, "https://example.com/form");
  assertStringIncludes(io.out, "Direct Medical Reimbursement");
  assertStringIncludes(io.out, TAB_B);
  assertStringIncludes(io.out, "https://mail.google.com/");
  assertStringIncludes(io.out, "Inbox");
  const lines = io.out.split("\n").filter((l) => l.length > 0);
  assertEquals(lines.length, 2, `expected 2 output lines, got: ${JSON.stringify(io.out)}`);
  // The full id must appear first on each line so agents can prefix-parse by whitespace.
  assertEquals(lines[0].startsWith(TAB_A), true, `line 0 should start with full id: ${lines[0]}`);
  assertEquals(lines[1].startsWith(TAB_B), true, `line 1 should start with full id: ${lines[1]}`);
});

Deno.test("tabs passes live targetIds to cleanupDeadRefs", async () => {
  let received: readonly string[] | undefined;
  const code = await runCli(
    ["tabs"],
    stubDeps({
      listTabs: () =>
        Promise.resolve([
          { id: TAB_A, url: "https://a", title: "A" },
          { id: TAB_B, url: "https://b", title: "B" },
        ]),
      cleanupDeadRefs: (ids) => {
        received = ids;
        return Promise.resolve();
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals([...(received ?? [])].sort(), [TAB_A, TAB_B].sort());
});

Deno.test("tabs with no live tabs still runs cleanup (to clear orphaned refs)", async () => {
  let called = false;
  const io = capture();
  const code = await runCli(
    ["tabs"],
    stubDeps({
      listTabs: () => Promise.resolve([]),
      cleanupDeadRefs: (ids) => {
        called = true;
        assertEquals([...ids], []);
        return Promise.resolve();
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(called, true);
  assertEquals(io.out, "");
});

Deno.test("tabs reports an error from listTabs and exits non-zero", async () => {
  const io = capture();
  let cleanupCalled = false;
  const code = await runCli(
    ["tabs"],
    stubDeps({
      listTabs: () => Promise.reject(new Error("chrome is not running")),
      cleanupDeadRefs: () => {
        cleanupCalled = true;
        return Promise.resolve();
      },
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "chrome is not running");
  // Cleanup depends on the live-tab set; if we can't list tabs, cleanup must not run
  // (otherwise it would delete every refs.<id>.json file).
  assertEquals(cleanupCalled, false);
});

Deno.test("tabs does not require --tab and does not call canonicalizeTab", async () => {
  let canonicalized = false;
  const code = await runCli(
    ["tabs"],
    stubDeps({
      listTabs: () => Promise.resolve([]),
      canonicalizeTab: () => {
        canonicalized = true;
        return Promise.resolve("x");
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(canonicalized, false);
});

Deno.test("usage advertises the tabs command", async () => {
  const io = capture();
  await runCli([], stubDeps({ stderr: io.stderr }));
  assertStringIncludes(io.err, "tabs");
});
