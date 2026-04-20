import { assertEquals, assertRejects } from "@std/assert";
import type { CdpBrowserService, CdpPageService } from "../cdp/mod.ts";
import type { PageInfo, RefMap, SnapshotResult } from "../domain/mod.ts";
import { createScraperApp, type RefsStore, type ScraperAppDeps, type TargetStore } from "./mod.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTargetStore(initial?: string | null): TargetStore & { data: string | null } {
  const s = {
    data: initial ?? null,
    read() {
      return Promise.resolve(s.data);
    },
    write(t: string) {
      s.data = t;
      return Promise.resolve();
    },
    remove() {
      s.data = null;
      return Promise.resolve();
    },
  };
  return s;
}

function createRefsStore(initial?: RefMap | null): RefsStore & { data: RefMap | null } {
  const s = {
    data: initial ?? null,
    read() {
      return Promise.resolve(s.data);
    },
    write(r: RefMap) {
      s.data = r;
      return Promise.resolve();
    },
    remove() {
      s.data = null;
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

function stubBrowser(
  overrides: Partial<CdpBrowserService> = {},
): CdpBrowserService {
  return {
    listPages: () => Promise.resolve([]),
    close: () => {},
    ...overrides,
  };
}

/** Default deps — all stubs. Clone and override per test. */
function createDeps(overrides: Partial<ScraperAppDeps> = {}) {
  const targetStore = createTargetStore(null);
  const refsStore = createRefsStore(null);
  const base: ScraperAppDeps = {
    userDataDir: "/default/chrome-data",
    readDevToolsActivePort: () => Promise.resolve({ port: 9222, wsPath: "/devtools/browser/abc" }),
    buildBrowserWsUrl: (port, wsPath) => `ws://127.0.0.1:${port}${wsPath}`,
    createBrowserConnection: () => Promise.resolve(stubBrowser()),
    createPageConnection: () => Promise.resolve(stubPage()),
    resolveTarget: () => Promise.resolve("obj-1"),
    createSnapshotService: () => ({
      snapshot: () => Promise.resolve({ yaml: "- text: hello\n", refs: { e1: 42 } }),
    }),
    targetStore,
    refsStore,
    warn: () => {},
    ...overrides,
  };
  return { ...base, targetStore, refsStore };
}

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------

Deno.test("pages: lists pages via browser connection", async () => {
  const pageList: PageInfo[] = [
    { pageId: "t1", url: "https://example.com", title: "Example", active: true },
    { pageId: "t2", url: "about:blank", title: "", active: false },
  ];
  const deps = createDeps({
    createBrowserConnection: () =>
      Promise.resolve(stubBrowser({ listPages: () => Promise.resolve(pageList) })),
  });
  deps.targetStore.data = "t1";
  const app = createScraperApp(deps);
  const result = await app.pages();
  assertEquals(result, pageList);
});

Deno.test("pages: works with no target selected", async () => {
  const pageList: PageInfo[] = [
    { pageId: "t1", url: "about:blank", title: "", active: false },
  ];
  let receivedActive: string | undefined;
  const deps = createDeps({
    createBrowserConnection: () =>
      Promise.resolve(stubBrowser({
        listPages: (active) => {
          receivedActive = active;
          return Promise.resolve(pageList);
        },
      })),
  });
  const app = createScraperApp(deps);
  const result = await app.pages();
  assertEquals(result, pageList);
  assertEquals(receivedActive, undefined);
});

// ---------------------------------------------------------------------------
// selectPage
// ---------------------------------------------------------------------------

Deno.test("selectPage: persists targetId and clears refs", async () => {
  const deps = createDeps({
    createBrowserConnection: () =>
      Promise.resolve(
        stubBrowser({
          listPages: () =>
            Promise.resolve([
              { pageId: "t1", url: "about:blank", title: "", active: true },
              { pageId: "t2", url: "https://example.com", title: "Ex", active: false },
            ]),
        }),
      ),
  });
  deps.refsStore.data = { e1: 42 };
  const app = createScraperApp(deps);
  await app.selectPage("t2");
  assertEquals(deps.targetStore.data, "t2");
  assertEquals(deps.refsStore.data, null);
});

Deno.test("selectPage: throws for unknown page", async () => {
  const deps = createDeps({
    createBrowserConnection: () =>
      Promise.resolve(
        stubBrowser({
          listPages: () =>
            Promise.resolve([
              { pageId: "t1", url: "about:blank", title: "", active: true },
            ]),
        }),
      ),
  });
  const app = createScraperApp(deps);
  await assertRejects(() => app.selectPage("nope"), Error, "no page with id");
});

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
  deps.targetStore.data = "t1";
  const app = createScraperApp(deps);
  const result = await app.navigate("https://example.com");
  assertEquals(navigated, "https://example.com");
  assertEquals(networkIdleCalled, true);
  assertEquals(result, {});
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
  deps.targetStore.data = "t1";
  const app = createScraperApp(deps);
  await app.navigate("https://example.com");
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("timed out"), true);
});

Deno.test("navigate: removes refs after navigation without snapshot", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  deps.targetStore.data = "t1";
  deps.refsStore.data = { e1: 42 };
  const app = createScraperApp(deps);
  await app.navigate("https://example.com");
  assertEquals(deps.refsStore.data, null);
});

Deno.test("navigate: returns snapshot when includeSnapshot set", async () => {
  const snapshotResult: SnapshotResult = { yaml: "- text: hi\n", refs: { e1: 1 } };
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
    createSnapshotService: () => ({
      snapshot: () => Promise.resolve(snapshotResult),
    }),
  });
  deps.targetStore.data = "t1";
  const app = createScraperApp(deps);
  const result = await app.navigate("https://example.com", { includeSnapshot: true });
  assertEquals(result.snapshot, snapshotResult);
});

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

Deno.test("snapshot: returns YAML and persists refs", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  deps.targetStore.data = "t1";
  const app = createScraperApp(deps);
  const result = await app.snapshot({});
  assertEquals(result.yaml, "- text: hello\n");
  assertEquals(deps.refsStore.data, { e1: 42 });
});

// ---------------------------------------------------------------------------
// upload (representative action)
// ---------------------------------------------------------------------------

Deno.test("upload: resolves target, uploads file, runs post-action", async () => {
  let uploadedPath = "";
  let uploadedObjectId = "";
  let resolvedTarget: unknown;
  const page = stubPage({
    uploadFile: (objectId, filePath) => {
      uploadedObjectId = objectId;
      uploadedPath = filePath;
      return Promise.resolve();
    },
  });
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(page),
    resolveTarget: (target) => {
      resolvedTarget = target;
      return Promise.resolve("obj-1");
    },
  });
  deps.targetStore.data = "t1";
  const app = createScraperApp(deps);
  await app.upload({ ref: "e1" }, "/tmp/photo.jpg");
  assertEquals(uploadedObjectId, "obj-1");
  assertEquals(uploadedPath, "/tmp/photo.jpg");
  assertEquals(resolvedTarget, { ref: "e1" });
});

Deno.test("upload: returns snapshot when includeSnapshot set", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  deps.targetStore.data = "t1";
  const app = createScraperApp(deps);
  const result = await app.upload(
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
  deps.targetStore.data = "t1";
  const app = createScraperApp(deps);
  await assertRejects(
    () => app.upload({ ref: "e1" }, "/tmp/x"),
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
  deps.targetStore.data = "t1";
  const app = createScraperApp(deps);
  await app.wait({ kind: "selector", selector: "#foo" });
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
  deps.targetStore.data = "t1";
  const app = createScraperApp(deps);
  await app.wait({ kind: "text", text: "hello" });
  assertEquals(waitedText, "hello");
});

// ---------------------------------------------------------------------------
// connection lifecycle
// ---------------------------------------------------------------------------

Deno.test("throws when no target selected for page operations", async () => {
  const deps = createDeps();
  const app = createScraperApp(deps);
  await assertRejects(() => app.snapshot({}), Error, "no page selected");
});

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
  deps.targetStore.data = "t1";
  const app = createScraperApp(deps);
  await app.evaluate("1+1");
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
  deps.targetStore.data = "t1";
  const app = createScraperApp(deps);
  await assertRejects(() => app.evaluate("bad"), Error, "eval failed");
  assertEquals(closed, true);
});

Deno.test("stale target: clears target + refs when target no longer exists", async () => {
  const deps = createDeps({
    createPageConnection: () =>
      Promise.reject(new Error("target no longer exists — run 'scraper pages' to pick a new tab")),
  });
  deps.targetStore.data = "dead-target";
  deps.refsStore.data = { e1: 42 };
  const app = createScraperApp(deps);
  await assertRejects(() => app.snapshot({}), Error, "target no longer exists");
  assertEquals(deps.targetStore.data, null);
  assertEquals(deps.refsStore.data, null);
});

Deno.test("stale target: other errors don't clear state", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.reject(new Error("connection refused")),
  });
  deps.targetStore.data = "some-target";
  deps.refsStore.data = { e1: 42 };
  const app = createScraperApp(deps);
  await assertRejects(() => app.snapshot({}), Error, "connection refused");
  assertEquals(deps.targetStore.data, "some-target");
  assertEquals(deps.refsStore.data, { e1: 42 });
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
  deps.targetStore.data = "t1";
  const app = createScraperApp(deps);
  await app.evaluate("1+1");
  assertEquals(readDir, "/my/chrome");
});
