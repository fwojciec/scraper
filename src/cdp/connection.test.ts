import { assert, assertEquals, assertGreater, assertRejects } from "@std/assert";
import { type ChromeProcess, killChrome, launchChrome } from "./chrome.ts";
import { type CdpBrowserService, createCdpConnection } from "./connection.ts";

let chrome: ChromeProcess;
let browser: CdpBrowserService;

async function setup() {
  chrome = await launchChrome();
  browser = await createCdpConnection(chrome.port);
}

async function teardown() {
  try {
    browser?.close();
  } catch { /* connection may not have been established */ }
  await killChrome(chrome);
}

Deno.test("navigate opens a page and returns PageInfo", async () => {
  await setup();
  try {
    const info = await browser.navigate({ url: "about:blank", name: "test" });
    assertEquals(info.name, "test");
    assertEquals(info.url, "about:blank");
    assertEquals(typeof info.targetId, "string");
  } finally {
    await teardown();
  }
});

Deno.test("navigate defaults name to 'default'", async () => {
  await setup();
  try {
    const info = await browser.navigate({ url: "about:blank" });
    assertEquals(info.name, "default");
  } finally {
    await teardown();
  }
});

Deno.test("navigate reuses existing page with same name", async () => {
  await setup();
  try {
    const first = await browser.navigate({ url: "about:blank", name: "reuse" });
    const second = await browser.navigate({ url: "about:blank", name: "reuse" });
    assertEquals(first.targetId, second.targetId);
  } finally {
    await teardown();
  }
});

Deno.test("evaluate runs JS and returns result", async () => {
  await setup();
  try {
    await browser.navigate({ url: "about:blank", name: "eval-test" });
    const result = await browser.evaluate({ name: "eval-test", expression: "1 + 2" });
    assertEquals(result.result, 3);
  } finally {
    await teardown();
  }
});

Deno.test("evaluate returns complex objects by value", async () => {
  await setup();
  try {
    await browser.navigate({ url: "about:blank", name: "obj-test" });
    const result = await browser.evaluate({
      name: "obj-test",
      expression: "({a: 1, b: [2, 3]})",
    });
    assertEquals(result.result, { a: 1, b: [2, 3] });
  } finally {
    await teardown();
  }
});

Deno.test("listPages returns all named pages", async () => {
  await setup();
  try {
    await browser.navigate({ url: "about:blank", name: "page-a" });
    await browser.navigate({ url: "about:blank", name: "page-b" });
    const pages = await browser.listPages();
    const names = pages.map((p) => p.name).sort();
    assertEquals(names.includes("page-a"), true);
    assertEquals(names.includes("page-b"), true);
    assertGreater(pages.length, 1);
  } finally {
    await teardown();
  }
});

Deno.test("closePage removes a named page", async () => {
  await setup();
  try {
    await browser.navigate({ url: "about:blank", name: "ephemeral" });
    await browser.closePage("ephemeral");
    const pages = await browser.listPages();
    const names = pages.map((p) => p.name);
    assertEquals(names.includes("ephemeral"), false);
  } finally {
    await teardown();
  }
});

Deno.test("closePage throws for unknown page", async () => {
  await setup();
  try {
    await assertRejects(
      () => browser.closePage("nonexistent"),
      Error,
      "nonexistent",
    );
  } finally {
    await teardown();
  }
});

Deno.test("screenshot returns a valid png file path", async () => {
  await setup();
  try {
    await browser.navigate({ url: "about:blank", name: "snap" });
    const path = await browser.screenshot("snap");
    assert(path.endsWith(".png"));
    const stat = await Deno.stat(path);
    assertGreater(stat.size, 0);
    await Deno.remove(path);
  } finally {
    await teardown();
  }
});

Deno.test("navigate loads a real page and waits for load", async () => {
  await setup();
  try {
    const url = "data:text/html,<h1>Hello</h1>";
    const info = await browser.navigate({ url, name: "real" });
    assertEquals(info.name, "real");
    const result = await browser.evaluate({
      name: "real",
      expression: "document.querySelector('h1').textContent",
    });
    assertEquals(result.result, "Hello");
  } finally {
    await teardown();
  }
});

Deno.test("concurrent navigates to same name do not leak targets", async () => {
  await setup();
  try {
    const [a, b] = await Promise.all([
      browser.navigate({ url: "about:blank", name: "dup" }),
      browser.navigate({ url: "about:blank", name: "dup" }),
    ]);
    // Both should resolve to the same target (second reuses first)
    assertEquals(a.targetId, b.targetId);
    const pages = await browser.listPages();
    const dups = pages.filter((p) => p.name === "dup");
    assertEquals(dups.length, 1);
  } finally {
    await teardown();
  }
});

Deno.test("evaluate throws for unknown page", async () => {
  await setup();
  try {
    await assertRejects(
      () => browser.evaluate({ name: "ghost", expression: "1" }),
      Error,
      "ghost",
    );
  } finally {
    await teardown();
  }
});
