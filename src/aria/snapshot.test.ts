import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createSnapshotService } from "./snapshot.ts";

function mockEvaluate(html: string) {
  return (_expression: string): Promise<unknown> => Promise.resolve(html);
}

Deno.test("snapshot returns YAML from HTML", async () => {
  const svc = createSnapshotService();
  const result = await svc.snapshot(
    {},
    mockEvaluate('<nav><a href="/home">Home</a></nav>'),
  );
  assertStringIncludes(result.yaml, "navigation:");
  assertStringIncludes(result.yaml, `link "Home"`);
});

Deno.test("snapshot returns empty YAML for empty HTML", async () => {
  const svc = createSnapshotService();
  const result = await svc.snapshot({}, mockEvaluate(""));
  assertEquals(result.yaml, "");
});

Deno.test("snapshot passes selector to evaluateInPage", async () => {
  const svc = createSnapshotService();
  let captured = "";
  const result = await svc.snapshot(
    { selector: "#main" },
    (expression: string) => {
      captured = expression;
      return Promise.resolve("<main><h1>Hello</h1></main>");
    },
  );
  assertStringIncludes(captured, "#main");
  assertStringIncludes(result.yaml, `heading "Hello"`);
});

Deno.test("snapshot defaults to body selector", async () => {
  const svc = createSnapshotService();
  let captured = "";
  await svc.snapshot(
    {},
    (expression: string) => {
      captured = expression;
      return Promise.resolve("<p>text</p>");
    },
  );
  assertStringIncludes(captured, "body");
});

Deno.test("snapshot respects maxDepth", async () => {
  const svc = createSnapshotService();
  const html = '<nav><ul><li><a href="/">Deep</a></li></ul></nav>';
  const result = await svc.snapshot(
    { maxDepth: 1 },
    mockEvaluate(html),
  );
  // At maxDepth=1, the link should still get its text as name
  // but nested structure should be limited
  assertStringIncludes(result.yaml, "navigation");
});

Deno.test("snapshot respects maxNodes", async () => {
  const svc = createSnapshotService();
  const html = '<nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav>';
  const result = await svc.snapshot(
    { maxNodes: 2 },
    mockEvaluate(html),
  );
  const lines = result.yaml.split("\n").filter((l: string) => l.trim().startsWith("- "));
  assert(lines.length > 0, "expected some output");
  assert(lines.length <= 2, "expected at most 2 nodes");
});
