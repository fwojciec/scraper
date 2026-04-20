import { assertEquals, assertRejects } from "@std/assert";
import type { CdpBrowserService, CdpPageService } from "../cdp/mod.ts";
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
    evaluateWithRefs: () => Promise.resolve({ result: undefined }),
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

/** Minimal CdpBrowserService stub. Override individual methods as needed. */
function stubBrowser(overrides: Partial<CdpBrowserService> = {}): CdpBrowserService {
  return {
    listPages: () => Promise.resolve([]),
    createTarget: () => Promise.resolve("NEW_TARGET_ID"),
    closeTarget: () => Promise.resolve(),
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
    createBrowserConnection: () => Promise.resolve(stubBrowser()),
    resolveTarget: () => Promise.resolve("obj-1"),
    createSnapshotService: () => ({
      snapshot: (req) =>
        Promise.resolve({
          yaml: `snapshot: ${req.snapshotId}\ntargetId: ${req.targetId}\ntree: []\n`,
          refs: { [`e${(req.startingRefCounter ?? 0) + 1}`]: 42 },
          lastRefCounter: (req.startingRefCounter ?? 0) + 1,
          snapshotId: req.snapshotId,
          title: req.title,
          url: req.url,
        }),
    }),
    refsStore,
    refCounterStore,
    artifactCounterStore,
    artifactStore,
    // In-process pass-through — unit tests run sequentially, so serialization
    // is unobservable here. Concurrency behavior is covered by the
    // integration tests that spawn parallel CLI subprocesses.
    withStateLock: (fn) => fn(),
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
    snapshotId: "s1",
    title: "Example",
    url: "https://example.com/",
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
// navigateNew
// ---------------------------------------------------------------------------

Deno.test("navigateNew: opens an about:blank target then navigates the page connection", async () => {
  let createdUrl = "";
  let navigatedUrl = "";
  let attached = "";
  const browser = stubBrowser({
    createTarget: (url) => {
      createdUrl = url;
      return Promise.resolve("NEW_TID");
    },
  });
  const page = stubPage({
    navigate: (url) => {
      navigatedUrl = url;
      return Promise.resolve();
    },
  });
  const deps = createDeps({
    createBrowserConnection: () => Promise.resolve(browser),
    createPageConnection: (_wsUrl, targetId) => {
      attached = targetId;
      return Promise.resolve(page);
    },
  });
  const app = createScraperApp(deps);
  const result = await app.navigateNew("https://example.com");
  // Open at about:blank so our Network/Page domains are attached before any
  // real-page requests fire — see comment in app/mod.ts::navigateNew.
  assertEquals(createdUrl, "about:blank");
  assertEquals(attached, "NEW_TID");
  assertEquals(navigatedUrl, "https://example.com");
  assertEquals(result.targetId, "NEW_TID");
});

Deno.test("navigateNew: auto-snapshots and persists refs under the new targetId", async () => {
  const deps = createDeps({
    createBrowserConnection: () =>
      Promise.resolve(stubBrowser({
        createTarget: () => Promise.resolve("NEW_TID"),
      })),
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  const app = createScraperApp(deps);
  const result = await app.navigateNew("https://example.com");
  assertEquals(deps.refsStore.data.NEW_TID, { refs: { e1: 42 }, snapshotId: "s1" });
  // Returned snapshot is the same object the app wrote to disk.
  assertEquals(result.snapshot.snapshotId, "s1");
  assertEquals(result.snapshot.refs, { e1: 42 });
});

Deno.test("navigateNew: waits for network idle before snapshotting", async () => {
  const callOrder: string[] = [];
  const page = stubPage({
    waitForNetworkIdle: () => {
      callOrder.push("network-idle");
      return Promise.resolve(false);
    },
  });
  const deps = createDeps({
    createBrowserConnection: () => Promise.resolve(stubBrowser()),
    createPageConnection: () => Promise.resolve(page),
    createSnapshotService: () => ({
      snapshot: (req) => {
        callOrder.push("snapshot");
        return Promise.resolve({
          yaml: "",
          refs: {},
          lastRefCounter: 0,
          snapshotId: req.snapshotId,
          title: req.title,
          url: req.url,
        });
      },
    }),
  });
  const app = createScraperApp(deps);
  await app.navigateNew("https://example.com");
  assertEquals(callOrder, ["network-idle", "snapshot"]);
});

Deno.test("navigateNew: warns on network idle timeout", async () => {
  const warnings: string[] = [];
  const page = stubPage({
    waitForNetworkIdle: () => Promise.resolve(true),
  });
  const deps = createDeps({
    createBrowserConnection: () => Promise.resolve(stubBrowser()),
    createPageConnection: () => Promise.resolve(page),
    warn: (msg) => warnings.push(msg),
  });
  const app = createScraperApp(deps);
  await app.navigateNew("https://example.com");
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("timed out"), true);
});

Deno.test("navigateNew: closes the browser connection even when createTarget throws", async () => {
  let closed = false;
  const browser = stubBrowser({
    createTarget: () => Promise.reject(new Error("create failed")),
    close: () => {
      closed = true;
    },
  });
  const deps = createDeps({
    createBrowserConnection: () => Promise.resolve(browser),
  });
  const app = createScraperApp(deps);
  await assertRejects(() => app.navigateNew("https://example.com"), Error, "create failed");
  assertEquals(closed, true);
});

Deno.test("navigateNew: closes the leaked target if page.navigate fails", async () => {
  const closedTargets: string[] = [];
  const browser = stubBrowser({
    createTarget: () => Promise.resolve("LEAKED_TID"),
    closeTarget: (id) => {
      closedTargets.push(id);
      return Promise.resolve();
    },
  });
  const page = stubPage({
    navigate: () => Promise.reject(new Error("navigation blocked")),
  });
  const deps = createDeps({
    createBrowserConnection: () => Promise.resolve(browser),
    createPageConnection: () => Promise.resolve(page),
  });
  const app = createScraperApp(deps);
  await assertRejects(
    () => app.navigateNew("https://example.com"),
    Error,
    "navigation blocked",
  );
  // The targetId was never returned to the caller, so the app must roll back.
  assertEquals(closedTargets, ["LEAKED_TID"]);
});

Deno.test("navigateNew: warns when rollback closeTarget itself fails (preserves original error)", async () => {
  const warnings: string[] = [];
  const browser = stubBrowser({
    createTarget: () => Promise.resolve("LEAKED_TID"),
    closeTarget: () => Promise.reject(new Error("target gone")),
  });
  const page = stubPage({
    navigate: () => Promise.reject(new Error("navigation blocked")),
  });
  const deps = createDeps({
    createBrowserConnection: () => Promise.resolve(browser),
    createPageConnection: () => Promise.resolve(page),
    warn: (msg) => warnings.push(msg),
  });
  const app = createScraperApp(deps);
  // Original error must propagate, not the rollback error.
  await assertRejects(
    () => app.navigateNew("https://example.com"),
    Error,
    "navigation blocked",
  );
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("LEAKED_TID"), true);
  assertEquals(warnings[0].includes("target gone"), true);
});

Deno.test("navigate: dialog fired during load is dismissed and threaded into auto-snapshot", async () => {
  let dialogTrigger:
    | ((type: string, message: string, defaultPrompt: string) => void)
    | null = null;
  let receivedRequest: SnapshotRequest | undefined;
  const page = stubPage({
    onDialog: (handler) => {
      dialogTrigger = handler;
      return () => {
        dialogTrigger = null;
      };
    },
    // Simulate an onload alert that fires between navigate() and network idle.
    navigate: () => {
      dialogTrigger?.("alert", "onload boom", "");
      return Promise.resolve();
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
    createSnapshotService: () => ({
      snapshot: (req) => {
        receivedRequest = req;
        return Promise.resolve({
          yaml: "",
          refs: {},
          lastRefCounter: 0,
          snapshotId: req.snapshotId,
          title: req.title,
          url: req.url,
        });
      },
    }),
  });
  const app = createScraperApp(deps);
  await app.navigate("t1", "https://example.com", { includeSnapshot: true });
  assertEquals(receivedRequest?.dialog, {
    type: "alert",
    message: "onload boom",
    handled: "dismiss",
  });
});

Deno.test("navigate: onDialog accept uses accept and routes to CDP handleDialog", async () => {
  let dialogTrigger:
    | ((type: string, message: string, defaultPrompt: string) => void)
    | null = null;
  const handled: Array<{ accept: boolean; promptText?: string }> = [];
  const page = stubPage({
    onDialog: (handler) => {
      dialogTrigger = handler;
      return () => {
        dialogTrigger = null;
      };
    },
    handleDialog: (accept, promptText) => {
      handled.push({ accept, promptText });
      return Promise.resolve();
    },
    navigate: () => {
      dialogTrigger?.("confirm", "Continue?", "");
      return Promise.resolve();
    },
  });
  const deps = createDeps({ createPageConnection: () => Promise.resolve(page) });
  const app = createScraperApp(deps);
  await app.navigate("t1", "https://example.com", { onDialog: { accept: true } });
  assertEquals(handled, [{ accept: true, promptText: undefined }]);
});

Deno.test("navigate: only the first dialog is captured for the snapshot; every one is handled", async () => {
  let dialogTrigger:
    | ((type: string, message: string, defaultPrompt: string) => void)
    | null = null;
  const handled: Array<{ accept: boolean; promptText?: string }> = [];
  let receivedRequest: SnapshotRequest | undefined;
  const page = stubPage({
    onDialog: (handler) => {
      dialogTrigger = handler;
      return () => {
        dialogTrigger = null;
      };
    },
    handleDialog: (accept, promptText) => {
      handled.push({ accept, promptText });
      return Promise.resolve();
    },
    navigate: () => {
      dialogTrigger?.("alert", "first", "");
      dialogTrigger?.("alert", "second", "");
      return Promise.resolve();
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
    createSnapshotService: () => ({
      snapshot: (req) => {
        receivedRequest = req;
        return Promise.resolve({
          yaml: "",
          refs: {},
          lastRefCounter: 0,
          snapshotId: req.snapshotId,
          title: req.title,
          url: req.url,
        });
      },
    }),
  });
  const app = createScraperApp(deps);
  await app.navigate("t1", "https://example.com", { includeSnapshot: true });
  // First dialog wins for reporting; both were still handled so Chrome is not blocked.
  assertEquals(receivedRequest?.dialog?.message, "first");
  assertEquals(handled.length, 2);
});

Deno.test("navigate: invalidates refs even when auto-snapshot fails", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
    createSnapshotService: () => ({
      snapshot: () => Promise.reject(new Error("snapshot failed")),
    }),
  });
  // Pre-existing refs from a prior page on this tab. After navigate the page
  // context has changed; even if snapshotting fails, those refs are stale and
  // must not be addressable.
  deps.refsStore.data = {
    t1: { refs: { e1: 42 }, snapshotId: "s0" },
    other: { refs: { e9: 1 }, snapshotId: "s0" },
  };
  const app = createScraperApp(deps);
  await assertRejects(
    () => app.navigate("t1", "https://example.com", { includeSnapshot: true }),
    Error,
    "snapshot failed",
  );
  assertEquals(deps.refsStore.data, { other: { refs: { e9: 1 }, snapshotId: "s0" } });
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
          snapshotId: req.snapshotId,
          title: req.title,
          url: req.url,
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
          snapshotId: req.snapshotId,
          title: req.title,
          url: req.url,
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
          snapshotId: req.snapshotId,
          title: req.title,
          url: req.url,
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
        return Promise.resolve({
          yaml: "",
          refs: {},
          lastRefCounter: 0,
          snapshotId: req.snapshotId,
          title: req.title,
          url: req.url,
        });
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
  deps.refsStore.data = { t1: { refs: { e1: 42 }, snapshotId: "s1" } };
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

Deno.test("upload: dialog that fires during upload is dismissed, not thrown", async () => {
  let dialogTrigger:
    | ((type: string, message: string, defaultPrompt: string) => void)
    | null = null;
  const handled: Array<{ accept: boolean; promptText?: string }> = [];
  const page = stubPage({
    onDialog: (handler) => {
      dialogTrigger = handler;
      return () => {
        dialogTrigger = null;
      };
    },
    handleDialog: (accept, promptText) => {
      handled.push({ accept, promptText });
      return Promise.resolve();
    },
    uploadFile: () => {
      dialogTrigger?.("alert", "boom", "");
      return Promise.resolve();
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
  });
  deps.refsStore.data = { t1: { refs: { e1: 42 }, snapshotId: "s1" } };
  const app = createScraperApp(deps);
  // No error — dialog is a normal occurrence now. Default policy dismisses.
  await app.upload("t1", { ref: "e1" }, "/tmp/x");
  assertEquals(handled, [{ accept: false, promptText: undefined }]);
});

Deno.test("upload: includeSnapshot surfaces the observed dialog in the snapshot", async () => {
  let dialogTrigger:
    | ((type: string, message: string, defaultPrompt: string) => void)
    | null = null;
  let receivedRequest: SnapshotRequest | undefined;
  const page = stubPage({
    onDialog: (handler) => {
      dialogTrigger = handler;
      return () => {
        dialogTrigger = null;
      };
    },
    uploadFile: () => {
      dialogTrigger?.("alert", "unsaved changes", "");
      return Promise.resolve();
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
    createSnapshotService: () => ({
      snapshot: (req) => {
        receivedRequest = req;
        return Promise.resolve({
          yaml: "",
          refs: {},
          lastRefCounter: 0,
          snapshotId: req.snapshotId,
          title: req.title,
          url: req.url,
        });
      },
    }),
  });
  deps.refsStore.data = { t1: { refs: { e1: 42 }, snapshotId: "s1" } };
  const app = createScraperApp(deps);
  await app.upload("t1", { ref: "e1" }, "/tmp/x", { includeSnapshot: true });
  assertEquals(receivedRequest?.dialog, {
    type: "alert",
    message: "unsaved changes",
    handled: "dismiss",
  });
});

Deno.test("upload: onDialog accept routes through CDP handleDialog with promptText", async () => {
  let dialogTrigger:
    | ((type: string, message: string, defaultPrompt: string) => void)
    | null = null;
  const handled: Array<{ accept: boolean; promptText?: string }> = [];
  const page = stubPage({
    onDialog: (handler) => {
      dialogTrigger = handler;
      return () => {
        dialogTrigger = null;
      };
    },
    handleDialog: (accept, promptText) => {
      handled.push({ accept, promptText });
      return Promise.resolve();
    },
    uploadFile: () => {
      dialogTrigger?.("prompt", "Your name?", "");
      return Promise.resolve();
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
  });
  deps.refsStore.data = { t1: { refs: { e1: 42 }, snapshotId: "s1" } };
  const app = createScraperApp(deps);
  await app.upload(
    "t1",
    { ref: "e1" },
    "/tmp/x",
    { onDialog: { accept: true, promptText: "Alice" } },
  );
  assertEquals(handled, [{ accept: true, promptText: "Alice" }]);
});

Deno.test("upload: stale --ref produces the canonical stale-ref error (no refs file)", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  const app = createScraperApp(deps);
  // refsStore has nothing for t1 → upload must fail before touching CDP.
  const err = await assertRejects(
    () => app.upload("t1", { ref: "e9999" }, "/tmp/x"),
    Error,
  );
  assertEquals(
    err.message.startsWith("ref e9999 is stale — not in refs.t1.json"),
    true,
    `expected canonical stale-ref message, got: ${err.message}`,
  );
});

Deno.test("upload: --ref not in current refs map produces the canonical stale-ref error", async () => {
  let uploadCalled = false;
  const page = stubPage({
    uploadFile: () => {
      uploadCalled = true;
      return Promise.resolve();
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
  });
  deps.refsStore.data = { t1: { refs: { e1: 42 }, snapshotId: "s1" } };
  const app = createScraperApp(deps);
  const err = await assertRejects(
    () => app.upload("t1", { ref: "e9999" }, "/tmp/x"),
    Error,
  );
  // The error must list the live refs so the agent can re-run snapshot if needed.
  assertEquals(err.message.includes("ref e9999 is stale"), true);
  assertEquals(err.message.includes("current refs: e1"), true);
  // Stale check fires before CDP — no upload attempt should reach the page.
  assertEquals(uploadCalled, false);
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

Deno.test("wait: without includeSnapshot returns empty ActionResult and skips snapshot", async () => {
  let snapshotCalls = 0;
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
    createSnapshotService: () => ({
      snapshot: (req) => {
        snapshotCalls++;
        return Promise.resolve({
          yaml: "",
          refs: {},
          lastRefCounter: 0,
          snapshotId: req.snapshotId,
          title: req.title,
          url: req.url,
        });
      },
    }),
  });
  deps.refsStore.data = { t1: { refs: { e1: 42 }, snapshotId: "s0" } };
  const app = createScraperApp(deps);
  const result = await app.wait("t1", { kind: "text", text: "hello" });
  // No snapshot requested — must not snapshot and must not touch refs.
  assertEquals(result, {});
  assertEquals(snapshotCalls, 0);
  assertEquals(deps.refsStore.data.t1, { refs: { e1: 42 }, snapshotId: "s0" });
});

Deno.test("wait: includeSnapshot auto-snapshots, persists new refs, and returns the snapshot", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  // Pre-existing refs from a prior snapshot on this tab — must be replaced
  // (not just removed) by the post-wait snapshot.
  deps.refsStore.data = { t1: { refs: { e1: 42 }, snapshotId: "s0" } };
  const app = createScraperApp(deps);
  const result = await app.wait(
    "t1",
    { kind: "text", text: "hello" },
    { includeSnapshot: true },
  );
  assertEquals(result.snapshot?.snapshotId, "s1");
  // Default snapshot-service stub mints one ref per call.
  assertEquals(deps.refsStore.data.t1, { refs: { e1: 42 }, snapshotId: "s1" });
});

Deno.test("wait: invalidates refs even when auto-snapshot fails", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
    createSnapshotService: () => ({
      snapshot: () => Promise.reject(new Error("snapshot failed")),
    }),
  });
  // Pre-existing refs; wait succeeds, page changed, snapshot then fails. Old
  // refs must not remain resolvable against the new DOM (mirrors the invariant
  // enforced by `navigate`).
  deps.refsStore.data = {
    t1: { refs: { e1: 42 }, snapshotId: "s0" },
    other: { refs: { e9: 1 }, snapshotId: "s0" },
  };
  const app = createScraperApp(deps);
  await assertRejects(
    () =>
      app.wait(
        "t1",
        { kind: "text", text: "hello" },
        { includeSnapshot: true },
      ),
    Error,
    "snapshot failed",
  );
  assertEquals(deps.refsStore.data, { other: { refs: { e9: 1 }, snapshotId: "s0" } });
});

Deno.test("wait: timeout does not snapshot and does not touch refs", async () => {
  let snapshotCalls = 0;
  const page = stubPage({
    waitForText: () => Promise.reject(new Error('timed out waiting for text "never" (30000ms)')),
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
    createSnapshotService: () => ({
      snapshot: (req) => {
        snapshotCalls++;
        return Promise.resolve({
          yaml: "",
          refs: {},
          lastRefCounter: 0,
          snapshotId: req.snapshotId,
          title: req.title,
          url: req.url,
        });
      },
    }),
  });
  deps.refsStore.data = { t1: { refs: { e1: 42 }, snapshotId: "s0" } };
  const app = createScraperApp(deps);
  await assertRejects(
    () =>
      app.wait(
        "t1",
        { kind: "text", text: "never" },
        { includeSnapshot: true },
      ),
    Error,
    "timed out",
  );
  assertEquals(snapshotCalls, 0);
  // Refs must be untouched on timeout — there is no new state to capture.
  assertEquals(deps.refsStore.data.t1, { refs: { e1: 42 }, snapshotId: "s0" });
});

Deno.test("wait: dialog during wait is dismissed and surfaced in the auto-snapshot", async () => {
  let dialogTrigger:
    | ((type: string, message: string, defaultPrompt: string) => void)
    | null = null;
  let receivedRequest: SnapshotRequest | undefined;
  const page = stubPage({
    onDialog: (handler) => {
      dialogTrigger = handler;
      return () => {
        dialogTrigger = null;
      };
    },
    waitForText: () => {
      dialogTrigger?.("alert", "wait-time alert", "");
      return Promise.resolve();
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
    createSnapshotService: () => ({
      snapshot: (req) => {
        receivedRequest = req;
        return Promise.resolve({
          yaml: "",
          refs: {},
          lastRefCounter: 0,
          snapshotId: req.snapshotId,
          title: req.title,
          url: req.url,
        });
      },
    }),
  });
  const app = createScraperApp(deps);
  await app.wait(
    "t1",
    { kind: "text", text: "hello" },
    { includeSnapshot: true },
  );
  assertEquals(receivedRequest?.dialog, {
    type: "alert",
    message: "wait-time alert",
    handled: "dismiss",
  });
});

Deno.test("wait: dialog handler is installed before the wait call runs", async () => {
  // Regression guard: wait previously ran outside withDialogHandling, so an
  // alert fired by the same click that triggered the waited-on condition
  // would block the page indefinitely.
  let handlerInstalledBeforeWait = false;
  let handlerInstalled = false;
  const page = stubPage({
    onDialog: (_handler) => {
      handlerInstalled = true;
      return () => {};
    },
    waitForSelector: () => {
      handlerInstalledBeforeWait = handlerInstalled;
      return Promise.resolve();
    },
  });
  const deps = createDeps({ createPageConnection: () => Promise.resolve(page) });
  const app = createScraperApp(deps);
  await app.wait("t1", { kind: "selector", selector: "#ok" });
  assertEquals(handlerInstalledBeforeWait, true);
});

Deno.test("wait: textInElement resolves the target via refs and delegates to page.waitForTextInElement", async () => {
  let waitedObjectId = "";
  let waitedText = "";
  let resolveRefsArg: RefMap | null | undefined;
  const page = stubPage({
    waitForTextInElement: (objectId, t) => {
      waitedObjectId = objectId;
      waitedText = t;
      return Promise.resolve();
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
    resolveTarget: (_target, _page, refs) => {
      resolveRefsArg = refs;
      return Promise.resolve("obj-ref-1");
    },
  });
  deps.refsStore.data = { t1: { refs: { e5: 77 }, snapshotId: "s1" } };
  const app = createScraperApp(deps);
  await app.wait("t1", { kind: "textInElement", target: { ref: "e5" }, text: "Done" });
  assertEquals(waitedObjectId, "obj-ref-1");
  assertEquals(waitedText, "Done");
  assertEquals(resolveRefsArg, { e5: 77 });
});

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

Deno.test("evaluate: dialog fired during eval is dismissed by default", async () => {
  let dialogTrigger:
    | ((type: string, message: string, defaultPrompt: string) => void)
    | null = null;
  const handled: Array<{ accept: boolean; promptText?: string }> = [];
  const page = stubPage({
    onDialog: (handler) => {
      dialogTrigger = handler;
      return () => {
        dialogTrigger = null;
      };
    },
    handleDialog: (accept, promptText) => {
      handled.push({ accept, promptText });
      return Promise.resolve();
    },
    evaluate: () => {
      dialogTrigger?.("alert", "from eval", "");
      return Promise.resolve({ result: 7 });
    },
  });
  const deps = createDeps({ createPageConnection: () => Promise.resolve(page) });
  const app = createScraperApp(deps);
  const { result } = await app.evaluate("t1", "1+1");
  assertEquals(result, 7);
  assertEquals(handled, [{ accept: false, promptText: undefined }]);
});

Deno.test("evaluate: onDialog accept passes through to CDP handleDialog", async () => {
  let dialogTrigger:
    | ((type: string, message: string, defaultPrompt: string) => void)
    | null = null;
  const handled: Array<{ accept: boolean; promptText?: string }> = [];
  const page = stubPage({
    onDialog: (handler) => {
      dialogTrigger = handler;
      return () => {
        dialogTrigger = null;
      };
    },
    handleDialog: (accept, promptText) => {
      handled.push({ accept, promptText });
      return Promise.resolve();
    },
    evaluate: () => {
      dialogTrigger?.("prompt", "pick one", "");
      return Promise.resolve({ result: null });
    },
  });
  const deps = createDeps({ createPageConnection: () => Promise.resolve(page) });
  const app = createScraperApp(deps);
  await app.evaluate("t1", "1+1", { onDialog: { accept: true, promptText: "yes" } });
  assertEquals(handled, [{ accept: true, promptText: "yes" }]);
});

Deno.test("evaluate: no $ref falls through to page.evaluate with the raw expression", async () => {
  let receivedExpr = "";
  let callsWithRefs = 0;
  const page = stubPage({
    evaluate: (expr) => {
      receivedExpr = expr;
      return Promise.resolve({ result: 42 });
    },
    evaluateWithRefs: () => {
      callsWithRefs++;
      return Promise.resolve({ result: 0 });
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
  });
  const app = createScraperApp(deps);
  const { result } = await app.evaluate("t1", "document.title");
  assertEquals(receivedExpr, "document.title");
  assertEquals(result, 42);
  assertEquals(callsWithRefs, 0);
});

Deno.test("evaluate: with $ref resolves backendNodeIds and dispatches evaluateWithRefs", async () => {
  let resolvedRef: { backendNodeId: number; refName: string } | null = null;
  const page = stubPage({
    resolveRef: (backendNodeId, refName) => {
      resolvedRef = { backendNodeId, refName };
      return Promise.resolve("obj-e3");
    },
    evaluateWithRefs: (expr, refs) => {
      assertEquals(expr, `$ref("e3").value`);
      assertEquals(refs, { e3: "obj-e3" });
      return Promise.resolve({ result: "hello" });
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
  });
  deps.refsStore.data = {
    t1: { refs: { e3: 77 }, snapshotId: "s4" },
  };
  const app = createScraperApp(deps);
  const { result } = await app.evaluate("t1", `$ref("e3").value`);
  assertEquals(resolvedRef, { backendNodeId: 77, refName: "e3" });
  assertEquals(result, "hello");
});

Deno.test("evaluate: $ref missing from refs file throws the exact design-doc stale-ref error", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  deps.refsStore.data = {
    "4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2": {
      refs: { e15: 100, e16: 101, e22: 102 },
      snapshotId: "s9",
    },
  };
  const app = createScraperApp(deps);
  await assertRejects(
    () => app.evaluate("4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2", `$ref("e3").click()`),
    Error,
    "ref e3 is stale — not in refs.4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2.json (current refs: e15..e22).",
  );
});

Deno.test("evaluate: $ref with no refs file at all reports `(current refs: none)`", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  const app = createScraperApp(deps);
  await assertRejects(
    () => app.evaluate("TID", `$ref("e3")`),
    Error,
    "ref e3 is stale — not in refs.TID.json (current refs: none).",
  );
});

Deno.test("evaluate: dedupes repeated refs and preserves argument order", async () => {
  const resolvedBackendIds: number[] = [];
  let receivedRefs: Record<string, string> | undefined;
  const page = stubPage({
    resolveRef: (backendNodeId) => {
      resolvedBackendIds.push(backendNodeId);
      return Promise.resolve(`obj-${backendNodeId}`);
    },
    evaluateWithRefs: (_expr, refs) => {
      receivedRefs = refs;
      return Promise.resolve({ result: null });
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
  });
  deps.refsStore.data = {
    t1: { refs: { e3: 30, e8: 80 }, snapshotId: "s1" },
  };
  const app = createScraperApp(deps);
  await app.evaluate("t1", `$ref("e8").value = $ref("e3").textContent; $ref("e8").focus();`);
  // Scanned in order of first appearance: e8, e3. Each resolved exactly once.
  assertEquals(resolvedBackendIds, [80, 30]);
  assertEquals(receivedRefs, { e8: "obj-80", e3: "obj-30" });
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
