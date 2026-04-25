import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { readDevToolsActivePort } from "../../src/cdp/attach.ts";

/**
 * Covers the `chrome://inspect/#remote-debugging` UI-toggle path, where Chrome
 * opens a DevTools server on 9222 but does NOT write DevToolsActivePort to the
 * user data dir. Scraper falls back to `/json/version` to discover the URL.
 */

function serveJsonVersion(port: number, wsUrl: string): {
  abort: AbortController;
  done: Promise<void>;
} {
  const abort = new AbortController();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", signal: abort.signal, onListen() {} },
    (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/json/version") {
        return new Response(JSON.stringify({ webSocketDebuggerUrl: wsUrl }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  );
  return { abort, done: server.finished };
}

async function withEnv(key: string, value: string, fn: () => Promise<void>): Promise<void> {
  const prev = Deno.env.get(key);
  Deno.env.set(key, value);
  try {
    await fn();
  } finally {
    if (prev === undefined) Deno.env.delete(key);
    else Deno.env.set(key, prev);
  }
}

Deno.test("readDevToolsActivePort falls back to /json/version when port file missing", async () => {
  const emptyDir = await Deno.makeTempDir();
  const port = await pickEphemeralPort();
  const { abort, done } = serveJsonVersion(
    port,
    `ws://127.0.0.1:${port}/devtools/browser/fake-browser-id`,
  );
  try {
    await withEnv("SCRAPER_DEBUG_PORT", String(port), async () => {
      const result = await readDevToolsActivePort(emptyDir);
      assertEquals(result.port, port);
      assertEquals(result.wsPath, "/devtools/browser/fake-browser-id");
    });
  } finally {
    abort.abort();
    await done.catch(() => {});
    await Deno.remove(emptyDir, { recursive: true });
  }
});

Deno.test("readDevToolsActivePort errors when file missing and HTTP fallback unreachable", async () => {
  const emptyDir = await Deno.makeTempDir();
  // Pick an ephemeral port, then close the listener so nothing is listening.
  const port = await pickEphemeralPort();
  try {
    await withEnv("SCRAPER_DEBUG_PORT", String(port), async () => {
      const err = await assertRejects(() => readDevToolsActivePort(emptyDir), Error);
      assertStringIncludes(err.message, "DevToolsActivePort not found");
    });
  } finally {
    await Deno.remove(emptyDir, { recursive: true });
  }
});

async function pickEphemeralPort(): Promise<number> {
  const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  // Brief yield so the kernel releases the socket before callers re-bind.
  await new Promise((r) => setTimeout(r, 10));
  return port;
}
