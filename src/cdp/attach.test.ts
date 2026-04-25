import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { defaultUserDataDir, parseBrowserWsUrl, readDevToolsActivePort } from "./attach.ts";

Deno.test("readDevToolsActivePort parses port and wsPath", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/DevToolsActivePort`, "9222\n/devtools/browser/abc-123\n");
    const result = await readDevToolsActivePort(dir);
    assertEquals(result.port, 9222);
    assertEquals(result.wsPath, "/devtools/browser/abc-123");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readDevToolsActivePort errors when file missing and no fallback port set", async () => {
  const dir = await Deno.makeTempDir();
  const prev = Deno.env.get("SCRAPER_DEBUG_PORT");
  Deno.env.delete("SCRAPER_DEBUG_PORT");
  try {
    const err = await assertRejects(
      () => readDevToolsActivePort(dir),
      Error,
    );
    assertStringIncludes(err.message, "DevToolsActivePort not found");
  } finally {
    if (prev !== undefined) Deno.env.set("SCRAPER_DEBUG_PORT", prev);
    await Deno.remove(dir, { recursive: true });
  }
});

// --- parseBrowserWsUrl ---

Deno.test("parseBrowserWsUrl extracts port and path from ws:// URL", () => {
  const result = parseBrowserWsUrl("ws://127.0.0.1:9222/devtools/browser/abc-123");
  assertEquals(result.port, 9222);
  assertEquals(result.wsPath, "/devtools/browser/abc-123");
});

Deno.test("parseBrowserWsUrl extracts port and path from localhost", () => {
  const result = parseBrowserWsUrl("ws://localhost:54321/devtools/browser/xyz");
  assertEquals(result.port, 54321);
  assertEquals(result.wsPath, "/devtools/browser/xyz");
});

Deno.test("parseBrowserWsUrl throws on non-ws scheme", () => {
  assertThrows(
    () => parseBrowserWsUrl("http://127.0.0.1:9222/devtools/browser/abc"),
    Error,
    "expected ws:// URL",
  );
});

Deno.test("parseBrowserWsUrl throws on missing port", () => {
  assertThrows(
    () => parseBrowserWsUrl("ws://127.0.0.1/devtools/browser/abc"),
    Error,
    "missing port",
  );
});

Deno.test("readDevToolsActivePort errors on malformed file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/DevToolsActivePort`, "just-one-line");
    const err = await assertRejects(
      () => readDevToolsActivePort(dir),
      Error,
    );
    assertStringIncludes(err.message, "unexpected format");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readDevToolsActivePort errors on non-numeric port", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/DevToolsActivePort`, "abc\n/devtools/browser/123\n");
    const err = await assertRejects(
      () => readDevToolsActivePort(dir),
      Error,
    );
    assertStringIncludes(err.message, "non-numeric port");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- defaultUserDataDir ---

Deno.test("defaultUserDataDir returns macOS path for stable", () => {
  const dir = defaultUserDataDir(undefined, "darwin");
  assertStringIncludes(dir, "Library/Application Support/Google/Chrome");
});

Deno.test("defaultUserDataDir returns macOS path for beta", () => {
  const dir = defaultUserDataDir("beta", "darwin");
  assertStringIncludes(dir, "Google/Chrome Beta");
});

Deno.test("defaultUserDataDir returns macOS path for canary", () => {
  const dir = defaultUserDataDir("canary", "darwin");
  assertStringIncludes(dir, "Google/Chrome Canary");
});

Deno.test("defaultUserDataDir returns Linux path for stable", () => {
  const dir = defaultUserDataDir(undefined, "linux");
  assertStringIncludes(dir, ".config/google-chrome");
});

Deno.test("defaultUserDataDir returns Linux path for beta", () => {
  const dir = defaultUserDataDir("beta", "linux");
  assertStringIncludes(dir, ".config/google-chrome-beta");
});

Deno.test("defaultUserDataDir returns Linux path for dev", () => {
  const dir = defaultUserDataDir("dev", "linux");
  assertStringIncludes(dir, ".config/google-chrome-unstable");
});

Deno.test("defaultUserDataDir throws for canary on Linux", () => {
  assertThrows(
    () => defaultUserDataDir("canary", "linux"),
    Error,
    "not available on Linux",
  );
});

Deno.test("defaultUserDataDir throws for unknown channel", () => {
  assertThrows(
    () => defaultUserDataDir("nightly", "darwin"),
    Error,
    "unknown Chrome channel",
  );
});
