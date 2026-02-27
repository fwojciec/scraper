import type {
  EvalRequest,
  EvalResult,
  NavigateRequest,
  PageInfo,
  SnapshotOptions,
  SnapshotResult,
} from "../domain/mod.ts";

/** Dependencies injected from main.ts composition root. */
export interface ServerDeps {
  navigate(req: NavigateRequest): Promise<PageInfo>;
  evaluate(req: EvalRequest): Promise<EvalResult>;
  screenshot(name: string, fullPage?: boolean): Promise<string>;
  listPages(): Promise<PageInfo[]>;
  closePage(name: string): Promise<void>;
  snapshot(options: SnapshotOptions): Promise<SnapshotResult>;
}

/** Handle returned by createServer — testable via .request(), servable via .serve(). */
export interface Server {
  /** Send a synthetic request to the handler (for testing). */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Start listening on 127.0.0.1. Returns the Deno.HttpServer for lifecycle. */
  serve(options: { port: number }): Deno.HttpServer;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type Route = {
  methods: string[];
  handle: (req: Request, match: RegExpExecArray) => Response | Promise<Response>;
};

/** Create a server with injected domain dependencies. */
export function createServer(deps: ServerDeps): Server {
  let httpServer: Deno.HttpServer | undefined;

  const routes: [RegExp, Route][] = [
    [/^\/health$/, {
      methods: ["GET"],
      handle: async () => {
        const pages = await deps.listPages();
        return jsonResponse({ status: "ok", pages });
      },
    }],
    [/^\/pages$/, {
      methods: ["GET", "POST"],
      handle: async (req) => {
        if (req.method === "GET") {
          const pages = await deps.listPages();
          return jsonResponse(pages);
        }
        const body = await readJson(req);
        if (!body) return errorResponse("invalid JSON", 400);
        if (!body.url) return errorResponse("url is required", 400);
        const result = await deps.navigate({
          name: (body.name as string) ?? undefined,
          url: body.url as string,
        });
        return jsonResponse(result);
      },
    }],
    [/^\/pages\/([^/]+)$/, {
      methods: ["DELETE"],
      handle: async (_req, match) => {
        await deps.closePage(decodeURIComponent(match[1]));
        return jsonResponse({ ok: true });
      },
    }],
    [/^\/snapshot$/, {
      methods: ["POST"],
      handle: async (req) => {
        const body = await readJson(req);
        if (!body) return errorResponse("invalid JSON", 400);
        const options: SnapshotOptions = {
          name: (body.name as string) ?? "default",
          maxDepth: body.maxDepth as number | undefined,
          maxNodes: body.maxNodes as number | undefined,
          selector: body.selector as string | undefined,
        };
        const result = await deps.snapshot(options);
        return jsonResponse(result);
      },
    }],
    [/^\/eval$/, {
      methods: ["POST"],
      handle: async (req) => {
        const body = await readJson(req);
        if (!body) return errorResponse("invalid JSON", 400);
        if (!body.expression) return errorResponse("expression is required", 400);
        const result = await deps.evaluate({
          name: (body.name as string) ?? "default",
          expression: body.expression as string,
        });
        return jsonResponse(result);
      },
    }],
    [/^\/screenshot$/, {
      methods: ["POST"],
      handle: async (req) => {
        const body = await readJson(req);
        if (!body) return errorResponse("invalid JSON", 400);
        const name = (body.name as string) ?? "default";
        const fullPage = body.fullPage as boolean | undefined;
        const filePath = await deps.screenshot(name, fullPage);
        return jsonResponse({ path: filePath });
      },
    }],
    [/^\/shutdown$/, {
      methods: ["POST"],
      handle: () => {
        if (httpServer) {
          const ref = httpServer;
          queueMicrotask(() => ref.shutdown());
        }
        return jsonResponse({ ok: true });
      },
    }],
  ];

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      for (const [pattern, route] of routes) {
        const match = pattern.exec(path);
        if (!match) continue;
        if (!route.methods.includes(req.method)) {
          return errorResponse("method not allowed", 405);
        }
        return await route.handle(req, match);
      }
      return errorResponse("not found", 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal server error";
      return errorResponse(message, 500);
    }
  };

  return {
    request(path: string, init?: RequestInit): Promise<Response> {
      const url = path.startsWith("http") ? path : `http://localhost${path}`;
      return handler(new Request(url, init));
    },
    serve(options: { port: number }): Deno.HttpServer {
      httpServer = Deno.serve(
        { port: options.port, hostname: "127.0.0.1", onListen: () => {} },
        handler,
      );
      return httpServer;
    },
  };
}
