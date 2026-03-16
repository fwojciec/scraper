import { assertEquals } from "@std/assert";
import { translateAXNodes } from "./accessibility.ts";
import type { AccessibilityNode } from "../domain/accessibility.ts";

Deno.test("translates minimal CDP node to domain node", () => {
  const raw = [{ nodeId: "1", ignored: false }];
  const result = translateAXNodes(raw);
  assertEquals(result, [{ nodeId: "1", ignored: false }]);
});

Deno.test("omits ignored when absent from raw CDP node", () => {
  const raw = [{ nodeId: "1" }];
  const result = translateAXNodes(raw);
  assertEquals(result, [{ nodeId: "1" }]);
  assertEquals("ignored" in result[0], false);
});

Deno.test("translates role and name AXValues", () => {
  const raw = [
    {
      nodeId: "2",
      ignored: false,
      role: { type: "role", value: "button" },
      name: { type: "contents", value: "Submit" },
    },
  ];
  const result = translateAXNodes(raw);
  assertEquals(result[0].role, { type: "role", value: "button" });
  assertEquals(result[0].name, { type: "contents", value: "Submit" });
});

Deno.test("strips extra CDP fields from AXValue (relatedNodes, sources)", () => {
  const raw = [
    {
      nodeId: "3",
      ignored: false,
      role: {
        type: "role",
        value: "link",
        relatedNodes: [{ backendDOMNodeId: 5, idref: "x", text: "y" }],
        sources: [{ type: "attribute", attribute: "role" }],
      },
      name: {
        type: "contents",
        value: "Home",
        sources: [{ type: "contents" }],
      },
    },
  ];
  const result = translateAXNodes(raw);
  assertEquals(result[0].role, { type: "role", value: "link" });
  assertEquals(result[0].name, { type: "contents", value: "Home" });
});

Deno.test("translates properties array, stripping extra AXValue fields", () => {
  const raw = [
    {
      nodeId: "4",
      ignored: false,
      properties: [
        {
          name: "level",
          value: {
            type: "integer",
            value: 2,
            sources: [{ type: "attribute" }],
          },
        },
        {
          name: "checked",
          value: { type: "tristate", value: "true" },
        },
      ],
    },
  ];
  const result = translateAXNodes(raw);
  assertEquals(result[0].properties, [
    { name: "level", value: { type: "integer", value: 2 } },
    { name: "checked", value: { type: "tristate", value: "true" } },
  ]);
});

Deno.test("passes through childIds, parentId, backendDOMNodeId", () => {
  const raw = [
    {
      nodeId: "5",
      ignored: false,
      childIds: ["6", "7"],
      parentId: "1",
      backendDOMNodeId: 42,
    },
  ];
  const result = translateAXNodes(raw);
  assertEquals(result[0].childIds, ["6", "7"]);
  assertEquals(result[0].parentId, "1");
  assertEquals(result[0].backendDOMNodeId, 42);
});

Deno.test("drops CDP-only fields (description, value, ignoredReasons, frameId, chromeRole)", () => {
  const raw = [
    {
      nodeId: "6",
      ignored: true,
      ignoredReasons: [{ name: "notVisible", value: { type: "boolean", value: true } }],
      description: { type: "attribute", value: "desc text" },
      value: { type: "string", value: "some value" },
      frameId: "F1",
      chromeRole: { type: "internalRole", value: 42 },
    },
  ];
  const result = translateAXNodes(raw);
  assertEquals(result, [{ nodeId: "6", ignored: true }] satisfies AccessibilityNode[]);
  // Ensure no extra keys leaked through
  assertEquals(Object.keys(result[0]).sort(), ["ignored", "nodeId"]);
});

Deno.test("translates multiple nodes", () => {
  const raw = [
    {
      nodeId: "1",
      ignored: false,
      role: { type: "role", value: "RootWebArea" },
      childIds: ["2"],
    },
    {
      nodeId: "2",
      ignored: false,
      role: { type: "role", value: "button" },
      name: { type: "contents", value: "OK" },
      backendDOMNodeId: 10,
    },
  ];
  const result = translateAXNodes(raw);
  assertEquals(result.length, 2);
  assertEquals(result[0].nodeId, "1");
  assertEquals(result[1].nodeId, "2");
  assertEquals(result[1].backendDOMNodeId, 10);
});

Deno.test("empty array returns empty", () => {
  assertEquals(translateAXNodes([]), []);
});

Deno.test("omits undefined optional fields instead of setting them", () => {
  const raw = [{ nodeId: "7", ignored: false }];
  const result = translateAXNodes(raw);
  assertEquals("role" in result[0], false);
  assertEquals("name" in result[0], false);
  assertEquals("properties" in result[0], false);
  assertEquals("childIds" in result[0], false);
  assertEquals("backendDOMNodeId" in result[0], false);
  assertEquals("parentId" in result[0], false);
});
