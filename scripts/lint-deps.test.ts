import { assertEquals } from "@std/assert";
import plugin from "./lint-deps-plugin.ts";

Deno.test("clean: domain importing std passes", () => {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "src/domain/types.ts",
    `import { assertEquals } from "@std/assert";`,
  );
  assertEquals(diagnostics.length, 0);
});

Deno.test("clean: adapter importing domain passes", () => {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "src/aria/parser.ts",
    `import { type Page } from "../domain/mod.ts";`,
  );
  assertEquals(diagnostics.length, 0);
});

Deno.test("violation: cross-adapter import caught", () => {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "src/aria/parser.ts",
    `import { connect } from "../cdp/mod.ts";`,
  );
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].message, "aria/ cannot import from cdp/ (allowed: [domain])");
});

Deno.test("violation: domain importing adapter caught", () => {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "src/domain/types.ts",
    `import { connect } from "../cdp/mod.ts";`,
  );
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].message, "domain/ cannot import from cdp/ (allowed: [])");
});

Deno.test("exemption: main.ts can import anything", () => {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "src/main.ts",
    `import { connect } from "./cdp/mod.ts";\nimport { parse } from "./aria/mod.ts";`,
  );
  assertEquals(diagnostics.length, 0);
});

Deno.test("violation: nested relative import caught", () => {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "src/cli/handler.ts",
    `import { connect } from "../cdp/mod.ts";`,
  );
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].message, "cli/ cannot import from cdp/ (allowed: [domain])");
});

Deno.test("violation: re-export caught (export * from)", () => {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "src/aria/index.ts",
    `export * from "../cdp/mod.ts";`,
  );
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].message, "aria/ cannot import from cdp/ (allowed: [domain])");
});

Deno.test("violation: re-export caught (export named from)", () => {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "src/aria/index.ts",
    `export { connect } from "../cdp/mod.ts";`,
  );
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].message, "aria/ cannot import from cdp/ (allowed: [domain])");
});

Deno.test("violation: stray src/ file cannot import modules", () => {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "src/worker.ts",
    `import { connect } from "./cdp/mod.ts";`,
  );
  assertEquals(diagnostics.length, 1);
  assertEquals(
    diagnostics[0].message,
    "stray src/ file cannot import from cdp/ (only main.ts may import modules)",
  );
});

Deno.test("violation: unknown src/ namespace cannot import modules", () => {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "src/shared/utils.ts",
    `import { connect } from "../cdp/mod.ts";`,
  );
  assertEquals(diagnostics.length, 1);
  assertEquals(
    diagnostics[0].message,
    "stray src/ file cannot import from cdp/ (only main.ts may import modules)",
  );
});

Deno.test("violation: dynamic import caught", () => {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "src/aria/lazy.ts",
    `const mod = await import("../cdp/mod.ts");`,
  );
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].message, "aria/ cannot import from cdp/ (allowed: [domain])");
});

Deno.test("violation: dynamic import with template literal caught", () => {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "src/aria/lazy.ts",
    "const mod = await import(`../cdp/mod.ts`);",
  );
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].message, "aria/ cannot import from cdp/ (allowed: [domain])");
});

Deno.test("violation: file:// URL import caught", () => {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "src/aria/parser.ts",
    `import "file:///Users/filip/code/deno/scraper/src/cdp/mod.ts";`,
  );
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].message, "aria/ cannot import from cdp/ (allowed: [domain])");
});
