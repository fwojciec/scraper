import { assertEquals } from "@std/assert";
import { formatStaleRefError, scanRefs } from "./eval.ts";

Deno.test("scanRefs: returns empty array for expression with no $ref", () => {
  assertEquals(scanRefs("document.title"), []);
  assertEquals(scanRefs("1 + 1"), []);
  assertEquals(scanRefs(""), []);
});

Deno.test("scanRefs: extracts ref from a single $ref call with double quotes", () => {
  assertEquals(scanRefs(`$ref("e3").value`), ["e3"]);
});

Deno.test("scanRefs: extracts ref from a single $ref call with single quotes", () => {
  assertEquals(scanRefs(`$ref('e3').click()`), ["e3"]);
});

Deno.test("scanRefs: extracts multiple distinct refs in order of first appearance", () => {
  assertEquals(
    scanRefs(`$ref("e8").value = $ref("e3").textContent`),
    ["e8", "e3"],
  );
});

Deno.test("scanRefs: dedupes repeated refs", () => {
  assertEquals(
    scanRefs(`$ref("e3").value = "x"; $ref("e3").dispatchEvent(new Event("input"))`),
    ["e3"],
  );
});

Deno.test("scanRefs: tolerates whitespace around parens and quotes", () => {
  assertEquals(scanRefs(`$ref ( "e3" ) .click()`), ["e3"]);
});

Deno.test("scanRefs: ignores $reference or other names with $ref as a prefix", () => {
  assertEquals(scanRefs(`$reference("e3")`), []);
  assertEquals(scanRefs(`my$ref("e3")`), []);
});

Deno.test("scanRefs: ignores property access like obj.$ref('e3')", () => {
  assertEquals(scanRefs(`obj.$ref("e3")`), []);
  assertEquals(scanRefs(`window.$ref('e3')`), []);
});

Deno.test("formatStaleRefError: renders the exact design-doc shape with a ref range", () => {
  const msg = formatStaleRefError(
    "e3",
    "4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2",
    ["e15", "e16", "e22"],
  );
  assertEquals(
    msg,
    "ref e3 is stale — not in refs.4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2.json (current refs: e15..e22).\n" +
      "Run `scraper snapshot --tab 4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2` and retry with a fresh ref.",
  );
});

Deno.test("formatStaleRefError: reports `none` when the refs file has no entries", () => {
  const msg = formatStaleRefError("e3", "TID", []);
  assertEquals(
    msg,
    "ref e3 is stale — not in refs.TID.json (current refs: none).\n" +
      "Run `scraper snapshot --tab TID` and retry with a fresh ref.",
  );
});

Deno.test("formatStaleRefError: reports single ref without range syntax", () => {
  const msg = formatStaleRefError("e3", "TID", ["e5"]);
  assertEquals(
    msg,
    "ref e3 is stale — not in refs.TID.json (current refs: e5).\n" +
      "Run `scraper snapshot --tab TID` and retry with a fresh ref.",
  );
});
