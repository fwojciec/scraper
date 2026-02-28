/** Integration tests: full pipeline with real Chrome, CDP, ARIA snapshots, and local fixtures. */

import { assert, assertEquals } from "@std/assert";
import { type ChromeProcess, killChrome, launchChrome } from "../../src/cdp/chrome.ts";
import { type CdpBrowserService, createCdpConnection } from "../../src/cdp/connection.ts";
import { createSnapshotService } from "../../src/aria/snapshot.ts";
import type { SnapshotService } from "../../src/domain/browser.ts";
import { type FixtureServer, startFixtureServer } from "./fixture-server.ts";

interface TestContext {
  fixtures: FixtureServer;
  chrome: ChromeProcess;
  browser: CdpBrowserService;
  snapshots: SnapshotService;
}

async function setup(): Promise<TestContext> {
  const fixtures = startFixtureServer();
  const chrome = await launchChrome();
  const browser = await createCdpConnection(chrome.port);
  const snapshots = createSnapshotService();
  return { fixtures, chrome, browser, snapshots };
}

async function teardown(ctx: Partial<TestContext>) {
  try {
    ctx.browser?.close();
  } catch { /* already closed */ }
  try {
    if (ctx.chrome) await killChrome(ctx.chrome);
  } catch { /* already dead */ }
  try {
    await ctx.fixtures?.close();
  } catch { /* already closed */ }
}

function evaluateInPage(browser: CdpBrowserService, pageName: string) {
  return (expression: string) =>
    browser.evaluate({ name: pageName, expression }).then((r) => r.result as unknown);
}

// --- Snapshot integration tests ---

Deno.test("snapshot: bestseller table has expected ARIA structure", async () => {
  const ctx = await setup();
  try {
    await ctx.browser.navigate({
      url: ctx.fixtures.url("bestseller-table.html"),
      name: "table",
    });
    const result = await ctx.snapshots.snapshot(
      { name: "table" },
      evaluateInPage(ctx.browser, "table"),
    );

    // Verify heading
    assert(result.yaml.includes("heading"), "should contain heading role");
    assert(result.yaml.includes("Top Bestselling Books"), "should contain heading text");

    // Verify table structure
    assert(result.yaml.includes("table"), "should contain table role");
    assert(result.yaml.includes("row"), "should contain row roles");
    assert(result.yaml.includes("columnheader"), "should contain columnheader roles");
    assert(result.yaml.includes("cell"), "should contain cell roles");

    // Verify data in cells
    assert(result.yaml.includes("Dune"), "should contain book title Dune");
    assert(result.yaml.includes("Frank Herbert"), "should contain author");
    assert(result.yaml.includes("$12.99"), "should contain price");

    // Verify links are rendered with refs
    assert(result.yaml.includes("link"), "should contain link roles");
    assert(result.yaml.includes("ref="), "links should have interactable refs");

    // Verify navigation
    assert(result.yaml.includes("navigation"), "should contain nav landmark");
    assert(result.yaml.includes("Next Page"), "should contain pagination link");
  } finally {
    await teardown(ctx);
  }
});

Deno.test("snapshot: JS-rendered page has dynamically created content", async () => {
  const ctx = await setup();
  try {
    await ctx.browser.navigate({
      url: ctx.fixtures.url("js-rendered.html"),
      name: "jspage",
    });
    const result = await ctx.snapshots.snapshot(
      { name: "jspage" },
      evaluateInPage(ctx.browser, "jspage"),
    );

    // Verify JS-rendered content is present (not just the static shell)
    assert(result.yaml.includes("Alice"), "should contain JS-rendered reviewer name");
    assert(result.yaml.includes("Bob"), "should contain JS-rendered reviewer name");
    assert(result.yaml.includes("Excellent product!"), "should contain JS-rendered review text");
    assert(result.yaml.includes("Rating: 5/5"), "should contain JS-rendered rating");
  } finally {
    await teardown(ctx);
  }
});

// --- Eval integration tests ---

Deno.test("eval: extract table data from bestseller fixture", async () => {
  const ctx = await setup();
  try {
    await ctx.browser.navigate({
      url: ctx.fixtures.url("bestseller-table.html"),
      name: "eval-table",
    });
    const result = await ctx.browser.evaluate({
      name: "eval-table",
      expression: `
        Array.from(document.querySelectorAll("tbody tr")).map(row => {
          const cells = row.querySelectorAll("td");
          return {
            rank: Number(cells[0].textContent),
            title: cells[1].textContent.trim(),
            author: cells[2].textContent.trim(),
            price: cells[3].textContent.trim(),
          };
        })
      `,
    });

    assertEquals(result.result, [
      { rank: 1, title: "Dune", author: "Frank Herbert", price: "$12.99" },
      { rank: 2, title: "Neuromancer", author: "William Gibson", price: "$10.99" },
      { rank: 3, title: "Foundation", author: "Isaac Asimov", price: "$11.49" },
    ]);
  } finally {
    await teardown(ctx);
  }
});

Deno.test("eval: extract JS-rendered review data", async () => {
  const ctx = await setup();
  try {
    await ctx.browser.navigate({
      url: ctx.fixtures.url("js-rendered.html"),
      name: "eval-js",
    });
    const result = await ctx.browser.evaluate({
      name: "eval-js",
      expression: `
        Array.from(document.querySelectorAll("article")).map(article => ({
          user: article.querySelector("h2").textContent,
          text: article.querySelectorAll("p")[1].textContent,
        }))
      `,
    });

    assertEquals(result.result, [
      { user: "Alice", text: "Excellent product!" },
      { user: "Bob", text: "Average quality." },
    ]);
  } finally {
    await teardown(ctx);
  }
});
