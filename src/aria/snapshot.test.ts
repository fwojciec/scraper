import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import { type AccessibilityNode } from "./tree.ts";
import { createSnapshotService, type SnapshotDeps } from "./snapshot.ts";
import type { SnapshotRequest } from "../domain/snapshot.ts";

const FULL_TAB = "4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2";

function ax(overrides: Partial<AccessibilityNode> & { nodeId: string }): AccessibilityNode {
  return { ignored: false, ...overrides };
}

function mockDeps(axNodes: AccessibilityNode[], overrides?: Partial<SnapshotDeps>): SnapshotDeps {
  return {
    getFullAXTree: () => Promise.resolve(axNodes),
    resolveSelector: () => Promise.reject(new Error("resolveSelector not mocked")),
    ...overrides,
  };
}

function req(overrides: Partial<SnapshotRequest> = {}): SnapshotRequest {
  return {
    snapshotId: "s1",
    targetId: FULL_TAB,
    url: "https://example.com/",
    title: "Example",
    dialog: null,
    ...overrides,
  };
}

Deno.test("snapshot returns YAML from AccessibilityNodes", async () => {
  const axNodes: AccessibilityNode[] = [
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
  const result = await svc.snapshot(req());
  assertStringIncludes(result.yaml, "navigation:");
  assertStringIncludes(result.yaml, `link "Home"`);
});

Deno.test("snapshot returns refs", async () => {
  const axNodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "button" },
      name: { type: "contents", value: "Click" },
      backendDOMNodeId: 42,
    }),
  ];
  const svc = createSnapshotService(mockDeps(axNodes));
  const result = await svc.snapshot(req());
  assertEquals(result.refs, { e1: 42 });
});

Deno.test("snapshot: empty tree renders header plus `tree: []`", async () => {
  const axNodes: AccessibilityNode[] = [
    ax({ nodeId: "1", ignored: true, role: { type: "role", value: "RootWebArea" } }),
  ];
  const svc = createSnapshotService(mockDeps(axNodes));
  const result = await svc.snapshot(req({ snapshotId: "s7" }));
  assertEquals(result.refs, {});
  assertEquals(result.lastRefCounter, 0);
  assertStringIncludes(result.yaml, "snapshot: s7");
  assertStringIncludes(result.yaml, "tree: []");
});

Deno.test("snapshot: starts ref minting at startingRefCounter + 1", async () => {
  const axNodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2", "3"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "link" },
      name: { type: "contents", value: "A" },
      backendDOMNodeId: 10,
    }),
    ax({
      nodeId: "3",
      role: { type: "role", value: "button" },
      name: { type: "contents", value: "B" },
      backendDOMNodeId: 20,
    }),
  ];
  const svc = createSnapshotService(mockDeps(axNodes));
  const result = await svc.snapshot(req({ startingRefCounter: 14 }));
  assertEquals(result.refs, { e15: 10, e16: 20 });
  assertEquals(result.lastRefCounter, 16);
  assertStringIncludes(result.yaml, "[ref=e15]");
  assertStringIncludes(result.yaml, "[ref=e16]");
});

Deno.test("snapshot: lastRefCounter equals startingRefCounter when nothing is minted", async () => {
  const svc = createSnapshotService(mockDeps([], {
    resolveSelector: () => Promise.resolve(999),
  }));
  const result = await svc.snapshot(req({ selector: "#nope", startingRefCounter: 42 }));
  assertEquals(result.lastRefCounter, 42);
  assertEquals(result.refs, {});
});

Deno.test("snapshot uses selector to scope subtree", async () => {
  const axNodes: AccessibilityNode[] = [
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
  const result = await svc.snapshot(req({ selector: "#main" }));
  assert(!result.yaml.includes("Skip"));
  assertStringIncludes(result.yaml, `paragraph "Include"`);
});

Deno.test("snapshot respects maxDepth", async () => {
  const axNodes: AccessibilityNode[] = [
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
  const result = await svc.snapshot(req({ maxDepth: 2 }));
  assertStringIncludes(result.yaml, "navigation");
  assert(!result.yaml.includes("link"));
});

Deno.test("snapshot respects maxNodes", async () => {
  const axNodes: AccessibilityNode[] = [
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
  const result = await svc.snapshot(req({ maxNodes: 2 }));
  const lines = result.yaml.split("\n").filter((l: string) => l.trim().startsWith("- "));
  assert(lines.length > 0, "expected some output");
  assert(lines.length <= 2, "expected at most 2 nodes");
});

Deno.test("snapshot returns empty tree for unmatched selector", async () => {
  const axNodes: AccessibilityNode[] = [
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
  const result = await svc.snapshot(req({ selector: "#nope" }));
  assertStringIncludes(result.yaml, "tree: []");
  assertEquals(result.refs, {});
});

// --- Header rendering ---

Deno.test("snapshot YAML has all six header fields and parses", async () => {
  const axNodes: AccessibilityNode[] = [
    ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] }),
    ax({
      nodeId: "2",
      role: { type: "role", value: "button" },
      name: { type: "contents", value: "Click" },
      backendDOMNodeId: 42,
    }),
  ];
  const svc = createSnapshotService(mockDeps(axNodes));
  const result = await svc.snapshot(req({
    snapshotId: "s47",
    targetId: FULL_TAB,
    url: "https://memberforms.uhc.com/DirectMedicalReimbursement.html",
    title: "Direct Medical Reimbursement",
    dialog: null,
  }));

  const parsed = parseYaml(result.yaml) as Record<string, unknown>;
  assertEquals(parsed.snapshot, "s47");
  assertEquals(parsed.targetId, FULL_TAB);
  assertEquals(parsed.url, "https://memberforms.uhc.com/DirectMedicalReimbursement.html");
  assertEquals(parsed.title, "Direct Medical Reimbursement");
  assertEquals(parsed.dialog, null);
  assert(Array.isArray(parsed.tree), "tree should be a sequence");
});

Deno.test("snapshot YAML quotes url and title with special characters", async () => {
  const svc = createSnapshotService(mockDeps([]));
  const result = await svc.snapshot(req({
    url: 'https://x.com/?q="hi"',
    title: 'Report: "Q3"',
  }));
  const parsed = parseYaml(result.yaml) as Record<string, unknown>;
  assertEquals(parsed.url, 'https://x.com/?q="hi"');
  assertEquals(parsed.title, 'Report: "Q3"');
});

Deno.test("snapshot YAML surfaces dialog object when provided", async () => {
  const svc = createSnapshotService(mockDeps([]));
  const result = await svc.snapshot(req({
    dialog: { type: "alert", message: "Unsaved changes — leave?", handled: "dismiss" },
  }));
  const parsed = parseYaml(result.yaml) as Record<string, unknown>;
  assertEquals(parsed.dialog, {
    type: "alert",
    message: "Unsaved changes — leave?",
    handled: "dismiss",
  });
});

Deno.test("snapshot YAML records `accept` when scraper accepted the dialog", async () => {
  const svc = createSnapshotService(mockDeps([]));
  const result = await svc.snapshot(req({
    dialog: { type: "prompt", message: "Your name?", handled: "accept" },
  }));
  const parsed = parseYaml(result.yaml) as Record<string, unknown>;
  assertEquals(parsed.dialog, { type: "prompt", message: "Your name?", handled: "accept" });
});

Deno.test("snapshot YAML escapes special characters in the dialog message", async () => {
  const svc = createSnapshotService(mockDeps([]));
  const result = await svc.snapshot(req({
    dialog: { type: "confirm", message: 'He said "no" — really.', handled: "dismiss" },
  }));
  const parsed = parseYaml(result.yaml) as Record<string, unknown>;
  assertEquals(parsed.dialog, {
    type: "confirm",
    message: 'He said "no" — really.',
    handled: "dismiss",
  });
});

Deno.test("snapshot YAML renders targetId as canonical 32-hex string", async () => {
  const svc = createSnapshotService(mockDeps([]));
  const result = await svc.snapshot(req({ targetId: FULL_TAB }));
  // Must not be an abbreviated prefix; the full id should appear verbatim.
  assertStringIncludes(result.yaml, `targetId: ${FULL_TAB}`);
  assertEquals(FULL_TAB.length, 32);
});

Deno.test("snapshot result echoes snapshotId, title, and url for pointer formatting", async () => {
  const svc = createSnapshotService(mockDeps([]));
  const result = await svc.snapshot(req({
    snapshotId: "s47",
    title: "Direct Medical Reimbursement",
    url: "https://memberforms.uhc.com/DirectMedicalReimbursement.html",
  }));
  assertEquals(result.snapshotId, "s47");
  assertEquals(result.title, "Direct Medical Reimbursement");
  assertEquals(result.url, "https://memberforms.uhc.com/DirectMedicalReimbursement.html");
});
