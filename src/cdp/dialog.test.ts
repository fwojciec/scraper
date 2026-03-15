import { assertEquals, assertThrows } from "@std/assert";
import { createDialogHandler } from "./dialog.ts";

/** Minimal mock CDP with event listener support on Page domain. */
function mockCdp() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const handled: Array<{ accept: boolean; promptText?: string }> = [];

  const Page = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
    handleJavaScriptDialog(
      params: { accept: boolean; promptText?: string },
      _sessionId: string,
    ) {
      handled.push(params);
      return Promise.resolve();
    },
  };

  function emit(type: string, params: Record<string, unknown>, sessionId: string) {
    for (const fn of listeners.get(type) ?? []) {
      fn({ sessionId, params });
    }
  }

  return { Page, emit, listeners, handled };
}

const SID = "session-1";

Deno.test("dialog: listener is registered on creation", () => {
  const cdp = mockCdp();
  createDialogHandler(cdp, SID);
  const count = cdp.listeners.get("javascriptDialogOpening")?.size ?? 0;
  assertEquals(count, 1);
});

Deno.test("dialog: onDialog receives events for matching session", () => {
  const cdp = mockCdp();
  const dialog = createDialogHandler(cdp, SID);
  const received: Array<{ type: string; message: string; defaultPrompt: string }> = [];

  dialog.onDialog((type, message, defaultPrompt) => {
    received.push({ type, message, defaultPrompt });
  });

  cdp.emit("javascriptDialogOpening", { type: "alert", message: "hello", defaultPrompt: "" }, SID);
  assertEquals(received.length, 1);
  assertEquals(received[0], { type: "alert", message: "hello", defaultPrompt: "" });
});

Deno.test("dialog: onDialog ignores events from other sessions", () => {
  const cdp = mockCdp();
  const dialog = createDialogHandler(cdp, SID);
  const received: string[] = [];

  dialog.onDialog((_, message) => received.push(message));
  cdp.emit(
    "javascriptDialogOpening",
    { type: "alert", message: "other", defaultPrompt: "" },
    "other-session",
  );

  assertEquals(received.length, 0);
});

Deno.test("dialog: double onDialog throws", () => {
  const cdp = mockCdp();
  const dialog = createDialogHandler(cdp, SID);

  dialog.onDialog(() => {});
  assertThrows(
    () => dialog.onDialog(() => {}),
    Error,
    "dialog handler already registered",
  );
});

Deno.test("dialog: unsubscribe clears handler", () => {
  const cdp = mockCdp();
  const dialog = createDialogHandler(cdp, SID);
  const received: string[] = [];

  const unsub = dialog.onDialog((_, message) => received.push(message));
  unsub();

  cdp.emit(
    "javascriptDialogOpening",
    { type: "alert", message: "ignored", defaultPrompt: "" },
    SID,
  );
  assertEquals(received.length, 0);

  // Can register a new handler after unsubscribe
  dialog.onDialog((_, message) => received.push(message));
  cdp.emit("javascriptDialogOpening", { type: "alert", message: "new", defaultPrompt: "" }, SID);
  assertEquals(received.length, 1);
});

Deno.test("dialog: cleanup removes event listener", () => {
  const cdp = mockCdp();
  const dialog = createDialogHandler(cdp, SID);

  assertEquals(cdp.listeners.get("javascriptDialogOpening")?.size, 1);
  dialog.cleanup();
  assertEquals(cdp.listeners.get("javascriptDialogOpening")?.size, 0);
});

Deno.test("dialog: handleDialog forwards to CDP", async () => {
  const cdp = mockCdp();
  const dialog = createDialogHandler(cdp, SID);

  await dialog.handleDialog(true);
  await dialog.handleDialog(false, "answer");

  assertEquals(cdp.handled.length, 2);
  assertEquals(cdp.handled[0], { accept: true });
  assertEquals(cdp.handled[1], { accept: false, promptText: "answer" });
});
