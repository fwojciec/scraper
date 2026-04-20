import { assertEquals, assertRejects } from "@std/assert";
import type { CdpPageService } from "../cdp/mod.ts";
import type { RefMap, SnapshotRequest, SnapshotResult } from "../domain/mod.ts";
import {
  type ArtifactStore,
  type CounterStore,
  createScraperApp,
  type RefsStore,
  type ScraperAppDeps,
} from "./mod.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface RefsEntry {
  refs: RefMap;
  snapshotId: string;
}

function createRefsStore(
  initial?: Record<string, RefsEntry> | null,
): RefsStore & { data: Record<string, RefsEntry> } {
  const s = {
    data: { ...(initial ?? {}) } as Record<string, RefsEntry>,
    read(targetId: string) {
      return Promise.resolve(s.data[targetId]?.refs ?? null);
    },
    write(targetId: string, r: RefMap, snapshotId: string) {
      s.data[targetId] = { refs: r, snapshotId };
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

interface ArtifactWrite {
  id: string;
  kind: "snapshot" | "screenshot";
  content: string | Uint8Array;
}

function createArtifactStore(): ArtifactStore & { writes: ArtifactWrite[] } {
  const writes: ArtifactWrite[] = [];
  return {
    writes,
    writeSnapshot(id: string, yaml: string) {
      writes.push({ id, kind: "snapshot", content: yaml });
      return Promise.resolve(`/home/scraper/${id}.yaml`);
    },
    writeScreenshot(id: string, png: Uint8Array) {
      writes.push({ id, kind: "screenshot", content: png });
      return Promise.resolve(`/home/scraper/${id}.png`);
    },
  };
}

/** Minimal CdpPageService stub. Override individual methods as needed. */
function stubPage(overrides: Partial<CdpPageService> = {}): CdpPageService {
  return {
    navigate: () => Promise.resolve(),
    evaluate: () => Promise.resolve({ result: undefined }),
    screenshot: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    getPageInfo: () => Promise.resolve({ url: "https://example.com/", title: "Example" }),
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
  const artifactCounterStore = createCounterStore(0);
  const artifactStore = createArtifactStore();
  const base: ScraperAppDeps = {
    userDataDir: "/default/chrome-data",
    readDevToolsActivePort: () => Promise.resolve({ port: 9222, wsPath: "/devtools/browser/abc" }),
    buildBrowserWsUrl: (port, wsPath) => `ws://127.0.0.1:${port}${wsPath}`,
    createPageConnection: () => Promise.resolve(stubPage()),
    resolveTarget: () => Promise.resolve("obj-1"),
    createSnapshotService: () => ({
      snapshot: (req) =>
        Promise.resolve({
          yaml: `snapshot: ${req.snapshotId}\ntargetId: ${req.targetId}\ntree: []\n`,
          refs: { [`e${(req.startingRefCounter ?? 0) + 1}`]: 42 },
          lastRefCounter: (req.startingRefCounter ?? 0) + 1,
        }),
    }),
    refsStore,
    refCounterStore,
    artifactCounterStore,
    artifactStore,
    warn: () => {},
    ...overrides,
  };
  return { ...base, refsStore, refCounterStore, artifactCounterStore, artifactStore };
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
  deps.refsStore.data = {
    t1: { refs: { e1: 42 }, snapshotId: "s1" },
    t2: { refs: { e3: 17 }, snapshotId: "s2" },
  };
  const app = createScraperApp(deps);
  await app.navigate("t1", "https://example.com");
  assertEquals(deps.refsStore.data, { t2: { refs: { e3: 17 }, snapshotId: "s2" } });
});

Deno.test("navigate: returns snapshot when includeSnapshot set", async () => {
  const snapshotResult: SnapshotResult = {
    yaml: "snapshot: s1\ntree: []\n",
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

Deno.test("snapshot: persists refs alongside the snapshotId that minted them", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  const app = createScraperApp(deps);
  await app.snapshot("t1", {});
  assertEquals(deps.refsStore.data.t1, { refs: { e1: 42 }, snapshotId: "s1" });
});

Deno.test("snapshot: threads monotonic ref counter across consecutive snapshots", async () => {
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
  assertEquals(deps.refsStore.data.t1, { refs: { e2: 42 }, snapshotId: "s2" });
});

Deno.test("snapshot: ref counter survives across tabs so tab B starts after tab A's max", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
    createSnapshotService: () => ({
      snapshot: (req) => {
        const start = req.startingRefCounter ?? 0;
        const refs: RefMap = {};
        const count = 3;
        for (let i = 1; i <= count; i++) refs[`e${start + i}`] = 100 + i;
        return Promise.resolve({
          yaml: `snapshot: ${req.snapshotId}\ntree: []\n`,
          refs,
          lastRefCounter: start + count,
        });
      },
    }),
  });

  const app = createScraperApp(deps);
  await app.snapshot("tabA", {});
  assertEquals(deps.refsStore.data.tabA, {
    refs: { e1: 101, e2: 102, e3: 103 },
    snapshotId: "s1",
  });
  assertEquals(deps.refCounterStore.value, 3);

  await app.snapshot("tabB", {});
  assertEquals(deps.refsStore.data.tabB, {
    refs: { e4: 101, e5: 102, e6: 103 },
    snapshotId: "s2",
  });
  assertEquals(deps.refCounterStore.value, 6);
});

Deno.test("snapshot: empty snapshot clears this tab's prior refs file", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
    createSnapshotService: () => ({
      snapshot: (req) =>
        Promise.resolve({
          yaml: `snapshot: ${req.snapshotId}\ntree: []\n`,
          refs: {},
          lastRefCounter: req.startingRefCounter ?? 0,
        }),
    }),
  });
  deps.refsStore.data = {
    t1: { refs: { e1: 42 }, snapshotId: "s0" },
    t2: { refs: { e9: 99 }, snapshotId: "s0" },
  };
  const app = createScraperApp(deps);
  await app.snapshot("t1", {});
  assertEquals(deps.refsStore.data, { t2: { refs: { e9: 99 }, snapshotId: "s0" } });
});

Deno.test("snapshot: does not write ref counter when snapshot minted no refs", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
    createSnapshotService: () => ({
      snapshot: (req) =>
        Promise.resolve({
          yaml: `snapshot: ${req.snapshotId}\ntree: []\n`,
          refs: {},
          lastRefCounter: req.startingRefCounter ?? 0,
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

Deno.test("snapshot: increments artifact counter and writes snapshot to artifact store", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  deps.artifactCounterStore.value = 46;
  const app = createScraperApp(deps);
  await app.snapshot("t1", {});
  assertEquals(deps.artifactCounterStore.value, 47);
  assertEquals(deps.artifactStore.writes.length, 1);
  assertEquals(deps.artifactStore.writes[0].kind, "snapshot");
  assertEquals(deps.artifactStore.writes[0].id, "s47");
});

Deno.test("snapshot: passes snapshotId, targetId, url, and title to the service", async () => {
  let received: SnapshotRequest | undefined;
  const page = stubPage({
    getPageInfo: () =>
      Promise.resolve({
        url: "https://uhc.com/reimburse",
        title: "Direct Medical Reimbursement",
      }),
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
    createSnapshotService: () => ({
      snapshot: (req) => {
        received = req;
        return Promise.resolve({ yaml: "", refs: {}, lastRefCounter: 0 });
      },
    }),
  });
  const app = createScraperApp(deps);
  await app.snapshot("4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2", {});
  assertEquals(received?.snapshotId, "s1");
  assertEquals(received?.targetId, "4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2");
  assertEquals(received?.url, "https://uhc.com/reimburse");
  assertEquals(received?.title, "Direct Medical Reimbursement");
  assertEquals(received?.dialog, null);
});

Deno.test("snapshot: artifact counter is shared with screenshot so ids interleave", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  const app = createScraperApp(deps);
  await app.snapshot("t1", {});
  await app.screenshot("t1");
  await app.snapshot("t1", {});
  assertEquals(deps.artifactStore.writes.map((w) => w.id), ["s1", "shot2", "s3"]);
  assertEquals(deps.artifactCounterStore.value, 3);
});

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

Deno.test("screenshot: writes shot{N}.png to artifact store and returns its path", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const page = stubPage({ screenshot: () => Promise.resolve(png) });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
  });
  deps.artifactCounterStore.value = 10;
  const app = createScraperApp(deps);
  const path = await app.screenshot("t1");
  assertEquals(deps.artifactCounterStore.value, 11);
  assertEquals(deps.artifactStore.writes, [
    { id: "shot11", kind: "screenshot", content: png },
  ]);
  assertEquals(path, "/home/scraper/shot11.png");
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
  deps.refsStore.data = {
    t1: { refs: { e1: 42 }, snapshotId: "s1" },
    t2: { refs: { e9: 99 }, snapshotId: "s1" },
  };
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
  assertEquals(
    result.snapshot?.yaml,
    "snapshot: s1\ntargetId: t1\ntree: []\n",
  );
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
  deps.refsStore.data = {
    "dead-target": { refs: { e1: 42 }, snapshotId: "s1" },
    other: { refs: { e9: 1 }, snapshotId: "s1" },
  };
  const app = createScraperApp(deps);
  await assertRejects(() => app.snapshot("dead-target", {}), Error, "target no longer exists");
  assertEquals(deps.refsStore.data, { other: { refs: { e9: 1 }, snapshotId: "s1" } });
});

Deno.test("stale target: other errors don't clear refs", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.reject(new Error("connection refused")),
  });
  deps.refsStore.data = { "some-target": { refs: { e1: 42 }, snapshotId: "s1" } };
  const app = createScraperApp(deps);
  await assertRejects(() => app.snapshot("some-target", {}), Error, "connection refused");
  assertEquals(deps.refsStore.data, { "some-target": { refs: { e1: 42 }, snapshotId: "s1" } });
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
