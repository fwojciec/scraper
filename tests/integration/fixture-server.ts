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
      const reqPath = new URL(req.url).pathname.slice(1);
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
