import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type AXNode } from "./tree.ts";
import { createSnapshotService, type SnapshotDeps } from "./snapshot.ts";

function ax(overrides: Partial<AXNode> & { nodeId: string }): AXNode {
  return { ignored: false, ...overrides };
}

function mockDeps(axNodes: AXNode[], overrides?: Partial<SnapshotDeps>): SnapshotDeps {
  return {
    getFullAXTree: () => Promise.resolve(axNodes),
    resolveSelector: () => Promise.reject(new Error("resolveSelector not mocked")),
    ...overrides,
  };
}

Deno.test("snapshot returns YAML from AXNodes", async () => {
  const axNodes: AXNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "navigation" },
      childIds: ["3"],
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "Home" },
      backendDOMNodeId: 5,
    }),
  ];
  const svc = createSnapshotService(mockDeps(axNodes));
  const result = await svc.snapshot({});
  assertStringIncludes(result.yaml, "navigation:");
  assertStringIncludes(result.yaml, `link "Home"`);
});

Deno.test("snapshot returns refs", async () => {
  const axNodes: AXNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "button" },
      name: { type: "contents", value: "Click" },
      backendDOMNodeId: 42,
    }),
  ];
  const svc = createSnapshotService(mockDeps(axNodes));
  const result = await svc.snapshot({});
  assertEquals(result.refs, { e1: 42 });
});

Deno.test("snapshot returns empty YAML for empty tree", async () => {
  const axNodes: AXNode[] = [
    ax({ nodeId: "1", ignored: true, role: { type: "role", value: "RootWebArea" } }),
  ];
  const svc = createSnapshotService(mockDeps(axNodes));
  const result = await svc.snapshot({});
  assertEquals(result.yaml, "");
  assertEquals(result.refs, {});
});

Deno.test("snapshot uses selector to scope subtree", async () => {
  const axNodes: AXNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2", "3"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Skip" },
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "main" },
      backendDOMNodeId: 99,
      childIds: ["4"],
    }),
    ax({
      nodeId: "4",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Include" },
    }),
  ];
  const svc = createSnapshotService(mockDeps(axNodes, {
    resolveSelector: (selector: string) => {
      assertEquals(selector, "#main");
      return Promise.resolve(99); // backendDOMNodeId of the main element
    },
  }));
  const result = await svc.snapshot({ selector: "#main" });
  assert(!result.yaml.includes("Skip"));
  assertStringIncludes(result.yaml, `paragraph "Include"`);
});

Deno.test("snapshot respects maxDepth", async () => {
  const axNodes: AXNode[] = [
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
  const svc = createSnapshotService(mockDeps(axNodes));
  const result = await svc.snapshot({ maxDepth: 2 });
  assertStringIncludes(result.yaml, "navigation");
  assert(!result.yaml.includes("link"));
});

Deno.test("snapshot respects maxNodes", async () => {
  const axNodes: AXNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2", "3", "4"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "A" },
      backendDOMNodeId: 1,
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "B" },
      backendDOMNodeId: 2,
    }),
    ax({
      nodeId: "4",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "C" },
      backendDOMNodeId: 3,
    }),
  ];
  const svc = createSnapshotService(mockDeps(axNodes));
  const result = await svc.snapshot({ maxNodes: 2 });
  const lines = result.yaml.split("\n").filter((l: string) => l.trim().startsWith("- "));
  assert(lines.length > 0, "expected some output");
  assert(lines.length <= 2, "expected at most 2 nodes");
});

Deno.test("snapshot returns empty for unmatched selector", async () => {
  const axNodes: AXNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "paragraph" },
      name: { type: "contents", value: "Hello" },
    }),
  ];
  const svc = createSnapshotService(mockDeps(axNodes, {
    resolveSelector: () => Promise.resolve(999), // backendDOMNodeId that doesn't exist
  }));
  const result = await svc.snapshot({ selector: "#nope" });
  assertEquals(result.yaml, "");
  assertEquals(result.refs, {});
});
