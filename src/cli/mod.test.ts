import { assertEquals, assertStringIncludes } from "@std/assert";
import { type CliDeps, type PidFile, runCli, type Timeout } from "./mod.ts";

function stubTimeout(): Timeout {
  return { promise: new Promise<never>(() => {}), cancel: () => {} };
}

const DEFAULT_PID: PidFile = { pid: 123, port: 3222, cdpPort: 9234 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    fetch: () => Promise.resolve(jsonResponse({})),
    readPidFile: () => Promise.resolve(DEFAULT_PID),
    writePidFile: () => Promise.resolve(),
    removePidFile: () => Promise.resolve(),
    isProcessAlive: () => true,
    killProcess: () => {},
    spawnDaemon: () => Promise.resolve({ pid: 456, port: 3222, cdpPort: 9234 }),
    startTimeout: () => stubTimeout(),
    sleep: () => Promise.resolve(),
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

// --- navigate ---

Deno.test("navigate calls POST /pages with url", async () => {
  let fetchUrl = "";
  let fetchBody = "";
  const io = capture();
  const code = await runCli(
    ["navigate", "https://example.com"],
    stubDeps({
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        fetchUrl = typeof input === "string" ? input : input.toString();
        fetchBody = init?.body as string;
        return Promise.resolve(
          jsonResponse({ name: "default", url: "https://example.com", targetId: "t1" }),
        );
      }) as typeof globalThis.fetch,
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(fetchUrl, "http://127.0.0.1:3222/pages");
  assertEquals(JSON.parse(fetchBody), { url: "https://example.com" });
  assertStringIncludes(io.out, "default");
  assertStringIncludes(io.out, "https://example.com");
});

Deno.test("navigate with --name passes name in body", async () => {
  let fetchBody = "";
  const code = await runCli(
    ["navigate", "https://example.com", "--name", "mypage"],
    stubDeps({
      fetch: ((_input: string | URL | Request, init?: RequestInit) => {
        fetchBody = init?.body as string;
        return Promise.resolve(
          jsonResponse({ name: "mypage", url: "https://example.com", targetId: "t1" }),
        );
      }) as typeof globalThis.fetch,
    }),
  );
  assertEquals(code, 0);
  assertEquals(JSON.parse(fetchBody), { url: "https://example.com", name: "mypage" });
});

Deno.test("navigate without url returns error", async () => {
  const io = capture();
  const code = await runCli(["navigate"], stubDeps({ stderr: io.stderr }));
  assertEquals(code, 1);
  assertStringIncludes(io.err, "url is required");
});

Deno.test("navigate with no daemon returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["navigate", "https://example.com"],
    stubDeps({
      readPidFile: () => Promise.resolve(null),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "daemon is not running");
});

// --- pages ---

Deno.test("pages calls GET /pages and prints table", async () => {
  let fetchUrl = "";
  let fetchMethod = "";
  const io = capture();
  const pages = [
    { name: "default", url: "https://a.com", targetId: "t1" },
    { name: "other", url: "https://b.com", targetId: "t2" },
  ];
  const code = await runCli(
    ["pages"],
    stubDeps({
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        fetchUrl = typeof input === "string" ? input : input.toString();
        fetchMethod = init?.method ?? "GET";
        return Promise.resolve(jsonResponse(pages));
      }) as typeof globalThis.fetch,
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(fetchUrl, "http://127.0.0.1:3222/pages");
  assertEquals(fetchMethod, "GET");
  assertStringIncludes(io.out, "default");
  assertStringIncludes(io.out, "https://a.com");
  assertStringIncludes(io.out, "other");
  assertStringIncludes(io.out, "https://b.com");
});

Deno.test("pages with empty list prints no pages", async () => {
  const io = capture();
  const code = await runCli(
    ["pages"],
    stubDeps({
      fetch: () => Promise.resolve(jsonResponse([])),
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.out, "no pages");
});

Deno.test("pages with no daemon returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["pages"],
    stubDeps({
      readPidFile: () => Promise.resolve(null),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "daemon is not running");
});

// --- snapshot ---

Deno.test("snapshot calls POST /snapshot and prints YAML", async () => {
  let fetchUrl = "";
  const io = capture();
  const yaml = '- main:\n    - heading "Hello"';
  const code = await runCli(
    ["snapshot"],
    stubDeps({
      fetch: ((input: string | URL | Request, _init?: RequestInit) => {
        fetchUrl = typeof input === "string" ? input : input.toString();
        return Promise.resolve(jsonResponse({ yaml }));
      }) as typeof globalThis.fetch,
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(fetchUrl, "http://127.0.0.1:3222/snapshot");
  assertEquals(io.out, yaml);
});

Deno.test("snapshot passes all options", async () => {
  let fetchBody = "";
  const code = await runCli(
    ["snapshot", "--name", "p1", "--max-depth", "5", "--max-nodes", "100", "--selector", "#main"],
    stubDeps({
      fetch: ((_input: string | URL | Request, init?: RequestInit) => {
        fetchBody = init?.body as string;
        return Promise.resolve(jsonResponse({ yaml: "- heading" }));
      }) as typeof globalThis.fetch,
    }),
  );
  assertEquals(code, 0);
  assertEquals(JSON.parse(fetchBody), {
    name: "p1",
    maxDepth: 5,
    maxNodes: 100,
    selector: "#main",
  });
});

Deno.test("snapshot with no daemon returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["snapshot"],
    stubDeps({
      readPidFile: () => Promise.resolve(null),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "daemon is not running");
});

// --- eval ---

Deno.test("eval calls POST /eval with expression and prints JSON", async () => {
  let fetchUrl = "";
  let fetchBody = "";
  const io = capture();
  const code = await runCli(
    ["eval", "document.title"],
    stubDeps({
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        fetchUrl = typeof input === "string" ? input : input.toString();
        fetchBody = init?.body as string;
        return Promise.resolve(jsonResponse({ result: { title: "Test" } }));
      }) as typeof globalThis.fetch,
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(fetchUrl, "http://127.0.0.1:3222/eval");
  assertEquals(JSON.parse(fetchBody), { expression: "document.title" });
  assertEquals(io.out, JSON.stringify({ title: "Test" }, null, 2) + "\n");
});

Deno.test("eval with --name passes name in body", async () => {
  let fetchBody = "";
  const code = await runCli(
    ["eval", "1+1", "--name", "mypage"],
    stubDeps({
      fetch: ((_input: string | URL | Request, init?: RequestInit) => {
        fetchBody = init?.body as string;
        return Promise.resolve(jsonResponse({ result: 2 }));
      }) as typeof globalThis.fetch,
    }),
  );
  assertEquals(code, 0);
  assertEquals(JSON.parse(fetchBody), { expression: "1+1", name: "mypage" });
});

Deno.test("eval without expression returns error", async () => {
  const io = capture();
  const code = await runCli(["eval"], stubDeps({ stderr: io.stderr }));
  assertEquals(code, 1);
  assertStringIncludes(io.err, "expression is required");
});

Deno.test("eval with no daemon returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["eval", "1+1"],
    stubDeps({
      readPidFile: () => Promise.resolve(null),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "daemon is not running");
});

// --- screenshot ---

Deno.test("screenshot calls POST /screenshot and prints path", async () => {
  let fetchUrl = "";
  const io = capture();
  const code = await runCli(
    ["screenshot"],
    stubDeps({
      fetch: ((input: string | URL | Request, _init?: RequestInit) => {
        fetchUrl = typeof input === "string" ? input : input.toString();
        return Promise.resolve(jsonResponse({ path: "/tmp/shot.png" }));
      }) as typeof globalThis.fetch,
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(fetchUrl, "http://127.0.0.1:3222/screenshot");
  assertEquals(io.out, "/tmp/shot.png\n");
});

Deno.test("screenshot with --name and --full-page passes options", async () => {
  let fetchBody = "";
  const code = await runCli(
    ["screenshot", "--name", "p1", "--full-page"],
    stubDeps({
      fetch: ((_input: string | URL | Request, init?: RequestInit) => {
        fetchBody = init?.body as string;
        return Promise.resolve(jsonResponse({ path: "/tmp/shot.png" }));
      }) as typeof globalThis.fetch,
    }),
  );
  assertEquals(code, 0);
  assertEquals(JSON.parse(fetchBody), { name: "p1", fullPage: true });
});

Deno.test("screenshot with no daemon returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["screenshot"],
    stubDeps({
      readPidFile: () => Promise.resolve(null),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "daemon is not running");
});

// --- stop ---

Deno.test("stop with no daemon returns error", async () => {
  const io = capture();
  const code = await runCli(
    ["stop"],
    stubDeps({
      readPidFile: () => Promise.resolve(null),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "daemon is not running");
});

Deno.test("stop: shutdown OK + process exits → remove PID, exit 0", async () => {
  let pidRemoved = false;
  const io = capture();
  const code = await runCli(
    ["stop"],
    stubDeps({
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        assertEquals(init?.method, "POST");
        assertStringIncludes(
          typeof input === "string" ? input : input.toString(),
          "/shutdown",
        );
        return Promise.resolve(jsonResponse({ ok: true }));
      }) as typeof globalThis.fetch,
      isProcessAlive: () => false,
      removePidFile: () => {
        pidRemoved = true;
        return Promise.resolve();
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(pidRemoved, true);
  assertStringIncludes(io.out, "daemon stopped");
});

Deno.test("stop: shutdown OK + process still alive → keep PID, exit 1", async () => {
  let pidRemoved = false;
  const io = capture();
  const code = await runCli(
    ["stop"],
    stubDeps({
      fetch: () => Promise.resolve(jsonResponse({ ok: true })),
      isProcessAlive: () => true,
      removePidFile: () => {
        pidRemoved = true;
        return Promise.resolve();
      },
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertEquals(pidRemoved, false);
  assertStringIncludes(io.err, "still alive");
});

Deno.test("stop: unreachable + process dead → remove PID, exit 0", async () => {
  let pidRemoved = false;
  const io = capture();
  const code = await runCli(
    ["stop"],
    stubDeps({
      fetch: () => Promise.reject(new Error("connection refused")),
      isProcessAlive: () => false,
      removePidFile: () => {
        pidRemoved = true;
        return Promise.resolve();
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(pidRemoved, true);
  assertStringIncludes(io.out, "daemon stopped");
});

Deno.test("stop: process exits after a few polls → remove PID, exit 0", async () => {
  let pollCount = 0;
  let pidRemoved = false;
  const io = capture();
  const code = await runCli(
    ["stop"],
    stubDeps({
      fetch: () => Promise.resolve(jsonResponse({ ok: true })),
      isProcessAlive: () => ++pollCount < 3,
      removePidFile: () => {
        pidRemoved = true;
        return Promise.resolve();
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(pidRemoved, true);
  assertEquals(pollCount, 3);
  assertStringIncludes(io.out, "daemon stopped");
});

Deno.test("stop: fetch hangs → timeout fires, fetch aborted, timer cancelled", async () => {
  let pidRemoved = false;
  let fetchAborted = false;
  let timeoutCancelled = false;
  const io = capture();
  const code = await runCli(
    ["stop"],
    stubDeps({
      fetch: ((_input: string | URL | Request, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            fetchAborted = true;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }) as typeof globalThis.fetch,
      startTimeout: () => ({
        promise: Promise.reject(new Error("timed out")),
        cancel: () => {
          timeoutCancelled = true;
        },
      }),
      isProcessAlive: () => false,
      removePidFile: () => {
        pidRemoved = true;
        return Promise.resolve();
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(pidRemoved, true);
  assertEquals(fetchAborted, true);
  assertEquals(timeoutCancelled, true);
  assertStringIncludes(io.out, "daemon stopped");
});

Deno.test("stop: shutdown OK → timeout cancelled, no leaked timer", async () => {
  let timeoutCancelled = false;
  const io = capture();
  const code = await runCli(
    ["stop"],
    stubDeps({
      fetch: () => Promise.resolve(jsonResponse({ ok: true })),
      startTimeout: () => ({
        promise: new Promise<never>(() => {}),
        cancel: () => {
          timeoutCancelled = true;
        },
      }),
      isProcessAlive: () => false,
      removePidFile: () => Promise.resolve(),
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(timeoutCancelled, true);
  assertStringIncludes(io.out, "daemon stopped");
});

Deno.test("stop: unreachable + process still alive → keep PID, exit 1", async () => {
  let pidRemoved = false;
  const io = capture();
  const code = await runCli(
    ["stop"],
    stubDeps({
      fetch: () => Promise.reject(new Error("connection refused")),
      isProcessAlive: () => true,
      removePidFile: () => {
        pidRemoved = true;
        return Promise.resolve();
      },
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertEquals(pidRemoved, false);
  assertStringIncludes(io.err, "still alive");
});

// --- start ---

Deno.test("start spawns daemon and writes PID file", async () => {
  const spawned: PidFile = { pid: 456, port: 3222, cdpPort: 9234 };
  let writtenPid: PidFile | null = null;
  const io = capture();
  const code = await runCli(
    ["start"],
    stubDeps({
      readPidFile: () => Promise.resolve(null),
      spawnDaemon: () => Promise.resolve(spawned),
      writePidFile: (pf: PidFile) => {
        writtenPid = pf;
        return Promise.resolve();
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(writtenPid, spawned);
  assertStringIncludes(io.out, "daemon started");
  assertStringIncludes(io.out, "456");
  assertStringIncludes(io.out, "3222");
});

Deno.test("start with daemon already running prints info", async () => {
  const io = capture();
  const code = await runCli(
    ["start"],
    stubDeps({
      readPidFile: () => Promise.resolve(DEFAULT_PID),
      isProcessAlive: () => true,
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertStringIncludes(io.out, "already running");
  assertStringIncludes(io.out, "123");
});

Deno.test("start cleans stale PID and spawns fresh", async () => {
  let pidRemoved = false;
  let spawnCalled = false;
  const io = capture();
  const code = await runCli(
    ["start"],
    stubDeps({
      readPidFile: () => Promise.resolve(DEFAULT_PID),
      isProcessAlive: () => false,
      removePidFile: () => {
        pidRemoved = true;
        return Promise.resolve();
      },
      spawnDaemon: () => {
        spawnCalled = true;
        return Promise.resolve({ pid: 789, port: 3222, cdpPort: 9234 });
      },
      stdout: io.stdout,
    }),
  );
  assertEquals(code, 0);
  assertEquals(pidRemoved, true);
  assertEquals(spawnCalled, true);
  assertStringIncludes(io.out, "daemon started");
});

Deno.test("start with --port uses custom port", async () => {
  let spawnedPort = 0;
  const code = await runCli(
    ["start", "--port", "4000"],
    stubDeps({
      readPidFile: () => Promise.resolve(null),
      spawnDaemon: (opts) => {
        spawnedPort = opts.port;
        return Promise.resolve({ pid: 456, port: 4000, cdpPort: 9234 });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(spawnedPort, 4000);
});

Deno.test("start with --port=N equals syntax works", async () => {
  let spawnedPort = 0;
  const code = await runCli(
    ["start", "--port=5000"],
    stubDeps({
      readPidFile: () => Promise.resolve(null),
      spawnDaemon: (opts) => {
        spawnedPort = opts.port;
        return Promise.resolve({ pid: 456, port: 5000, cdpPort: 9234 });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(spawnedPort, 5000);
});

Deno.test("start reports spawn failure", async () => {
  const io = capture();
  const code = await runCli(
    ["start"],
    stubDeps({
      readPidFile: () => Promise.resolve(null),
      spawnDaemon: () => Promise.reject(new Error("Chrome not found")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "Chrome not found");
});

Deno.test("start kills daemon if PID file write fails", async () => {
  let killedPid = 0;
  const io = capture();
  const code = await runCli(
    ["start"],
    stubDeps({
      readPidFile: () => Promise.resolve(null),
      spawnDaemon: () => Promise.resolve({ pid: 456, port: 3222, cdpPort: 9234 }),
      writePidFile: () => Promise.reject(new Error("EACCES")),
      killProcess: (pid: number) => {
        killedPid = pid;
      },
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertEquals(killedPid, 456);
  assertStringIncludes(io.err, "EACCES");
});

Deno.test("start rejects malformed --port", async () => {
  const io = capture();
  const code = await runCli(
    ["start", "--port", "abc"],
    stubDeps({ readPidFile: () => Promise.resolve(null), stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "--port must be a number");
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

Deno.test("start rejects --port without value", async () => {
  const io = capture();
  const code = await runCli(
    ["start", "--port"],
    stubDeps({ readPidFile: () => Promise.resolve(null), stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "--port requires a value");
});

Deno.test("start rejects --port= (empty equals value)", async () => {
  const io = capture();
  const code = await runCli(
    ["start", "--port="],
    stubDeps({ readPidFile: () => Promise.resolve(null), stderr: io.stderr }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "--port requires a value");
});

// --- Daemon error responses ---

Deno.test("daemon error response prints error to stderr", async () => {
  const io = capture();
  const code = await runCli(
    ["navigate", "https://example.com"],
    stubDeps({
      fetch: () => Promise.resolve(jsonResponse({ error: "connection lost" }, 500)),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "connection lost");
});

Deno.test("daemon connection failure prints error to stderr", async () => {
  const io = capture();
  const code = await runCli(
    ["navigate", "https://example.com"],
    stubDeps({
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
      stderr: io.stderr,
    }),
  );
  assertEquals(code, 1);
  assertStringIncludes(io.err, "cannot connect to daemon");
});
