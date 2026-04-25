import { assertEquals, assertRejects } from "@std/assert";
import { canonicalizeTargetId, type HttpTab, matchTabByPrefix } from "./tabs.ts";

const tabs: HttpTab[] = [
  { id: "4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2", type: "page", url: "https://a", title: "A" },
  { id: "4AE7AAAA11112222333344445555BBBB", type: "page", url: "https://b", title: "B" },
  { id: "9F00000011112222333344445555CCCC", type: "page", url: "https://c", title: "C" },
  { id: "1111111111111111111111111111AAAA", type: "service_worker", url: "", title: "" },
];

Deno.test("matchTabByPrefix: full targetId matches itself", () => {
  const got = matchTabByPrefix("9F00000011112222333344445555CCCC", tabs);
  assertEquals(got, "9F00000011112222333344445555CCCC");
});

Deno.test("matchTabByPrefix: unique prefix resolves to canonical full id", () => {
  const got = matchTabByPrefix("9F0", tabs);
  assertEquals(got, "9F00000011112222333344445555CCCC");
});

Deno.test("matchTabByPrefix: ambiguous prefix throws with match count", () => {
  const err = assertThrowsSync(() => matchTabByPrefix("4AE7", tabs));
  assertEquals(
    err.message,
    "ambiguous prefix `4AE7`, matches 2 tabs; provide more characters (full IDs are printed by `scraper tabs`).",
  );
});

Deno.test("matchTabByPrefix: no match throws", () => {
  const err = assertThrowsSync(() => matchTabByPrefix("ZZZZ", tabs));
  assertEquals(
    err.message,
    "no tab with prefix `ZZZZ`; run `scraper tabs` to see available tabs.",
  );
});

Deno.test("matchTabByPrefix: skips non-page targets", () => {
  // 1111... is a service_worker — should not match as a page tab
  const err = assertThrowsSync(() => matchTabByPrefix("1111", tabs));
  assertEquals(
    err.message,
    "no tab with prefix `1111`; run `scraper tabs` to see available tabs.",
  );
});

Deno.test("matchTabByPrefix: empty input throws missing-flag error", () => {
  const err = assertThrowsSync(() => matchTabByPrefix("", tabs));
  assertEquals(
    err.message,
    "--tab <targetId> is required. Run `scraper tabs` to list tabs, or `scraper navigate --new <url>` to open a new one.",
  );
});

Deno.test("canonicalizeTargetId: enumerates targets via lister and returns canonical id", async () => {
  const calls: string[] = [];
  const lister = (wsUrl: string) => {
    calls.push(wsUrl);
    return Promise.resolve(tabs);
  };
  const got = await canonicalizeTargetId(
    "4AE7B2C9",
    "ws://127.0.0.1:9222/devtools/browser/abc",
    lister,
  );
  assertEquals(got, "4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2");
  assertEquals(calls, ["ws://127.0.0.1:9222/devtools/browser/abc"]);
});

Deno.test("canonicalizeTargetId: propagates lister errors", async () => {
  const lister = () => Promise.reject(new Error("boom"));
  await assertRejects(
    () => canonicalizeTargetId("abc", "ws://127.0.0.1:9222/devtools/browser/abc", lister),
    Error,
    "boom",
  );
});

Deno.test("canonicalizeTargetId: empty input short-circuits before any Chrome I/O", async () => {
  let called = false;
  const lister = () => {
    called = true;
    return Promise.reject(new Error("lister should not run — empty input must short-circuit"));
  };
  await assertRejects(
    () => canonicalizeTargetId("", "ws://127.0.0.1:9222/devtools/browser/abc", lister),
    Error,
    "--tab <targetId> is required. Run `scraper tabs` to list tabs, or `scraper navigate --new <url>` to open a new one.",
  );
  assertEquals(called, false);
});

// Small sync throw helper (assertThrows exists in @std/assert but returns void).
function assertThrowsSync(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error) return e;
    throw new Error(`expected Error, got ${typeof e}: ${e}`);
  }
  throw new Error("expected fn to throw");
}
