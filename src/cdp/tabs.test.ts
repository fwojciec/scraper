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

Deno.test("canonicalizeTargetId: fetches /json/list and returns canonical id", async () => {
  const fetches: string[] = [];
  const fetcher = (url: string) => {
    fetches.push(url);
    return Promise.resolve(
      new Response(JSON.stringify(tabs), { status: 200 }),
    );
  };
  const got = await canonicalizeTargetId("4AE7B2C9", 9222, fetcher);
  assertEquals(got, "4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2");
  assertEquals(fetches, ["http://127.0.0.1:9222/json/list"]);
});

Deno.test("canonicalizeTargetId: propagates non-OK http response", async () => {
  const fetcher = () => Promise.resolve(new Response("boom", { status: 500 }));
  await assertRejects(
    () => canonicalizeTargetId("abc", 9222, fetcher),
    Error,
    "Chrome /json/list returned 500",
  );
});

Deno.test("canonicalizeTargetId: empty input short-circuits before any Chrome I/O", async () => {
  let fetched = false;
  const fetcher = () => {
    fetched = true;
    return Promise.reject(new Error("fetch should not run — empty input must short-circuit"));
  };
  await assertRejects(
    () => canonicalizeTargetId("", 9222, fetcher),
    Error,
    "--tab <targetId> is required. Run `scraper tabs` to list tabs, or `scraper navigate --new <url>` to open a new one.",
  );
  assertEquals(fetched, false);
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
