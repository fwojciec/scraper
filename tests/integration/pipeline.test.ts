/** Integration tests: full pipeline with real Chrome, CDP, ARIA snapshots, and local fixtures. */

import { assert, assertEquals } from "@std/assert";
import { type ChromeProcess, killChrome, launchChrome } from "../../src/cdp/chrome.ts";
import {
  type CdpPageService,
  createPageConnection,
  discoverWsUrl,
} from "../../src/cdp/connection.ts";
import { createSnapshotService } from "../../src/aria/mod.ts";
import type { SnapshotService } from "../../src/domain/browser.ts";
import { type FixtureServer, startFixtureServer } from "./fixture-server.ts";

interface TestContext {
  fixtures: FixtureServer;
  chrome: ChromeProcess;
  browser: CdpPageService;
  snapshots: SnapshotService;
}

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

async function setup(): Promise<TestContext> {
  const partial: Partial<TestContext> = {};
  try {
    partial.fixtures = startFixtureServer();
    partial.chrome = await launchChrome();
    const targetId = await discoverPageTarget(partial.chrome.port);
    const wsUrl = await discoverWsUrl(partial.chrome.port);
    partial.browser = await createPageConnection(wsUrl, targetId);
    partial.snapshots = createSnapshotService({
      async getFullAXTree() {
        return await partial.browser!.getFullAXTree();
      },
      async resolveSelector(selector: string) {
        return await partial.browser!.resolveSelector(selector);
      },
    });
    return partial as TestContext;
  } catch (err) {
    await teardown(partial);
    throw err;
  }
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

// --- Snapshot integration tests ---

Deno.test("snapshot: bestseller table has expected ARIA structure", async () => {
  const ctx = await setup();
  try {
    await ctx.browser.navigate(ctx.fixtures.url("bestseller-table.html"));
    const result = await ctx.snapshots.snapshot({});

    // Verify heading
    assert(result.yaml.includes("heading"), "should contain heading role");
    assert(result.yaml.includes("Top Bestselling Books"), "should contain heading text");

    // Verify table structure
    assert(result.yaml.includes("table"), "should contain table role");
    assert(/^\s*- row[\s":]/m.test(result.yaml), "should contain row roles");
    assert(result.yaml.includes("columnheader"), "should contain columnheader roles");
    assert(result.yaml.includes("cell"), "should contain cell roles");

    // Verify data in cells
    assert(result.yaml.includes("Dune"), "should contain book title Dune");
    assert(result.yaml.includes("Frank Herbert"), "should contain author");
    assert(result.yaml.includes("$12.99"), "should contain price");

    // Verify links are rendered with refs
    assert(result.yaml.includes("link"), "should contain link roles");
    assert(result.yaml.includes("ref="), "links should have interactable refs");

    // Verify refs map is populated
    assert(Object.keys(result.refs).length > 0, "refs should be populated");

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
    await ctx.browser.navigate(ctx.fixtures.url("js-rendered.html"));
    const result = await ctx.snapshots.snapshot({});

    // Verify JS-rendered DOM structure (article + heading roles prove script executed)
    assert(result.yaml.includes("- article"), "should contain article roles from JS-rendered DOM");
    assert(
      result.yaml.includes('heading "Alice"'),
      "should contain heading with JS-rendered reviewer name",
    );
    assert(
      result.yaml.includes('heading "Bob"'),
      "should contain heading with JS-rendered reviewer name",
    );
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
    await ctx.browser.navigate(ctx.fixtures.url("bestseller-table.html"));
    const result = await ctx.browser.evaluate(`
        Array.from(document.querySelectorAll("tbody tr")).map(row => {
          const cells = row.querySelectorAll("td");
          return {
            rank: Number(cells[0].textContent),
            title: cells[1].textContent.trim(),
            author: cells[2].textContent.trim(),
            price: cells[3].textContent.trim(),
          };
        })
      `);

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
    await ctx.browser.navigate(ctx.fixtures.url("js-rendered.html"));
    const result = await ctx.browser.evaluate(`
        Array.from(document.querySelectorAll("article")).map(article => ({
          user: article.querySelector("h2").textContent,
          text: article.querySelectorAll("p")[1].textContent,
        }))
      `);

    assertEquals(result.result, [
      { user: "Alice", text: "Excellent product!" },
      { user: "Bob", text: "Average quality." },
    ]);
  } finally {
    await teardown(ctx);
  }
});

// --- Refs integration test ---

Deno.test("snapshot: refs map to valid backendDOMNodeIds", async () => {
  const ctx = await setup();
  try {
    await ctx.browser.navigate(ctx.fixtures.url("bestseller-table.html"));
    const result = await ctx.snapshots.snapshot({});

    // Refs should be populated with positive integers
    const refEntries = Object.entries(result.refs);
    assert(refEntries.length > 0, "should have refs");
    for (const [ref, backendNodeId] of refEntries) {
      assert(ref.startsWith("e"), `ref should start with 'e': ${ref}`);
      assert(typeof backendNodeId === "number", `backendNodeId should be number: ${backendNodeId}`);
      assert(backendNodeId > 0, `backendNodeId should be positive: ${backendNodeId}`);
    }
  } finally {
    await teardown(ctx);
  }
});
