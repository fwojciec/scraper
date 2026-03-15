import { assert, assertEquals, assertGreater, assertRejects } from "@std/assert";
import { type ChromeProcess, killChrome, launchChrome } from "../../src/cdp/chrome.ts";
import {
  type CdpPageService,
  createPageConnection,
  discoverWsUrl,
} from "../../src/cdp/connection.ts";

let chrome: ChromeProcess;
let targetId: string;
let wsUrl: string;

/** Discover the initial page target from /json/list with retries. */
async function discoverPageTarget(port: number): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        // deno-lint-ignore no-explicit-any
        const pageTarget = targets.find((t: any) => t.type === "page");
        if (pageTarget) return pageTarget.id;
      } else {
        await res.body?.cancel();
      }
    } catch { /* transport failure, retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("no page target found");
}

/** Launch Chrome and discover the initial page target. */
async function setup(): Promise<CdpPageService> {
  chrome = await launchChrome();
  targetId = await discoverPageTarget(chrome.port);
  wsUrl = await discoverWsUrl(chrome.port);
  return await createPageConnection(wsUrl, targetId);
}

async function teardown(browser?: CdpPageService) {
  try {
    browser?.close();
  } catch { /* connection may not have been established */ }
  await killChrome(chrome);
}

Deno.test("navigate loads a page", async () => {
  const browser = await setup();
  try {
    await browser.navigate("about:blank");
  } finally {
    await teardown(browser);
  }
});

Deno.test("navigate loads a real page and waits for load", async () => {
  const browser = await setup();
  try {
    const url = "data:text/html,<h1>Hello</h1>";
    await browser.navigate(url);
    const result = await browser.evaluate(
      "document.querySelector('h1').textContent",
    );
    assertEquals(result.result, "Hello");
  } finally {
    await teardown(browser);
  }
});

Deno.test("evaluate runs JS and returns result", async () => {
  const browser = await setup();
  try {
    await browser.navigate("about:blank");
    const result = await browser.evaluate("1 + 2");
    assertEquals(result.result, 3);
  } finally {
    await teardown(browser);
  }
});

Deno.test("evaluate returns complex objects by value", async () => {
  const browser = await setup();
  try {
    await browser.navigate("about:blank");
    const result = await browser.evaluate("({a: 1, b: [2, 3]})");
    assertEquals(result.result, { a: 1, b: [2, 3] });
  } finally {
    await teardown(browser);
  }
});

Deno.test("screenshot returns a valid png file path", async () => {
  const browser = await setup();
  try {
    await browser.navigate("about:blank");
    const path = await browser.screenshot();
    assert(path.endsWith(".png"));
    const stat = await Deno.stat(path);
    assertGreater(stat.size, 0);
    await Deno.remove(path);
  } finally {
    await teardown(browser);
  }
});

Deno.test("reconnect: new connection to same target works", async () => {
  const browserA = await setup();
  try {
    await browserA.navigate("data:text/html,<h1>Persisted</h1>");
    browserA.close();

    // Reconnect to same target
    const browserB = await createPageConnection(wsUrl, targetId);
    try {
      const result = await browserB.evaluate(
        "document.querySelector('h1').textContent",
      );
      assertEquals(result.result, "Persisted");
    } finally {
      browserB.close();
    }
  } finally {
    await teardown();
  }
});

Deno.test("stale target: clean error when target is gone", async () => {
  const browser = await setup();
  try {
    browser.close();

    // Close the target via Chrome's HTTP endpoint
    const closeRes = await fetch(`http://127.0.0.1:${chrome.port}/json/close/${targetId}`);
    await closeRes.body?.cancel();
    // Wait a moment for Chrome to process
    await new Promise((r) => setTimeout(r, 200));

    await assertRejects(
      () => createPageConnection(wsUrl, targetId),
      Error,
      "target no longer exists",
    );
  } finally {
    await teardown();
  }
});
