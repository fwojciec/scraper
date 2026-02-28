import { assertEquals } from "@std/assert";
import { createServer, type ServerDeps } from "../../src/http/server.ts";

function stubDeps(): ServerDeps {
  return {
    navigate: () =>
      Promise.resolve({ name: "default", url: "https://example.com", targetId: "t1" }),
    evaluate: () => Promise.resolve({ result: 42 }),
    screenshot: () => Promise.resolve("/tmp/screenshot.png"),
    listPages: () => Promise.resolve([]),
    closePage: () => Promise.resolve(),
    snapshot: () => Promise.resolve({ yaml: "- heading" }),
  };
}

Deno.test("serve binds to loopback and handles requests", async () => {
  const server = createServer(stubDeps());
  const httpServer = server.serve({ port: 0 });
  const addr = httpServer.addr as Deno.NetAddr;
  assertEquals(addr.hostname, "127.0.0.1");
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.status, "ok");
  } finally {
    await httpServer.shutdown();
  }
});

Deno.test("POST /shutdown stops the served instance", async () => {
  const server = createServer(stubDeps());
  const httpServer = server.serve({ port: 0 });
  const addr = httpServer.addr as Deno.NetAddr;
  const res = await fetch(`http://127.0.0.1:${addr.port}/shutdown`, { method: "POST" });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  await httpServer.finished;
});
