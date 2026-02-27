import { assertEquals, assertStringIncludes } from "@std/assert";
import type { AriaNode } from "./tree.ts";
import { renderYaml } from "./render.ts";

Deno.test("render empty array produces empty string", () => {
  assertEquals(renderYaml([]), "");
});

Deno.test("render leaf node with name", () => {
  const yaml = renderYaml([{ role: "button", name: "Click" }]);
  assertStringIncludes(yaml, `- button "Click"`);
});

Deno.test("render leaf node without name", () => {
  const yaml = renderYaml([{ role: "textbox", ref: "e1" }]);
  assertStringIncludes(yaml, `- textbox [ref=e1]`);
});

Deno.test("render node with children", () => {
  const node: AriaNode = {
    role: "navigation",
    children: [
      { role: "link", name: "Home", ref: "e1" },
      { role: "link", name: "About", ref: "e2" },
    ],
  };
  const yaml = renderYaml([node]);
  assertStringIncludes(yaml, "- navigation:");
  assertStringIncludes(yaml, `    - link "Home" [ref=e1]`);
  assertStringIncludes(yaml, `    - link "About" [ref=e2]`);
});

Deno.test("render heading with level", () => {
  const yaml = renderYaml([{ role: "heading", name: "Title", level: 1 }]);
  assertStringIncludes(yaml, `- heading "Title" [level=1]`);
});

Deno.test("render node with name and children", () => {
  const node: AriaNode = {
    role: "region",
    name: "Sidebar",
    children: [{ role: "paragraph", name: "Content" }],
  };
  const yaml = renderYaml([node]);
  assertStringIncludes(yaml, `- region "Sidebar":`);
  assertStringIncludes(yaml, `    - paragraph "Content"`);
});

Deno.test("render deeply nested nodes", () => {
  const node: AriaNode = {
    role: "table",
    children: [{
      role: "row",
      children: [
        { role: "cell", name: "1" },
        { role: "cell", children: [{ role: "link", name: "Book", ref: "e1" }] },
      ],
    }],
  };
  const yaml = renderYaml([node]);
  assertStringIncludes(yaml, "- table:");
  assertStringIncludes(yaml, "    - row:");
  assertStringIncludes(yaml, `        - cell "1"`);
  assertStringIncludes(yaml, "        - cell:");
  assertStringIncludes(yaml, `            - link "Book" [ref=e1]`);
});

Deno.test("render multiple top-level nodes", () => {
  const yaml = renderYaml([
    { role: "banner", children: [{ role: "link", name: "Home", ref: "e1" }] },
    { role: "main", children: [{ role: "heading", name: "Hello", level: 1 }] },
  ]);
  assertStringIncludes(yaml, "- banner:");
  assertStringIncludes(yaml, "- main:");
});

Deno.test("render text pseudo-node", () => {
  const yaml = renderYaml([{ role: "text", name: "Hello world" }]);
  assertStringIncludes(yaml, `- text "Hello world"`);
});

Deno.test("render level and ref together", () => {
  const yaml = renderYaml([{ role: "heading", name: "Nav", level: 2, ref: "e1" }]);
  assertStringIncludes(yaml, `- heading "Nav" [level=2, ref=e1]`);
});
