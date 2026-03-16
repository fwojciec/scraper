import { assertEquals, assertRejects } from "@std/assert";
import type { CdpBrowserService, CdpPageService } from "../cdp/mod.ts";
import type { JsonFileStore } from "../fs/mod.ts";
import type { PageInfo, RefMap, SnapshotResult } from "../domain/mod.ts";
import {
  type AttachedState,
  type ChromeState,
  createScraperApp,
  type OwnedState,
  type ScraperAppDeps,
} from "./mod.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMemoryStore<T>(): JsonFileStore<T> & { data: T | null } {
  const store = {
    data: null as T | null,
    read() {
      return Promise.resolve(store.data);
    },
    write(d: T) {
      store.data = d;
      return Promise.resolve();
    },
    remove() {
      store.data = null;
      return Promise.resolve();
    },
  };
  return store;
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
    clickElement: () => Promise.resolve(),
    fillElement: () => Promise.resolve(),
    typeText: () => Promise.resolve(),
    selectOption: () => Promise.resolve(),
    submitForm: () => Promise.resolve(),
    focusElement: () => Promise.resolve(),
    pressKey: () => Promise.resolve(),
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
  const stateStore = createMemoryStore<ChromeState>();
  const refsStore = createMemoryStore<RefMap>();
  // Typed as ScraperAppDeps: compile error if interface gains new required fields.
  const base: ScraperAppDeps = {
    launchChrome: () =>
      Promise.resolve({
        pid: 1234,
        port: 9222,
        userDataDir: "/tmp/chrome-data",
        process: {
          unref() {},
          kill() {},
          get status() {
            return Promise.resolve({ success: true, code: 0, signal: null });
          },
        } as unknown as Deno.ChildProcess,
      }),
    defaultUserDataDir: () => "/default/chrome-data",
    readDevToolsActivePort: () => Promise.resolve({ port: 9222, wsPath: "/devtools/browser/abc" }),
    buildBrowserWsUrl: (port, wsPath) => `ws://127.0.0.1:${port}${wsPath}`,
    discoverWsUrl: () => Promise.resolve("ws://127.0.0.1:9222/devtools/browser/abc"),
    createBrowserConnection: () => Promise.resolve(stubBrowser()),
    createPageConnection: () => Promise.resolve(stubPage()),
    resolveTarget: () => Promise.resolve("obj-1"),
    createSnapshotService: () => ({
      snapshot: () => Promise.resolve({ yaml: "- text: hello\n", refs: { e1: 42 } }),
    }),
    stateStore,
    refsStore,
    isProcessAlive: () => true,
    isOurChromeProcess: () => true,
    killProcess: () => {},
    removeDir: () => Promise.resolve(),
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify([{ type: "page", id: "target-1" }]), { status: 200 }),
      ),
    warn: () => {},
    ...overrides,
  };
  // Re-expose memory stores for test assertions (preserves .data access).
  return { ...base, stateStore, refsStore };
}

const ownedState: OwnedState = {
  mode: "owned",
  chromePid: 1234,
  cdpPort: 9222,
  userDataDir: "/tmp/chrome-data",
  targetId: "target-1",
};

const attachedState: AttachedState = {
  mode: "attached",
  cdpPort: 9222,
  wsPath: "/devtools/browser/abc",
  targetId: "target-1",
};

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

Deno.test("start: launches Chrome when no state exists", async () => {
  const deps = createDeps();
  const app = createScraperApp(deps);
  const result = await app.start({});
  assertEquals(result, { status: "started", chromePid: 1234, cdpPort: 9222 });
  assertEquals(deps.stateStore.data?.mode, "owned");
});

Deno.test("start: returns already_running for live owned Chrome", async () => {
  const deps = createDeps();
  deps.stateStore.data = ownedState;
  const app = createScraperApp(deps);
  const result = await app.start({});
  assertEquals(result.status, "already_running");
  assertEquals(result.chromePid, 1234);
});

Deno.test("start: cleans up dead Chrome and launches new", async () => {
  const deps = createDeps({
    isProcessAlive: () => false,
  });
  deps.stateStore.data = ownedState;
  let removedDir = false;
  deps.removeDir = () => {
    removedDir = true;
    return Promise.resolve();
  };
  const app = createScraperApp(deps);
  const result = await app.start({});
  assertEquals(result.status, "started");
  assertEquals(removedDir, true);
});

Deno.test("start: removes foreign state and launches new", async () => {
  const deps = createDeps({
    isProcessAlive: () => true,
    isOurChromeProcess: () => false,
  });
  deps.stateStore.data = ownedState;
  const app = createScraperApp(deps);
  const result = await app.start({});
  assertEquals(result.status, "started");
});

Deno.test("start: throws when attached session exists", async () => {
  const deps = createDeps();
  deps.stateStore.data = attachedState;
  const app = createScraperApp(deps);
  await assertRejects(
    () => app.start({}),
    Error,
    "already attached to Chrome",
  );
});

Deno.test("start: throws when owned Chrome alive but CDP unresponsive", async () => {
  const deps = createDeps({
    fetch: () => Promise.reject(new Error("connection refused")),
  });
  deps.stateStore.data = ownedState;
  const app = createScraperApp(deps);
  await assertRejects(
    () => app.start({}),
    Error,
    "not responding",
  );
});

// ---------------------------------------------------------------------------
// start --attach
// ---------------------------------------------------------------------------

Deno.test("start --attach: connects and writes attached state", async () => {
  const deps = createDeps({
    createBrowserConnection: () =>
      Promise.resolve(stubBrowser({
        listPages: () =>
          Promise.resolve([{ pageId: "t1", url: "about:blank", title: "", active: false }]),
      })),
  });
  const app = createScraperApp(deps);
  const result = await app.start({ attach: true });
  assertEquals(result.status, "attached");
  assertEquals(deps.stateStore.data?.mode, "attached");
});

Deno.test("start --attach: already attached returns already_running", async () => {
  const deps = createDeps();
  deps.stateStore.data = attachedState;
  const app = createScraperApp(deps);
  const result = await app.start({ attach: true });
  assertEquals(result.status, "already_running");
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

Deno.test("stop: kills owned Chrome and cleans up", async () => {
  let killed = false;
  let processAliveCount = 0;
  const deps = createDeps({
    killProcess: () => {
      killed = true;
    },
    isProcessAlive: () => {
      processAliveCount++;
      // First call: classifyOwnedState → alive. Second call: poll → dead.
      return processAliveCount <= 1;
    },
  });
  deps.stateStore.data = ownedState;
  const app = createScraperApp(deps);
  await app.stop();
  assertEquals(killed, true);
  assertEquals(deps.stateStore.data, null);
});

Deno.test("stop: cleans up dead owned Chrome", async () => {
  const deps = createDeps({
    isProcessAlive: () => false,
  });
  deps.stateStore.data = ownedState;
  const app = createScraperApp(deps);
  await app.stop();
  assertEquals(deps.stateStore.data, null);
  assertEquals(deps.refsStore.data, null);
});

Deno.test("stop: removes state for attached Chrome without killing", async () => {
  let killed = false;
  const deps = createDeps({
    killProcess: () => {
      killed = true;
    },
  });
  deps.stateStore.data = attachedState;
  const app = createScraperApp(deps);
  await app.stop();
  assertEquals(killed, false);
  assertEquals(deps.stateStore.data, null);
});

Deno.test("stop: throws when no state", async () => {
  const deps = createDeps();
  const app = createScraperApp(deps);
  await assertRejects(() => app.stop(), Error, "chrome is not running");
});

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
  deps.stateStore.data = ownedState;
  const app = createScraperApp(deps);
  const result = await app.pages();
  assertEquals(result, pageList);
});

// ---------------------------------------------------------------------------
// selectPage
// ---------------------------------------------------------------------------

Deno.test("selectPage: updates state with new targetId", async () => {
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
  deps.stateStore.data = ownedState;
  deps.refsStore.data = { e1: 42 };
  const app = createScraperApp(deps);
  await app.selectPage("t2");
  assertEquals(deps.stateStore.data?.targetId, "t2");
  assertEquals(deps.refsStore.data, null); // refs cleared
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
  deps.stateStore.data = ownedState;
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
  deps.stateStore.data = ownedState;
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
  deps.stateStore.data = ownedState;
  const app = createScraperApp(deps);
  await app.navigate("https://example.com");
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("timed out"), true);
});

Deno.test("navigate: removes refs after navigation without snapshot", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  deps.stateStore.data = ownedState;
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
  deps.stateStore.data = ownedState;
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
  deps.stateStore.data = ownedState;
  const app = createScraperApp(deps);
  const result = await app.snapshot({});
  assertEquals(result.yaml, "- text: hello\n");
  assertEquals(deps.refsStore.data, { e1: 42 });
});

// ---------------------------------------------------------------------------
// click (representative action)
// ---------------------------------------------------------------------------

Deno.test("click: resolves target, clicks, runs post-action", async () => {
  let clicked = false;
  let resolvedTarget: unknown;
  const page = stubPage({
    clickElement: () => {
      clicked = true;
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
  deps.stateStore.data = ownedState;
  const app = createScraperApp(deps);
  await app.click({ ref: "e1" });
  assertEquals(clicked, true);
  assertEquals(resolvedTarget, { ref: "e1" });
});

Deno.test("click: returns snapshot when includeSnapshot set", async () => {
  const deps = createDeps({
    createPageConnection: () => Promise.resolve(stubPage()),
  });
  deps.stateStore.data = ownedState;
  const app = createScraperApp(deps);
  const result = await app.click({ ref: "e1" }, { includeSnapshot: true });
  assertEquals(result.snapshot?.yaml, "- text: hello\n");
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
  deps.stateStore.data = ownedState;
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
  deps.stateStore.data = ownedState;
  const app = createScraperApp(deps);
  await app.wait({ kind: "text", text: "hello" });
  assertEquals(waitedText, "hello");
});

// ---------------------------------------------------------------------------
// connection lifecycle
// ---------------------------------------------------------------------------

Deno.test("throws when no state for page operations", async () => {
  const deps = createDeps();
  const app = createScraperApp(deps);
  await assertRejects(() => app.snapshot({}), Error, "chrome is not running");
});

Deno.test("throws when no targetId for page operations", async () => {
  const noTargetState: AttachedState = { ...attachedState, targetId: undefined };
  const deps = createDeps();
  deps.stateStore.data = noTargetState;
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
  deps.stateStore.data = ownedState;
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
  deps.stateStore.data = ownedState;
  const app = createScraperApp(deps);
  await assertRejects(() => app.evaluate("bad"), Error, "eval failed");
  assertEquals(closed, true);
});
