import { assertEquals, assertRejects } from "@std/assert";
import { resolveTarget } from "./resolve.ts";
import type { CdpPageService } from "./connection.ts";

function stubPage(overrides: Partial<CdpPageService> = {}): CdpPageService {
  return {
    navigate: () => Promise.resolve(),
    evaluate: () => Promise.resolve({ result: null }),
    screenshot: () => Promise.resolve(""),
    getFullAXTree: () => Promise.resolve([]),
    resolveSelector: () => Promise.resolve(0),
    resolveRef: () => Promise.resolve("obj-1"),
    resolveUniqueSelector: () => Promise.resolve("obj-1"),
    clickElement: () => Promise.resolve(),
    fillElement: () => Promise.resolve(),
    typeText: () => Promise.resolve(),
    selectOption: () => Promise.resolve(),
    submitForm: () => Promise.resolve(),
    focusElement: () => Promise.resolve(),
    pressKey: () => Promise.resolve(),
    uploadFile: () => Promise.resolve(),
    onDialog: () => () => {},
    handleDialog: () => Promise.resolve(),
    waitForNetworkIdle: () => Promise.resolve(),
    waitForSelector: () => Promise.resolve(),
    waitForText: () => Promise.resolve(),
    waitForTextInElement: () => Promise.resolve(),
    close: () => {},
    ...overrides,
  };
}

Deno.test("resolveTarget: ref found in map calls resolveRef", async () => {
  let receivedBackendNodeId: number | undefined;
  let receivedRefName: string | undefined;
  const page = stubPage({
    resolveRef: (id, name) => {
      receivedBackendNodeId = id;
      receivedRefName = name;
      return Promise.resolve("obj-42");
    },
  });

  const objectId = await resolveTarget({ ref: "e5" }, page, { e5: 256 });
  assertEquals(objectId, "obj-42");
  assertEquals(receivedBackendNodeId, 256);
  assertEquals(receivedRefName, "e5");
});

Deno.test("resolveTarget: ref not in map throws unknown ref", async () => {
  const page = stubPage();

  await assertRejects(
    () => resolveTarget({ ref: "e99" }, page, { e1: 42 }),
    Error,
    "unknown ref e99",
  );
});

Deno.test("resolveTarget: ref with null refs throws no refs available", async () => {
  const page = stubPage();

  await assertRejects(
    () => resolveTarget({ ref: "e5" }, page, null),
    Error,
    "no refs available",
  );
});

Deno.test("resolveTarget: ref with stale backendNodeId propagates error", async () => {
  const page = stubPage({
    resolveRef: () => Promise.reject(new Error("ref e5 is stale")),
  });

  await assertRejects(
    () => resolveTarget({ ref: "e5" }, page, { e5: 256 }),
    Error,
    "ref e5 is stale",
  );
});

Deno.test("resolveTarget: selector calls resolveUniqueSelector", async () => {
  let receivedSelector: string | undefined;
  const page = stubPage({
    resolveUniqueSelector: (sel) => {
      receivedSelector = sel;
      return Promise.resolve("obj-99");
    },
  });

  const objectId = await resolveTarget({ selector: "#btn" }, page, null);
  assertEquals(objectId, "obj-99");
  assertEquals(receivedSelector, "#btn");
});

Deno.test("resolveTarget: selector 0 matches propagates error", async () => {
  const page = stubPage({
    resolveUniqueSelector: () =>
      Promise.reject(new Error('selector "#btn" did not match any element')),
  });

  await assertRejects(
    () => resolveTarget({ selector: "#btn" }, page, null),
    Error,
    "did not match any element",
  );
});

Deno.test("resolveTarget: selector >1 matches propagates error", async () => {
  const page = stubPage({
    resolveUniqueSelector: () =>
      Promise.reject(new Error('selector "div" matched 5 elements, expected exactly 1')),
  });

  await assertRejects(
    () => resolveTarget({ selector: "div" }, page, null),
    Error,
    "matched 5 elements",
  );
});
