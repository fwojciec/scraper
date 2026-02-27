import { assertEquals } from "@std/assert";
import { createServer, type ServerDeps } from "./server.ts";

function stubDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    navigate: () =>
      Promise.resolve({ name: "default", url: "https://example.com", targetId: "t1" }),
    evaluate: () => Promise.resolve({ result: 42 }),
    screenshot: () => Promise.resolve("/tmp/screenshot.png"),
    listPages: () => Promise.resolve([]),
    closePage: () => Promise.resolve(),
    snapshot: () => Promise.resolve({ yaml: "- heading" }),
    ...overrides,
  };
}

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// --- GET /health ---

Deno.test("GET /health returns status ok with page list", async () => {
  const pages = [{ name: "default", url: "https://example.com", targetId: "t1" }];
  const server = createServer(stubDeps({ listPages: () => Promise.resolve(pages) }));
  const res = await server.request("/health");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "ok", pages });
});

// --- POST /pages ---

Deno.test("POST /pages navigates and returns page info", async () => {
  const server = createServer(stubDeps());
  const res = await server.request("/pages", json({ url: "https://example.com" }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { name: "default", url: "https://example.com", targetId: "t1" });
});

Deno.test("POST /pages uses provided name", async () => {
  const server = createServer(stubDeps({
    navigate: (req) => Promise.resolve({ name: req.name!, url: req.url, targetId: "t2" }),
  }));
  const res = await server.request("/pages", json({ name: "mypage", url: "https://example.com" }));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.name, "mypage");
});

Deno.test("POST /pages requires url", async () => {
  const server = createServer(stubDeps());
  const res = await server.request("/pages", json({}));
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "url is required");
});

// --- DELETE /pages/:name ---

Deno.test("DELETE /pages/:name closes the page", async () => {
  let closedName = "";
  const server = createServer(stubDeps({
    closePage: (name) => {
      closedName = name;
      return Promise.resolve();
    },
  }));
  const res = await server.request("/pages/mypage", { method: "DELETE" });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(closedName, "mypage");
});

// --- GET /pages ---

Deno.test("GET /pages returns page list", async () => {
  const pages = [
    { name: "default", url: "https://a.com", targetId: "t1" },
    { name: "other", url: "https://b.com", targetId: "t2" },
  ];
  const server = createServer(stubDeps({ listPages: () => Promise.resolve(pages) }));
  const res = await server.request("/pages");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), pages);
});

// --- POST /snapshot ---

Deno.test("POST /snapshot returns yaml", async () => {
  const server = createServer(stubDeps({
    snapshot: () => Promise.resolve({ yaml: '- main:\n    - heading "Hello"' }),
  }));
  const res = await server.request("/snapshot", json({ name: "default" }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { yaml: '- main:\n    - heading "Hello"' });
});

Deno.test("POST /snapshot defaults name to default", async () => {
  let receivedName = "";
  const server = createServer(stubDeps({
    snapshot: (opts) => {
      receivedName = opts.name ?? "";
      return Promise.resolve({ yaml: "- heading" });
    },
  }));
  await server.request("/snapshot", json({}));
  assertEquals(receivedName, "default");
});

Deno.test("POST /snapshot passes options through", async () => {
  let receivedOpts: Record<string, unknown> = {};
  const server = createServer(stubDeps({
    snapshot: (opts) => {
      receivedOpts = { ...opts };
      return Promise.resolve({ yaml: "- heading" });
    },
  }));
  await server.request(
    "/snapshot",
    json({ name: "p1", maxDepth: 5, maxNodes: 100, selector: "#main" }),
  );
  assertEquals(receivedOpts.name, "p1");
  assertEquals(receivedOpts.maxDepth, 5);
  assertEquals(receivedOpts.maxNodes, 100);
  assertEquals(receivedOpts.selector, "#main");
});

// --- POST /eval ---

Deno.test("POST /eval returns result", async () => {
  const server = createServer(stubDeps({
    evaluate: () => Promise.resolve({ result: { title: "Test" } }),
  }));
  const res = await server.request(
    "/eval",
    json({ name: "default", expression: "document.title" }),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { result: { title: "Test" } });
});

Deno.test("POST /eval requires expression", async () => {
  const server = createServer(stubDeps());
  const res = await server.request("/eval", json({ name: "default" }));
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "expression is required");
});

Deno.test("POST /eval defaults name to default", async () => {
  let receivedName = "";
  const server = createServer(stubDeps({
    evaluate: (req) => {
      receivedName = req.name ?? "";
      return Promise.resolve({ result: null });
    },
  }));
  await server.request("/eval", json({ expression: "1+1" }));
  assertEquals(receivedName, "default");
});

// --- POST /screenshot ---

Deno.test("POST /screenshot returns path", async () => {
  const server = createServer(stubDeps({
    screenshot: () => Promise.resolve("/tmp/shot.png"),
  }));
  const res = await server.request("/screenshot", json({ name: "default" }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { path: "/tmp/shot.png" });
});

Deno.test("POST /screenshot defaults name to default", async () => {
  let receivedName = "";
  const server = createServer(stubDeps({
    screenshot: (name) => {
      receivedName = name;
      return Promise.resolve("/tmp/shot.png");
    },
  }));
  await server.request("/screenshot", json({}));
  assertEquals(receivedName, "default");
});

// --- POST /shutdown ---

Deno.test("POST /shutdown returns ok", async () => {
  const server = createServer(stubDeps());
  const res = await server.request("/shutdown", { method: "POST" });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

// --- Error handling ---

Deno.test("unknown route returns 404", async () => {
  const server = createServer(stubDeps());
  const res = await server.request("/nonexistent");
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "not found" });
});

Deno.test("domain error returns 500 with error message", async () => {
  const server = createServer(stubDeps({
    navigate: () => Promise.reject(new Error("connection lost")),
  }));
  const res = await server.request("/pages", json({ url: "https://example.com" }));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "connection lost" });
});

Deno.test("wrong method returns 405", async () => {
  const server = createServer(stubDeps());
  const res = await server.request("/health", { method: "POST" });
  assertEquals(res.status, 405);
  assertEquals(await res.json(), { error: "method not allowed" });
});

Deno.test("wrong method on /pages/:name returns 405", async () => {
  const server = createServer(stubDeps());
  const res = await server.request("/pages/foo", { method: "GET" });
  assertEquals(res.status, 405);
  assertEquals(await res.json(), { error: "method not allowed" });
});

Deno.test("malformed JSON returns 400", async () => {
  const server = createServer(stubDeps());
  const res = await server.request("/pages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not json",
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "invalid JSON" });
});

Deno.test("malformed JSON on /snapshot returns 400", async () => {
  const server = createServer(stubDeps());
  const res = await server.request("/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not json",
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "invalid JSON" });
});

Deno.test("malformed JSON on /screenshot returns 400", async () => {
  const server = createServer(stubDeps());
  const res = await server.request("/screenshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not json",
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "invalid JSON" });
});

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

Deno.test("POST /screenshot passes fullPage option", async () => {
  let receivedFullPage: boolean | undefined;
  const server = createServer(stubDeps({
    screenshot: (_name, fullPage) => {
      receivedFullPage = fullPage;
      return Promise.resolve("/tmp/shot.png");
    },
  }));
  await server.request("/screenshot", json({ name: "default", fullPage: true }));
  assertEquals(receivedFullPage, true);
});
