/** Serve HTML fixtures from the fixtures/ directory on a random port. */

const FIXTURES_BASE = new URL("./fixtures/", import.meta.url);

export interface FixtureServer {
  port: number;
  url: (path: string) => string;
  close: () => Promise<void>;
}

export function startFixtureServer(): FixtureServer {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      // /delay?ms=N&text=... — delay then respond with `text` (default "ok").
      // Used by slow-loading fixtures to keep network in-flight past the
      // default 500ms grace so waitForNetworkIdle can be observed.
      if (url.pathname === "/delay") {
        const ms = Number(url.searchParams.get("ms") ?? "0");
        const text = url.searchParams.get("text") ?? "ok";
        if (ms > 0) await new Promise((r) => setTimeout(r, ms));
        return new Response(text, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      const reqPath = url.pathname.slice(1);
      const fileUrl = new URL(reqPath, FIXTURES_BASE);
      if (!fileUrl.href.startsWith(FIXTURES_BASE.href)) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        const content = await Deno.readTextFile(fileUrl);
        return new Response(content, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    },
  );

  const port = server.addr.port;
  return {
    port,
    url: (path: string) => `http://127.0.0.1:${port}/${path}`,
    close: () => server.shutdown(),
  };
}
