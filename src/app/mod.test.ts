import { assertEquals, assertRejects } from "@std/assert";
import type { CdpPageService } from "../cdp/mod.ts";
import type { RefMap, SnapshotResult } from "../domain/mod.ts";
import { type CounterStore, createScraperApp, type RefsStore, type ScraperAppDeps } from "./mod.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createRefsStore(
  initial?: Record<string, RefMap> | null,
): RefsStore & { data: Record<string, RefMap> } {
  const s = {
    data: { ...(initial ?? {}) } as Record<string, RefMap>,
    read(targetId: string) {
      return Promise.resolve(s.data[targetId] ?? null);
    },
    write(targetId: string, r: RefMap) {
      s.data[targetId] = r;
      return Promise.resolve();
    },
    remove(targetId: string) {
      delete s.data[targetId];
      return Promise.resolve();
    },
  };
  return s;
}

function createCounterStore(
  initial?: number,
): CounterStore & { value: number; writes: number[] } {
  const s = {
    value: initial ?? 0,
    writes: [] as number[],
    read() {
      return Promise.resolve(s.value);
    },
    write(n: number) {
      s.value = n;
      s.writes.push(n);
      return Promise.resolve();
    },
  };
  return s;
}

/** Minimal CdpPageService stub. Override individual methods as needed. */
function stubPage(overrides: Partial<CdpPageService> = {}): CdpPageService {
  return {
    navigate: () => Promise.resolve(),
    evaluate: () => Promise.resolve({ result: undefined }),
    screenshot: () => Promise.resolve("/tmp/shot.png"),
    getFullAXTree: () => Promise.resolve([]),
    resolveSelector: () => Promise.resolve(0),
    resolveRef: () => Promise.resolve("obj-1"),
    resolveUniqueSelector: () => Promise.resolve("obj-1"),
    uploadFile: () => Promise.resolve(),
    onDialog: () => () => {},
    handleDialog: () => Promise.resolve(),
    waitForNetworkIdle: () => Promise.resolve(false),
    waitForSelector: () => Promise.resolve(),
    waitForText: () => Promise.resolve(),
    waitForTextInElement: () => Promise.resolve(),
    close: () => {},
    ...overrides,
  };
}

/** Default deps — all stubs. Clone and override per test. */
function createDeps(overrides: Partial<ScraperAppDeps> = {}) {
  const refsStore = createRefsStore();
  const refCounterStore = createCounterStore(0);
  const base: ScraperAppDeps = {
    userDataDir: "/default/chrome-data",
    readDevToolsActivePort: () => Promise.resolve({ port: 9222, wsPath: "/devtools/browser/abc" }),
    buildBrowserWsUrl: (port, wsPath) => `ws://127.0.0.1:${port}${wsPath}`,
    createPageConnection: () => Promise.resolve(stubPage()),
    resolveTarget: () => Promise.resolve("obj-1"),
    createSnapshotService: () => ({
      snapshot: (opts) =>
        Promise.resolve({
          yaml: "- text: hello\n",
          refs: { [`e${(opts.startingRefCounter ?? 0) + 1}`]: 42 },
          lastRefCounter: (opts.startingRefCounter ?? 0) + 1,
        }),
    }),
    refsStore,
    refCounterStore,
    warn: () => {},
    ...overrides,
  };
  return { ...base, refsStore, refCounterStore };
}

// ---------------------------------------------------------------------------
// navigate
// ---------------------------------------------------------------------------

Deno.test("navigate: calls page.navigate and waits for network idle", async () => {
  let navigated = "";
  let networkIdleCalled = false;
  const page = stubPage({
    navigate: (url) => {
      navigated = url;
      return Promise.resolve();
    },
    waitForNetworkIdle: () => {
      networkIdleCalled = true;
      return Promise.resolve(false);
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
  });
  const app = createScraperApp(deps);
  const result = await app.navigate("t1", "https://example.com");
  assertEquals(navigated, "https://example.com");
  assertEquals(networkIdleCalled, true);
  assertEquals(result, {});
});

Deno.test("navigate: attaches to the caller-supplied targetId", async () => {
  let attachedTarget = "";
  const deps = createDeps({
    createPageConnection: (_wsUrl, targetId) => {
      attachedTarget = targetId;
      return Promise.resolve(stubPage());
    },
  });
  const app = createScraperApp(deps);
  await app.navigate("4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2", "about:blank");
  assertEquals(attachedTarget, "4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2");
});

Deno.test("navigate: warns on network idle timeout", async () => {
  const warnings: string[] = [];
  const page = stubPage({
    waitForNetworkIdle: () => Promise.resolve(true),
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
    warn: (msg) => warnings.push(msg),
  });
  const app = createScraperApp(deps);
  await app.navigate("t1", "https://example.com");
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("timed out"), true);
});

Deno.test("navigate: removes refs for the current tab only", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  deps.refsStore.data = { t1: { e1: 42 }, t2: { e3: 17 } };
  const app = createScraperApp(deps);
  await app.navigate("t1", "https://example.com");
  assertEquals(deps.refsStore.data, { t2: { e3: 17 } });
});

Deno.test("navigate: returns snapshot when includeSnapshot set", async () => {
  const snapshotResult: SnapshotResult = {
    yaml: "- text: hi\n",
    refs: { e1: 1 },
    lastRefCounter: 1,
  };
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
    createSnapshotService: () => ({
      snapshot: () => Promise.resolve(snapshotResult),
    }),
  });
  const app = createScraperApp(deps);
  const result = await app.navigate("t1", "https://example.com", { includeSnapshot: true });
  assertEquals(result.snapshot, snapshotResult);
});

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

Deno.test("snapshot: returns YAML and persists refs under the supplied tab", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  const app = createScraperApp(deps);
  const result = await app.snapshot("t1", {});
  assertEquals(result.yaml, "- text: hello\n");
  assertEquals(deps.refsStore.data, { t1: { e1: 42 } });
});

Deno.test("snapshot: threads monotonic counter across consecutive snapshots", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  const app = createScraperApp(deps);
  const first = await app.snapshot("t1", {});
  assertEquals(first.refs, { e1: 42 });
  assertEquals(deps.refCounterStore.value, 1);
  const second = await app.snapshot("t1", {});
  assertEquals(second.refs, { e2: 42 });
  assertEquals(deps.refCounterStore.value, 2);
  assertEquals(deps.refsStore.data, { t1: { e2: 42 } });
});

Deno.test("snapshot: counter survives across tabs so tab B starts after tab A's max", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
    createSnapshotService: () => ({
      snapshot: (opts) => {
        const start = opts.startingRefCounter ?? 0;
        const refs: RefMap = {};
        const count = 3;
        for (let i = 1; i <= count; i++) refs[`e${start + i}`] = 100 + i;
        return Promise.resolve({
          yaml: `- generated ${count} refs\n`,
          refs,
          lastRefCounter: start + count,
        });
      },
    }),
  });

  const app = createScraperApp(deps);
  await app.snapshot("tabA", {});
  assertEquals(deps.refsStore.data, { tabA: { e1: 101, e2: 102, e3: 103 } });
  assertEquals(deps.refCounterStore.value, 3);

  await app.snapshot("tabB", {});
  assertEquals(deps.refsStore.data, {
    tabA: { e1: 101, e2: 102, e3: 103 },
    tabB: { e4: 101, e5: 102, e6: 103 },
  });
  assertEquals(deps.refCounterStore.value, 6);
});

Deno.test("snapshot: empty snapshot clears this tab's prior refs file", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
    createSnapshotService: () => ({
      snapshot: (opts) =>
        Promise.resolve({
          yaml: "",
          refs: {},
          lastRefCounter: opts.startingRefCounter ?? 0,
        }),
    }),
  });
  deps.refsStore.data = { t1: { e1: 42 }, t2: { e9: 99 } };
  const app = createScraperApp(deps);
  await app.snapshot("t1", {});
  assertEquals(deps.refsStore.data, { t2: { e9: 99 } });
});

Deno.test("snapshot: does not write counter when snapshot minted no refs", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
    createSnapshotService: () => ({
      snapshot: (opts) =>
        Promise.resolve({
          yaml: "",
          refs: {},
          lastRefCounter: opts.startingRefCounter ?? 0,
        }),
    }),
  });
  deps.refCounterStore.value = 7;
  const app = createScraperApp(deps);
  await app.snapshot("t1", {});
  assertEquals(deps.refCounterStore.value, 7);
  assertEquals(deps.refCounterStore.writes, []);
  assertEquals(deps.refsStore.data, {});
});

// ---------------------------------------------------------------------------
// upload (representative action)
// ---------------------------------------------------------------------------

Deno.test("upload: resolves target, uploads file, runs post-action", async () => {
  let uploadedPath = "";
  let uploadedObjectId = "";
  let resolvedTarget: unknown;
  let resolveRefsArg: RefMap | null | undefined;
  const page = stubPage({
    uploadFile: (objectId, filePath) => {
      uploadedObjectId = objectId;
      uploadedPath = filePath;
      return Promise.resolve();
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
    resolveTarget: (target, _page, refs) => {
      resolvedTarget = target;
      resolveRefsArg = refs;
      return Promise.resolve("obj-1");
    },
  });
  deps.refsStore.data = { t1: { e1: 42 }, t2: { e9: 99 } };
  const app = createScraperApp(deps);
  await app.upload("t1", { ref: "e1" }, "/tmp/photo.jpg");
  assertEquals(uploadedObjectId, "obj-1");
  assertEquals(uploadedPath, "/tmp/photo.jpg");
  assertEquals(resolvedTarget, { ref: "e1" });
  assertEquals(resolveRefsArg, { e1: 42 });
});

Deno.test("upload: returns snapshot when includeSnapshot set", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  const app = createScraperApp(deps);
  const result = await app.upload(
    "t1",
    { ref: "e1" },
    "/tmp/x.txt",
    { includeSnapshot: true },
  );
  assertEquals(result.snapshot?.yaml, "- text: hello\n");
});

Deno.test("upload: dialog appearance during upload aggregates as error", async () => {
  let dialogTrigger:
    | ((type: string, message: string, defaultPrompt: string) => void)
    | null = null;
  const page = stubPage({
    onDialog: (handler) => {
      dialogTrigger = handler;
      return () => {
        dialogTrigger = null;
      };
    },
    uploadFile: () => {
      dialogTrigger?.("alert", "boom", "");
      return Promise.resolve();
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
  });
  const app = createScraperApp(deps);
  await assertRejects(
    () => app.upload("t1", { ref: "e1" }, "/tmp/x"),
    Error,
    "a dialog appeared",
  );
});

// ---------------------------------------------------------------------------
// wait
// ---------------------------------------------------------------------------

Deno.test("wait: selector delegates to page.waitForSelector", async () => {
  let waitedSelector = "";
  const page = stubPage({
    waitForSelector: (s) => {
      waitedSelector = s;
      return Promise.resolve();
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
  });
  const app = createScraperApp(deps);
  await app.wait("t1", { kind: "selector", selector: "#foo" });
  assertEquals(waitedSelector, "#foo");
});

Deno.test("wait: text delegates to page.waitForText", async () => {
  let waitedText = "";
  const page = stubPage({
    waitForText: (t) => {
      waitedText = t;
      return Promise.resolve();
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
  });
  const app = createScraperApp(deps);
  await app.wait("t1", { kind: "text", text: "hello" });
  assertEquals(waitedText, "hello");
});

// ---------------------------------------------------------------------------
// connection lifecycle
// ---------------------------------------------------------------------------

Deno.test("page connection is closed after operation", async () => {
  let closed = false;
  const page = stubPage({
    close: () => {
      closed = true;
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
  });
  const app = createScraperApp(deps);
  await app.evaluate("t1", "1+1");
  assertEquals(closed, true);
});

Deno.test("page connection is closed even on error", async () => {
  let closed = false;
  const page = stubPage({
    evaluate: () => Promise.reject(new Error("eval failed")),
    close: () => {
      closed = true;
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
  });
  const app = createScraperApp(deps);
  await assertRejects(() => app.evaluate("t1", "bad"), Error, "eval failed");
  assertEquals(closed, true);
});

Deno.test("stale target: clears refs for that tab when target is gone", async () => {
  const deps = createDeps({
    createPageConnection: () =>
      Promise.reject(new Error("target no longer exists — run 'scraper tabs' to list tabs")),
  });
  deps.refsStore.data = { "dead-target": { e1: 42 }, other: { e9: 1 } };
  const app = createScraperApp(deps);
  await assertRejects(() => app.snapshot("dead-target", {}), Error, "target no longer exists");
  assertEquals(deps.refsStore.data, { other: { e9: 1 } });
});

Deno.test("stale target: other errors don't clear refs", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.reject(new Error("connection refused")),
  });
  deps.refsStore.data = { "some-target": { e1: 42 } };
  const app = createScraperApp(deps);
  await assertRejects(() => app.snapshot("some-target", {}), Error, "connection refused");
  assertEquals(deps.refsStore.data, { "some-target": { e1: 42 } });
});

Deno.test("reads DevToolsActivePort before connecting", async () => {
  let readDir: string | undefined;
  const deps = createDeps({
    userDataDir: "/my/chrome",
    readDevToolsActivePort: (dir) => {
      readDir = dir;
      return Promise.resolve({ port: 9222, wsPath: "/devtools/browser/abc" });
    },
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  const app = createScraperApp(deps);
  await app.evaluate("t1", "1+1");
  assertEquals(readDir, "/my/chrome");
});
