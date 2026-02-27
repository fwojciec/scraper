import { assertEquals, assertGreater } from "@std/assert";
import { killChrome, launchChrome } from "./chrome.ts";

Deno.test("launchChrome returns pid and port", async () => {
  const chrome = await launchChrome();
  try {
    assertGreater(chrome.pid, 0);
    assertGreater(chrome.port, 0);
    // Chrome should be reachable on the debugging port
    const res = await fetch(`http://127.0.0.1:${chrome.port}/json/version`);
    assertEquals(res.status, 200);
    const info = await res.json();
    assertEquals(typeof info.webSocketDebuggerUrl, "string");
  } finally {
    await killChrome(chrome);
  }
});

Deno.test("killChrome terminates the process", async () => {
  const chrome = await launchChrome();
  await killChrome(chrome);
  // After kill, the port should no longer be reachable
  await new Promise((r) => setTimeout(r, 200));
  try {
    await fetch(`http://127.0.0.1:${chrome.port}/json/version`);
    throw new Error("Expected fetch to fail after kill");
  } catch (e) {
    if (e instanceof TypeError) {
      // Connection refused — expected
    } else if (e instanceof Error && e.message.includes("Expected fetch")) {
      throw e;
    }
    // Other network errors are also acceptable
  }
});
