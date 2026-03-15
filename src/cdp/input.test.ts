import { assertEquals } from "@std/assert";
import { createInputMethods } from "./input.ts";

/** Stub CDP that records dispatchKeyEvent calls. */
function stubCdp() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    cdp: {
      Input: {
        dispatchKeyEvent(
          params: Record<string, unknown>,
          _sessionId: string,
        ) {
          calls.push({ method: "dispatchKeyEvent", params });
          return Promise.resolve();
        },
      },
      Runtime: {
        callFunctionOn() {
          return Promise.resolve({ result: { value: true } });
        },
      },
      DOM: {
        scrollIntoViewIfNeeded() {
          return Promise.resolve();
        },
        getContentQuads() {
          return Promise.resolve({ quads: [[0, 0, 10, 0, 10, 10, 0, 10]] });
        },
        describeNode() {
          return Promise.resolve({ node: { backendNodeId: 1 } });
        },
        setFileInputFiles() {
          return Promise.resolve();
        },
      },
    },
    calls,
  };
}

const SID = "s1";

Deno.test("pressKey: simple key dispatches rawKeyDown, keyUp", async () => {
  const { cdp, calls } = stubCdp();
  const input = createInputMethods(cdp, SID);
  await input.pressKey("Escape");
  const types = calls.map((c) => c.params.type);
  assertEquals(types, ["rawKeyDown", "keyUp"]);
  assertEquals(calls[0].params.key, "Escape");
  assertEquals(calls[0].params.code, "Escape");
});

Deno.test("pressKey: Enter dispatches char event with text", async () => {
  const { cdp, calls } = stubCdp();
  const input = createInputMethods(cdp, SID);
  await input.pressKey("Enter");
  const types = calls.map((c) => c.params.type);
  assertEquals(types, ["rawKeyDown", "char", "keyUp"]);
  assertEquals(calls[0].params.text, "\r");
  assertEquals(calls[1].params.text, "\r");
});

Deno.test("pressKey: Control+a dispatches modifier down, key, modifier up", async () => {
  const { cdp, calls } = stubCdp();
  const input = createInputMethods(cdp, SID);
  await input.pressKey("Control+a");
  const types = calls.map((c) => c.params.type);
  assertEquals(types, ["rawKeyDown", "rawKeyDown", "keyUp", "keyUp"]);
  // First: modifier down
  assertEquals(calls[0].params.key, "Control");
  assertEquals(calls[0].params.code, "ControlLeft");
  // Second: key down
  assertEquals(calls[1].params.key, "a");
  assertEquals(calls[1].params.code, "KeyA");
  // Third: key up
  assertEquals(calls[2].params.key, "a");
  // Fourth: modifier up
  assertEquals(calls[3].params.key, "Control");
});

Deno.test("pressKey: Shift++ parses + as the key", async () => {
  const { cdp, calls } = stubCdp();
  const input = createInputMethods(cdp, SID);
  await input.pressKey("Shift++");
  // Shift down, + down, + up, Shift up
  assertEquals(calls[0].params.key, "Shift");
  assertEquals(calls[1].params.key, "+");
  assertEquals(calls[3].params.key, "Shift");
});

Deno.test("pressKey: bare + key works", async () => {
  const { cdp, calls } = stubCdp();
  const input = createInputMethods(cdp, SID);
  await input.pressKey("+");
  const types = calls.map((c) => c.params.type);
  assertEquals(types, ["rawKeyDown", "keyUp"]);
  assertEquals(calls[0].params.key, "+");
});

Deno.test("pressKey: letter key maps to KeyX code", async () => {
  const { cdp, calls } = stubCdp();
  const input = createInputMethods(cdp, SID);
  await input.pressKey("a");
  assertEquals(calls[0].params.code, "KeyA");
});

Deno.test("pressKey: digit key maps to DigitN code", async () => {
  const { cdp, calls } = stubCdp();
  const input = createInputMethods(cdp, SID);
  await input.pressKey("5");
  assertEquals(calls[0].params.code, "Digit5");
});

Deno.test("pressKey: Space dispatches char event with space text", async () => {
  const { cdp, calls } = stubCdp();
  const input = createInputMethods(cdp, SID);
  await input.pressKey("Space");
  const types = calls.map((c) => c.params.type);
  assertEquals(types, ["rawKeyDown", "char", "keyUp"]);
  assertEquals(calls[0].params.text, " ");
  assertEquals(calls[0].params.code, "Space");
});

Deno.test("pressKey: multiple modifiers pressed and released in order", async () => {
  const { cdp, calls } = stubCdp();
  const input = createInputMethods(cdp, SID);
  await input.pressKey("Control+Shift+a");
  // Control down, Shift down, a down, a up, Shift up, Control up
  assertEquals(calls.length, 6);
  assertEquals(calls[0].params.key, "Control");
  assertEquals(calls[1].params.key, "Shift");
  assertEquals(calls[2].params.key, "a");
  assertEquals(calls[3].params.key, "a");
  // Released in reverse order
  assertEquals(calls[4].params.key, "Shift");
  assertEquals(calls[5].params.key, "Control");
});
