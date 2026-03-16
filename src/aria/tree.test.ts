import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type AccessibilityNode, transformAXTree, type TransformResult } from "./tree.ts";
import { renderYaml } from "./render.ts";

/** Helper: transform AccessibilityNodes and render to YAML. */
function snapshot(
  axNodes: AccessibilityNode[],
  options?: { maxDepth?: number; maxNodes?: number },
): string {
  const { nodes } = transformAXTree(axNodes, options);
  return renderYaml(nodes);
}

/** Helper: transform AccessibilityNodes and return full result (nodes + refs). */
function transform(
  axNodes: AccessibilityNode[],
  options?: { maxDepth?: number; maxNodes?: number },
  rootNodeId?: string,
): TransformResult {
  return transformAXTree(axNodes, options, rootNodeId);
}

/** Helper to build a minimal AccessibilityNode. */
function ax(overrides: Partial<AccessibilityNode> & { nodeId: string }): AccessibilityNode {
  return {
    ignored: false,
    ...overrides,
  };
}

// --- Basic role mapping ---

Deno.test("link gets role and ref", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "About Us" },
      backendDOMNodeId: 42,
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `link "About Us" [ref=e1]`);
});

Deno.test("button gets role and ref", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "button" },
      name: { type: "contents", value: "Click me" },
      backendDOMNodeId: 10,
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `button "Click me" [ref=e1]`);
});

Deno.test("heading with level preserved", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "heading" },
      name: { type: "contents", value: "Chapter One" },
      properties: [{ name: "level", value: { type: "integer", value: 2 } }],
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `heading "Chapter One" [level=2]`);
});

Deno.test("all heading levels 1-6", () => {
  for (let i = 1; i <= 6; i++) {
    const nodes: AccessibilityNode[] = [
      ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
      ax({
        nodeId: "2",
        role: { type: "role", value: "heading" },
        name: { type: "contents", value: "Title" },
        properties: [{ name: "level", value: { type: "integer", value: i } }],
      }),
    ];
    const yaml = snapshot(nodes);
    assertStringIncludes(yaml, `[level=${i}`);
  }
});

// --- Table structure ---

Deno.test("table structure maps to ARIA roles", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({ nodeId: "2", role: { type: "role", value: "table" }, childIds: ["3", "4"] }),
    ax({ nodeId: "3", role: { type: "role", value: "row" }, childIds: ["5", "6"] }),
    ax({
      nodeId: "5",
      role: { type: "role", value: "columnheader" },
      name: { type: "contents", value: "Rank" },
    }),
    ax({
      nodeId: "6",
      role: { type: "role", value: "columnheader" },
      name: { type: "contents", value: "Title" },
    }),
    ax({ nodeId: "4", role: { type: "role", value: "row" }, childIds: ["7", "8"] }),
    ax({
      nodeId: "7",
      role: { type: "role", value: "cell" },
      name: { type: "contents", value: "1" },
    }),
    ax({
      nodeId: "8",
      role: { type: "role", value: "cell" },
      name: { type: "contents", value: "Some Book" },
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, "table:");
  assertStringIncludes(yaml, "row:");
  assertStringIncludes(yaml, `columnheader "Rank"`);
  assertStringIncludes(yaml, `columnheader "Title"`);
  assertStringIncludes(yaml, `cell "1"`);
  assertStringIncludes(yaml, `cell "Some Book"`);
});

// --- Image ---

Deno.test("image with name gets img role", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "image" },
      name: { type: "attribute", value: "Logo" },
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `img "Logo"`);
});

// --- Ignored and hidden ---

Deno.test("ignored nodes excluded", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2", "3"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Visible" },
    }),
    ax({
      nodeId: "3",
      ignored: true,
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Hidden" },
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, "Visible");
  assert(!yaml.includes("Hidden"));
});

// --- Generic/transparent elements ---

Deno.test("generic elements are transparent", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({ nodeId: "2", role: { type: "role", value: "generic" }, childIds: ["3"] }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "Home" },
      backendDOMNodeId: 5,
    }),
  ];
  const yaml = snapshot(nodes);
  assert(!yaml.includes("generic"));
  assertStringIncludes(yaml, `link "Home"`);
});

Deno.test("none role is transparent", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({ nodeId: "2", role: { type: "role", value: "none" }, childIds: ["3"] }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "Home" },
      backendDOMNodeId: 5,
    }),
  ];
  const yaml = snapshot(nodes);
  assert(!yaml.includes("none"));
  assertStringIncludes(yaml, `link "Home"`);
});

Deno.test("presentation role is transparent", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({ nodeId: "2", role: { type: "role", value: "presentation" }, childIds: ["3"] }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "Home" },
      backendDOMNodeId: 5,
    }),
  ];
  const yaml = snapshot(nodes);
  assert(!yaml.includes("presentation"));
  assertStringIncludes(yaml, `link "Home"`);
});

// --- Name handling ---

Deno.test("explicit name (aria-label) overrides text content", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "button" },
      name: { type: "attribute", value: "Close dialog" },
      backendDOMNodeId: 10,
      childIds: ["3"],
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "StaticText" },
      name: { type: "contents", value: "X" },
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `button "Close dialog"`);
  assert(!yaml.includes(`"X"`));
});

Deno.test("text children absorbed into parent name", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Hello world" },
      childIds: ["3"],
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "StaticText" },
      name: { type: "contents", value: "Hello world" },
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `paragraph "Hello world"`);
  assert(!yaml.includes("text"));
});

Deno.test("semantic children shown when mixed with text", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Click here now" },
      childIds: ["3", "4", "5"],
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "StaticText" },
      name: { type: "contents", value: "Click " },
    }),
    ax({
      nodeId: "4",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "here" },
      backendDOMNodeId: 20,
    }),
    ax({
      nodeId: "5",
      role: { type: "role", value: "StaticText" },
      name: { type: "contents", value: " now" },
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, "paragraph:");
  assertStringIncludes(yaml, `text "Click "`);
  assertStringIncludes(yaml, `link "here"`);
  assertStringIncludes(yaml, `text " now"`);
});

Deno.test("explicit name with semantic children keeps both", () => {
  // <nav aria-label="Main"><a href="/">Home</a></nav>
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "navigation" },
      name: { type: "attribute", value: "Main" },
      childIds: ["3"],
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "Home" },
      backendDOMNodeId: 5,
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `navigation "Main":`);
  assertStringIncludes(yaml, `link "Home"`);
});

// --- Landmark roles ---

Deno.test("landmark roles preserved", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2", "3", "4"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "banner" },
      childIds: ["5"],
    }),
    ax({
      nodeId: "5",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "Logo" },
      backendDOMNodeId: 10,
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "main" },
      childIds: ["6"],
    }),
    ax({
      nodeId: "6",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Content" },
    }),
    ax({
      nodeId: "4",
      role: { type: "role", value: "contentinfo" },
      childIds: ["7"],
    }),
    ax({
      nodeId: "7",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Copyright" },
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, "banner:");
  assertStringIncludes(yaml, "main:");
  assertStringIncludes(yaml, "contentinfo:");
});

// --- Lists ---

Deno.test("list and listitem", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({ nodeId: "2", role: { type: "role", value: "list" }, childIds: ["3", "4"] }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "listitem" },
      name: { type: "contents", value: "One" },
    }),
    ax({
      nodeId: "4",
      role: { type: "role", value: "listitem" },
      name: { type: "contents", value: "Two" },
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, "list:");
  assertStringIncludes(yaml, `listitem "One"`);
  assertStringIncludes(yaml, `listitem "Two"`);
});

// --- Input types ---

Deno.test("textbox gets ref", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "textbox" },
      backendDOMNodeId: 15,
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `textbox [ref=e1]`);
});

Deno.test("combobox gets ref", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "combobox" },
      backendDOMNodeId: 20,
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `combobox`);
  assertStringIncludes(yaml, `ref=e1`);
});

Deno.test("checkbox gets ref", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "checkbox" },
      backendDOMNodeId: 25,
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `checkbox [ref=e1]`);
});

Deno.test("radio gets ref", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "radio" },
      backendDOMNodeId: 30,
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `radio [ref=e1]`);
});

// --- Refs ---

Deno.test("refs increment sequentially", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2", "3", "4"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "A" },
      backendDOMNodeId: 10,
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "B" },
      backendDOMNodeId: 20,
    }),
    ax({
      nodeId: "4",
      role: { type: "role", value: "button" },
      name: { type: "contents", value: "C" },
      backendDOMNodeId: 30,
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `[ref=e1]`);
  assertStringIncludes(yaml, `[ref=e2]`);
  assertStringIncludes(yaml, `[ref=e3]`);
});

Deno.test("refs map to backendDOMNodeIds", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2", "3"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "A" },
      backendDOMNodeId: 42,
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "button" },
      name: { type: "contents", value: "B" },
      backendDOMNodeId: 87,
    }),
  ];
  const result = transform(nodes);
  assertEquals(result.refs, { e1: 42, e2: 87 });
});

// --- Depth and node limits ---

Deno.test("maxDepth limits tree depth", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({ nodeId: "2", role: { type: "role", value: "navigation" }, childIds: ["3"] }),
    ax({ nodeId: "3", role: { type: "role", value: "list" }, childIds: ["4"] }),
    ax({ nodeId: "4", role: { type: "role", value: "listitem" }, childIds: ["5"] }),
    ax({
      nodeId: "5",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "Deep" },
      backendDOMNodeId: 10,
    }),
  ];
  const yaml = snapshot(nodes, { maxDepth: 2 });
  assertStringIncludes(yaml, "navigation:");
  assertStringIncludes(yaml, "list:");
  assert(!yaml.includes("link"));
});

Deno.test("maxNodes limits total nodes", () => {
  const nodes: AccessibilityNode[] = [
    ax({
      nodeId: "1",
      role: { type: "role", value: "RootWebArea" },
      childIds: ["2", "3", "4", "5", "6"],
    }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "One" },
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Two" },
    }),
    ax({
      nodeId: "4",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Three" },
    }),
    ax({
      nodeId: "5",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Four" },
    }),
    ax({
      nodeId: "6",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Five" },
    }),
  ];
  const yaml = snapshot(nodes, { maxNodes: 3 });
  const matches = yaml.match(/paragraph/g);
  assertEquals(matches?.length, 3);
});

// --- Root node selection ---

Deno.test("rootNodeId scopes transform to subtree", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2", "3"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Skip" },
    }),
    ax({ nodeId: "3", role: { type: "role", value: "main" }, childIds: ["4"] }),
    ax({
      nodeId: "4",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Include" },
    }),
  ];
  const result = transform(nodes, undefined, "3");
  const yaml = renderYaml(result.nodes);
  assert(!yaml.includes("Skip"));
  assertStringIncludes(yaml, `paragraph "Include"`);
});

// --- StaticText / InlineTextBox ---

Deno.test("StaticText becomes text pseudo-node", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({ nodeId: "2", role: { type: "role", value: "paragraph" }, childIds: ["3", "4"] }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "StaticText" },
      name: { type: "contents", value: "Hello " },
    }),
    ax({
      nodeId: "4",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "world" },
      backendDOMNodeId: 5,
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `text "Hello "`);
  assertStringIncludes(yaml, `link "world"`);
});

Deno.test("InlineTextBox is skipped", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "StaticText" },
      name: { type: "contents", value: "Hello" },
      childIds: ["3"],
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "InlineTextBox" },
      name: { type: "contents", value: "Hello" },
    }),
  ];
  // StaticText with InlineTextBox child — the InlineTextBox should be ignored
  const result = transform(nodes);
  assertEquals(result.nodes.length, 1);
  assertEquals(result.nodes[0].role, "text");
  assertEquals(result.nodes[0].name, "Hello");
});

// --- Explicit roles ---

Deno.test("explicit alert role preserved", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "alert" },
      name: { type: "contents", value: "Warning!" },
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `alert "Warning!"`);
});

Deno.test("region with name", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "region" },
      name: { type: "attribute", value: "Sidebar" },
      childIds: ["3"],
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Hello" },
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `region "Sidebar":`);
});

Deno.test("form with name", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "form" },
      name: { type: "attribute", value: "Login" },
      childIds: ["3"],
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "textbox" },
      backendDOMNodeId: 15,
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `form "Login":`);
});

// --- Rowgroup ---

Deno.test("rowgroup roles preserved", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({ nodeId: "2", role: { type: "role", value: "table" }, childIds: ["3", "4", "5"] }),
    ax({ nodeId: "3", role: { type: "role", value: "rowgroup" }, childIds: ["6"] }),
    ax({ nodeId: "6", role: { type: "role", value: "row" }, childIds: ["9"] }),
    ax({
      nodeId: "9",
      role: { type: "role", value: "columnheader" },
      name: { type: "contents", value: "Header" },
    }),
    ax({ nodeId: "4", role: { type: "role", value: "rowgroup" }, childIds: ["7"] }),
    ax({ nodeId: "7", role: { type: "role", value: "row" }, childIds: ["10"] }),
    ax({
      nodeId: "10",
      role: { type: "role", value: "cell" },
      name: { type: "contents", value: "Body" },
    }),
    ax({ nodeId: "5", role: { type: "role", value: "rowgroup" }, childIds: ["8"] }),
    ax({ nodeId: "8", role: { type: "role", value: "row" }, childIds: ["11"] }),
    ax({
      nodeId: "11",
      role: { type: "role", value: "cell" },
      name: { type: "contents", value: "Footer" },
    }),
  ];
  const yaml = snapshot(nodes);
  assertEquals(yaml.match(/rowgroup:/g)?.length, 3);
});

// --- Empty tree ---

Deno.test("empty AccessibilityNode array produces empty result", () => {
  const result = transform([]);
  assertEquals(result.nodes, []);
  assertEquals(result.refs, {});
});

// --- Cell with link child ---

Deno.test("cell with link child preserves link", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({ nodeId: "2", role: { type: "role", value: "table" }, childIds: ["3"] }),
    ax({ nodeId: "3", role: { type: "role", value: "row" }, childIds: ["4"] }),
    ax({
      nodeId: "4",
      role: { type: "role", value: "cell" },
      name: { type: "contents", value: "Title" },
      childIds: ["5"],
    }),
    ax({
      nodeId: "5",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "Title" },
      backendDOMNodeId: 50,
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, "cell:");
  assertStringIncludes(yaml, `link "Title"`);
});

// --- Article / complementary ---

Deno.test("article role preserved", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "article" },
      childIds: ["3"],
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Content" },
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, "article:");
});

Deno.test("complementary role preserved", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "complementary" },
      childIds: ["3"],
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Sidebar" },
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, "complementary:");
});

// --- Ignored nodes with visible children ---

Deno.test("ignored node's children still processed", () => {
  const nodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      ignored: true,
      role: { type: "role", value: "generic" },
      childIds: ["3"],
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "Visible" },
      backendDOMNodeId: 5,
    }),
  ];
  const yaml = snapshot(nodes);
  assertStringIncludes(yaml, `link "Visible"`);
});
