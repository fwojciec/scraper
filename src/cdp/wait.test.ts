import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createWaitMethods, pollInterval } from "./wait.ts";

Deno.test("pollInterval: caps at 100ms for large timeouts", () => {
  assertEquals(pollInterval(5000), 100);
  assertEquals(pollInterval(10000), 100);
  assertEquals(pollInterval(500), 100);
});

Deno.test("pollInterval: scales down for short timeouts", () => {
  assertEquals(pollInterval(100), 20);
  assertEquals(pollInterval(50), 10);
  assertEquals(pollInterval(10), 2);
});

Deno.test("pollInterval: clamps to minimum of 1ms", () => {
  assertEquals(pollInterval(0), 1);
  assertEquals(pollInterval(1), 1);
  assertEquals(pollInterval(4), 1);
});

Deno.test("waitForSelector: throws on CDP exception with cleaned message", async () => {
  const cdp = {
    Runtime: {
      evaluate: () =>
        Promise.resolve({
          exceptionDetails: {
            exception: {
              description: 'Error: timed out waiting for selector "#foo" (100ms)',
            },
          },
        }),
    },
  };
  const waits = createWaitMethods(cdp, "session1");
  const err = await assertRejects(() => waits.waitForSelector("#foo", 100));
  assertStringIncludes((err as Error).message, 'timed out waiting for selector "#foo"');
  // "Error: " prefix should be stripped
  assertEquals((err as Error).message.startsWith("Error:"), false);
});

Deno.test("waitForText: throws on CDP exception with cleaned message", async () => {
  const cdp = {
    Runtime: {
      evaluate: () =>
        Promise.resolve({
          exceptionDetails: {
            exception: {
              description: 'Error: timed out waiting for text "hello" (100ms)',
            },
          },
        }),
    },
  };
  const waits = createWaitMethods(cdp, "session1");
  const err = await assertRejects(() => waits.waitForText("hello", 100));
  assertStringIncludes((err as Error).message, 'timed out waiting for text "hello"');
  assertEquals((err as Error).message.startsWith("Error:"), false);
});

Deno.test("waitForTextInElement: throws on CDP exception with cleaned message", async () => {
  const cdp = {
    Runtime: {
      callFunctionOn: () =>
        Promise.resolve({
          exceptionDetails: {
            exception: {
              description: 'Error: timed out waiting for text "hello" in element (100ms)',
            },
          },
        }),
    },
  };
  const waits = createWaitMethods(cdp, "session1");
  const err = await assertRejects(
    () => waits.waitForTextInElement("obj1", "hello", 100),
  );
  assertStringIncludes(
    (err as Error).message,
    'timed out waiting for text "hello" in element',
  );
  assertEquals((err as Error).message.startsWith("Error:"), false);
});

Deno.test("waitForSelector: falls back to exceptionDetails.text", async () => {
  const cdp = {
    Runtime: {
      evaluate: () =>
        Promise.resolve({
          exceptionDetails: { text: "Uncaught (in promise) Error" },
        }),
    },
  };
  const waits = createWaitMethods(cdp, "session1");
  const err = await assertRejects(() => waits.waitForSelector("#x", 100));
  assertEquals((err as Error).message, "Uncaught (in promise) Error");
});
