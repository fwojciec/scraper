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

Deno.test("scanRefs: ignores $ref inside a double-quoted string literal", () => {
  assertEquals(scanRefs(`const s = "$ref(\\"e3\\")"`), []);
});

Deno.test("scanRefs: ignores $ref inside a single-quoted string literal", () => {
  assertEquals(scanRefs(`const s = 'not $ref("e3") here'`), []);
});

Deno.test("scanRefs: ignores $ref inside a template literal", () => {
  assertEquals(scanRefs('const s = `$ref("e3")`'), []);
});

Deno.test("scanRefs: extracts $ref from a template literal interpolation", () => {
  assertEquals(scanRefs('`${$ref("e3").textContent}`'), ["e3"]);
});

Deno.test("scanRefs: extracts multiple $refs from separate template interpolations", () => {
  assertEquals(
    scanRefs('`${$ref("e3").href} - ${$ref("e5").textContent}`'),
    ["e3", "e5"],
  );
});

Deno.test("scanRefs: template literal surrounding text stays string, only ${} is code", () => {
  // `$ref("e7")` in the bare template text is a string; `$ref("e3")` inside
  // ${...} is live code. Only e3 should survive.
  assertEquals(
    scanRefs('`prefix $ref("e7") ${$ref("e3").value} suffix`'),
    ["e3"],
  );
});

Deno.test("scanRefs: still matches $ref in code after a closed string", () => {
  assertEquals(scanRefs(`"x"; $ref("e3").click()`), ["e3"]);
});

Deno.test("scanRefs: regex literal containing // does not swallow following $ref", () => {
  // The URL-matching regex `/^https?:\/\//` contains a literal `//` that a
  // naive comment-skipper would treat as a line comment, consuming the rest
  // of the expression (including the $ref) and causing `$ref is not defined`
  // at runtime. The scanner must leave regex bodies alone.
  assertEquals(
    scanRefs(`/^https?:\\/\\//.test(location.href) ? $ref("e1") : null`),
    ["e1"],
  );
});

Deno.test("scanRefs: regex literal containing /* does not swallow following $ref", () => {
  // `/\/\*/` exists as a regex matching a literal `/*` — the scanner must not
  // mistake that substring for the start of a block comment.
  assertEquals(
    scanRefs(`/\\/\\*/.test(s); $ref("e4").click()`),
    ["e4"],
  );
});

Deno.test("scanRefs: handles escaped quotes inside strings", () => {
  // Escaped closing quote must not terminate the string prematurely,
  // so the $ref literal inside remains string content.
  assertEquals(scanRefs(`"prefix \\" $ref(\\"e3\\") suffix"`), []);
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
