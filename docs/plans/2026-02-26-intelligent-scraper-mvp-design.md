# Intelligent Web Scraper — MVP Design

## Problem

LLM agents need to extract structured data from web pages without flooding their context window with
raw HTML. Existing scraping tools are point-and-shoot — they dump markdown or JSON from a URL. We
need a tool that lets an LLM surgically query a page: orient via a compact structural
representation, then execute targeted extraction logic.

## Design Principles

1. **The LLM writes the extraction logic.** Like SQL for a database, the LLM writes JS expressions
   that run against the live DOM. The tool executes them deterministically.
2. **Compact page representation.** ARIA accessibility tree (YAML) instead of raw HTML — ~50x
   smaller, semantically meaningful, sufficient for the LLM to orient and write accurate selectors.
3. **Persistent browser state.** Pages stay alive between CLI calls. JS-rendered content, auth
   cookies, and DOM state survive across invocations.
4. **Zero high-level abstractions.** Raw CDP over WebSocket, not Playwright or Puppeteer. Deno's
   native APIs are sufficient.

## Architecture

Two processes, two ports.

```
CLI (stateless)          Daemon (Deno.serve)           Chrome (headless)
  │                         │  :3222 API                   │  :<dynamic> CDP
  │── POST /pages ─────────>│                              │
  │   { name, url }         │── Page.navigate ────────────>│
  │                         │<── ok ──────────────────────│
  │<── { name, url } ──────│                              │
  │                         │                              │
  │── POST /snapshot ──────>│                              │
  │   { name }              │── Runtime.evaluate ─────────>│
  │                         │   (inject ARIA script)       │
  │                         │<── YAML string ─────────────│
  │<── { yaml } ───────────│                              │
  │                         │                              │
  │── POST /eval ────────── >│                              │
  │   { name, expression }  │── Runtime.evaluate ─────────>│
  │                         │   (returnByValue: true)      │
  │                         │<── { result } ──────────────│
  │<── JSON ────────────────│                              │
```

**Daemon** (`scraper start`): Picks a free CDP port by binding a temporary TCP listener to `:0`,
reading the assigned port, then closing the listener before launching Chrome with
`--remote-debugging-port=<that port>`. Discovers Chrome's WebSocket URL via
`http://127.0.0.1:<cdpPort>/json/version` (with retry, since Chrome takes a moment to start).
Connects via CDP using `simple-cdp` from JSR, maintains a registry of named pages, serves an HTTP
API on `127.0.0.1:3222`. The CDP port is recorded in the PID file but never exposed to the CLI.

**CLI** (`scraper <command>`): Stateless client. Each command is one `fetch()` to the daemon API,
result printed to stdout. The LLM calls these via bash.

### Security

The daemon binds to `127.0.0.1` only (loopback). `/eval` executes arbitrary JS in the browser
context — this is the core design, not a bug. But since the browser may hold authenticated sessions:

- Loopback-only binding (no `0.0.0.0`)
- Eval timeout: 30s default, configurable via `--eval-timeout`
- Future: optional auth token via `--token` for multi-user machines

### Daemon Lifecycle

`scraper start` writes a PID file to `~/.scraper/daemon.pid` containing `{ pid, port, cdpPort }`.
`scraper stop` reads the PID file, sends `POST /shutdown` to the daemon, falls back to `SIGTERM` if
the HTTP call fails, then cleans up the PID file. All other CLI commands read the PID file to
discover the daemon port — no hardcoded defaults.

**Stale PID recovery:** On `scraper start`, if a PID file exists, check if the process is alive
(`Deno.kill(pid, 0)` or equivalent). If dead, clean up the stale PID file and start fresh. If alive,
print the existing daemon's info and exit.

**CDP port:** Allocated dynamically (ephemeral port) rather than hardcoded to 9222, to avoid
collisions. The daemon discovers Chrome's WebSocket URL via
`http://127.0.0.1:<cdpPort>/json/version` after launch. The chosen CDP port is recorded in the PID
file but never exposed to the CLI.

## CLI Commands

```
scraper start [--port 3222] [--chrome-path <path>] [--eval-timeout 30000]
scraper stop
scraper navigate <url> [--name default]
scraper pages
scraper snapshot [--name default] [--max-depth N] [--max-nodes N] [--selector "css"]
scraper eval '<js expression>' [--name default]
scraper screenshot [--name default] [--full-page]
```

Output conventions:

- `snapshot` prints raw YAML to stdout (pipeable, readable by LLM)
- `eval` prints JSON to stdout
- `screenshot` prints the file path to stdout
- `pages` prints a table
- Errors go to stderr with non-zero exit code

## HTTP API

| Method   | Path           | Body                                        | Returns                            |
| -------- | -------------- | ------------------------------------------- | ---------------------------------- |
| `GET`    | `/health`      | —                                           | `{ status: "ok", pages: [...] }`   |
| `POST`   | `/pages`       | `{ name, url }`                             | `{ name, targetId, url }`          |
| `DELETE` | `/pages/:name` | —                                           | `{ ok: true }`                     |
| `GET`    | `/pages`       | —                                           | `[{ name, url, targetId }]`        |
| `POST`   | `/snapshot`    | `{ name, maxDepth?, maxNodes?, selector? }` | `{ yaml: "..." }`                  |
| `POST`   | `/eval`        | `{ name, expression }`                      | `{ result: ... }`                  |
| `POST`   | `/shutdown`    | —                                           | `{ ok: true }` — graceful shutdown |
| `POST`   | `/screenshot`  | `{ name }`                                  | `{ path: "/tmp/..." }`             |

- Page `name` defaults to `"default"` if omitted
- `eval` uses `returnByValue: true` — returns JSON, not CDP remote object refs
- Errors return `{ error: "message" }` with appropriate HTTP status

## ARIA Snapshot Engine

Ported from dev-browser's approach, rewritten test-first in our own idiom.

The snapshot converts a live DOM into a compact YAML accessibility tree:

```yaml
- banner:
    - navigation:
        - link "Home" [ref=e1]
- main:
    - table:
        - row:
            - columnheader "Rank"
            - columnheader "Title"
        - row:
            - cell "1"
            - cell:
                - link "Some Book Title" [ref=e15]
            - cell "Author Name"
```

### What is preserved

- ARIA roles (implicit from HTML semantics + explicit from `role` attribute)
- Accessible names (`aria-label` > `alt`/`title` > text content > `aria-labelledby`)
- ARIA states: checked, disabled, expanded, level, pressed, selected
- Text content from visible nodes
- Link URLs (as `/url:` prop)
- Input placeholders (as `/placeholder:` prop)
- Interactable element refs (`e1`, `e2`, ...) for visible, pointer-receiving elements
- Shadow DOM content and slot assignments

### What is discarded

- All visual styling (colors, fonts, sizes, positions)
- CSS classes and IDs
- Data attributes
- Hidden elements (`display:none`, `visibility:hidden`, `aria-hidden`, zero-dimension)
- Non-semantic wrappers (generic `<div>`/`<span>` collapsed)
- Event listeners, bounding box coordinates

### Implementation

The engine is a JS string injected into the browser context via `Runtime.evaluate`. It runs entirely
in-browser, returns a YAML string. The script is injected lazily on first `/snapshot` call per page
and cached in the page's global scope (same pattern as dev-browser).

The algorithm:

1. Walk DOM depth-first from `document.body`, handling shadow roots and slots
2. For each element: check visibility, compute ARIA role, compute accessible name
3. Build an AriaNode tree with role, name, states, children
4. Assign refs to visible, pointer-event-receiving elements
5. Normalize: collapse consecutive text, remove redundant generic wrappers
6. Render to YAML

### Snapshot controls

To keep output bounded for large pages:

- `--selector "css"` — snapshot a subtree instead of full `document.body`
- `--max-depth N` — stop descending after N levels
- `--max-nodes N` — stop after N nodes emitted

### Phased implementation

The full ARIA spec is large. We implement test-first in phases, each gated by passing tests
extracted from dev-browser's behavior:

**Phase 1 (blocks end-to-end):** DOM walk, visibility, implicit role mapping for common HTML
elements, text content as accessible name, refs on interactable elements, YAML rendering. This is
enough to snapshot Publishers Weekly's bestseller table.

**Phase 2 (blocks Salesforce):** Shadow DOM traversal, slot assignments,
`aria-label`/`aria-labelledby` name computation, ARIA states (checked, expanded, disabled, etc.).

**Phase 3 (completeness):** `aria-owns` reparenting, CSS `::before`/`::after` content, presentation
conflict resolution, full W3C name computation with label-for association.

## Project Structure

Functional core / imperative shell. Domain is the functional core (pure types, interfaces, and pure
orchestration functions with zero I/O). Adapters are the imperative shell, each wrapping one
external dependency. Composition root wires them together.

```
scraper/
├── deno.json
├── CLAUDE.md
├── src/
│   ├── domain/                  # Functional core. Zero I/O. Zero side effects.
│   │   ├── page.ts              # Page, PageInfo, NavigateRequest
│   │   ├── eval.ts              # EvalRequest, EvalResult
│   │   ├── browser.ts           # BrowserService, SnapshotService interfaces
│   │   ├── snapshot.ts          # SnapshotOptions, SnapshotResult, pure orchestration
│   │   └── mod.ts
│   │
│   ├── cdp/                     # ADAPTER: Wraps Chrome DevTools Protocol
│   │   ├── connection.ts        # simple-cdp wrapper, implements BrowserService
│   │   ├── connection.test.ts
│   │   ├── chrome.ts            # Launch/kill Chrome via Deno.Command
│   │   ├── chrome.test.ts
│   │   └── mod.ts
│   │
│   ├── aria/                    # ADAPTER: Wraps DOM Accessibility API
│   │   ├── tree.ts              # Browser-injected JS: DOM -> AriaNode
│   │   ├── tree.test.ts         # Behavioral tests from dev-browser
│   │   ├── render.ts            # AriaNode -> YAML string
│   │   ├── render.test.ts
│   │   └── mod.ts
│   │
│   ├── http/                    # ADAPTER: Wraps Deno.serve
│   │   ├── server.ts            # Routes, receives wired deps from main.ts
│   │   ├── server.test.ts
│   │   └── mod.ts
│   │
│   ├── cli/                     # ADAPTER: Wraps Deno.args
│   │   ├── commands.ts          # Subcommand dispatch, output formatting
│   │   ├── commands.test.ts
│   │   └── mod.ts
│   │
│   └── main.ts                  # Composition root: wires adapters → domain
│
└── tests/
    └── integration/
        ├── fixture-server.ts        # Local HTTP server serving HTML fixtures
        ├── fixtures/
        │   ├── bestseller-table.html
        │   ├── shadow-dom.html
        │   └── js-rendered.html
        ├── snapshot.integration.test.ts
        └── eval.integration.test.ts
```

Dependency flow (strictly inward, uniform rules, no exceptions):

```
domain/    ──> (nothing)
cdp/       ──> domain/
aria/      ──> domain/
http/      ──> domain/
cli/       ──> domain/
main.ts    ──> everything (wiring only)
```

Every adapter has the same rule: import only from `domain/`. No adapter imports another adapter.
`main.ts` is the only place that knows about all concrete adapters and wires them together. `http/`
receives its wired dependencies (navigate, eval, snapshot functions) from `main.ts` via constructor
injection.

**Enforcement:** A `deno task lint:deps` Deno script that uses `deno info --json` to scan all `.ts`
files in each module directory (not just the `mod.ts` graph), then asserts no illegal cross-adapter
imports exist. Stray files in `src/` root are also checked independently. This uses Deno's own
module resolution — handles re-exports, barrel files, dynamic imports, and path aliases correctly.
The rules:

- `domain/` may import nothing from `src/`
- Each adapter (`cdp/`, `aria/`, `http/`, `cli/`) may import only from `domain/`
- Only `main.ts` may import from all modules

The script lives at `scripts/lint-deps.ts`, runs in CI, and is encoded in `CLAUDE.md` as a hard
rule. Violations are build failures, not warnings.

## Test Strategy

Three layers, each testing a different concern.

### Layer 1: ARIA snapshot — behavioral tests from dev-browser

Study dev-browser's snapshot engine, run it against known HTML inputs, capture output. That output
becomes our test assertions. Our implementation must produce equivalent results.

```ts
Deno.test("link with href gets role and ref", () => {
  const html = `<a href="/about">About Us</a>`;
  const yaml = snapshot(html);
  assertStringIncludes(yaml, `link "About Us" [ref=e1]`);
});

Deno.test("table structure maps to ARIA roles", () => {
  const html = `<table>
    <tr><th>Rank</th><th>Title</th></tr>
    <tr><td>1</td><td>Some Book</td></tr>
  </table>`;
  const yaml = snapshot(html);
  assertStringIncludes(yaml, "table:");
  assertStringIncludes(yaml, "row:");
  assertStringIncludes(yaml, "cell");
});

Deno.test("hidden elements excluded", () => {
  const html = `<div>Visible</div>
    <div style="display:none">Hidden</div>`;
  const yaml = snapshot(html);
  assertStringIncludes(yaml, "Visible");
  assertNotIncludes(yaml, "Hidden");
});

Deno.test("heading level preserved", () => {
  const html = `<h2>Chapter One</h2>`;
  const yaml = snapshot(html);
  assertStringIncludes(yaml, `heading "Chapter One" [level=2]`);
});

Deno.test("generic div wrappers collapsed", () => {
  const html = `<div><div><a href="/">Home</a></div></div>`;
  const yaml = snapshot(html);
  assertNotIncludes(yaml, "generic");
});

Deno.test("aria-label overrides text content", () => {
  const html = `<button aria-label="Close dialog">X</button>`;
  const yaml = snapshot(html);
  assertStringIncludes(yaml, `button "Close dialog"`);
});
```

**DOM for unit tests:** `deno-dom` for role mapping, name computation, YAML rendering (fast, no
Chrome). Visibility and layout-dependent tests require real Chrome.

### Layer 2: HTTP + CLI — request/response tests

Mock at the domain interface boundary. The HTTP server receives its dependencies as functions — test
with inline mocks.

```ts
Deno.test("POST /eval returns result", async () => {
  const server = createServer({
    evaluate: async () => ({ result: { title: "Test" } }),
    navigate: async () => ({ name: "default", url: "...", targetId: "t1" }),
    snapshot: async () => ({ yaml: "- heading" }),
  });
  const res = await server.request("/eval", {
    method: "POST",
    body: JSON.stringify({ name: "default", expression: "document.title" }),
  });
  assertEquals((await res.json()).result, { title: "Test" });
});
```

### Layer 3: Integration — real Chrome, local fixtures

Integration tests use a local HTTP server serving HTML fixture files. This keeps tests deterministic
and fast — no network dependency, no flaky third-party pages.

```ts
// tests/integration/fixture-server.ts
// Deno.serve that serves tests/integration/fixtures/*.html

// tests/integration/snapshot.integration.test.ts
Deno.test("extract bestseller list from fixture", async () => {
  const fixtures = await startFixtureServer();
  const daemon = await startDaemon();
  try {
    await cli("navigate", `${fixtures.url}/bestseller-table.html`);

    const snapshot = await cli("snapshot");
    assertStringIncludes(snapshot, "table:");

    const books = await cli(
      "eval",
      `
      [...document.querySelectorAll("tr")]
        .filter(r => r.querySelector("td"))
        .slice(0, 5)
        .map(r => ({
          rank: r.cells[0]?.textContent?.trim(),
          title: r.querySelector("a")?.textContent?.trim()
        }))
    `,
    );
    const parsed = JSON.parse(books);
    assertEquals(parsed.length, 5);
    assert(parsed[0].rank);
    assert(parsed[0].title);
  } finally {
    await daemon.stop();
    await fixtures.stop();
  }
});
```

One optional live smoke test (skipped in CI, run manually):

```ts
Deno.test({
  name: "smoke: Publishers Weekly live",
  ignore: Deno.env.get("CI") === "true",
  fn: async () => {/* ... real URL ... */},
});
```

| Layer            | What                                           | DOM source             | Speed    |
| ---------------- | ---------------------------------------------- | ---------------------- | -------- |
| ARIA unit        | Role mapping, name computation, YAML rendering | `deno-dom`             | ~ms      |
| HTTP/CLI unit    | Request routing, output formatting             | Mock domain interfaces | ~ms      |
| Integration      | Full pipeline against local fixtures           | Real Chrome            | ~seconds |
| Smoke (optional) | Sanity check against live sites                | Real Chrome + network  | ~seconds |

## Example LLM Session

```bash
$ scraper start
Daemon ready on 127.0.0.1:3222 (pid 12345)

$ scraper navigate https://www.publishersweekly.com/pw/nielsen/top100.html
Navigated "default" to https://www.publishersweekly.com/pw/nielsen/top100.html

$ scraper snapshot | head -30
- banner:
  - navigation:
    - link "Home" [ref=e1]
    ...
- main:
  - heading "Top 10 Overall" [level=1]
  - table:
    - row:
      - columnheader "Rank"
      - columnheader "Title"
      - columnheader "Author"
    - row:
      - cell "1"
      - cell:
        - link "James" [ref=e15]
      - cell "Percival Everett"
    ...

$ scraper eval '[...document.querySelectorAll("tr")]
  .filter(r => r.querySelector("td"))
  .map(r => ({
    rank: r.cells[0]?.textContent?.trim(),
    title: r.querySelector("a")?.textContent?.trim(),
    author: r.cells[3]?.textContent?.trim()
  }))'
[
  {"rank":"1","title":"James","author":"Percival Everett"},
  {"rank":"2","title":"Intermezzo","author":"Sally Rooney"},
  ...
]
```

The LLM uses `snapshot` to orient (compact YAML, not full HTML), then writes a JS expression to
extract exactly the data it needs. If the expression is wrong, it inspects the result and refines —
same iterative loop as writing SQL queries.

## Tech Stack

- **Runtime:** Deno 2.x
- **CDP client:** `@simple-cdp/simple-cdp` from JSR (zero deps, Proxy-based, ~200 lines)
- **Browser:** Headless Chrome via `Deno.Command` with
  `--headless=new --remote-debugging-port=<dynamic>` (internal, ephemeral port)
- **HTTP server:** `Deno.serve` (built-in, no framework)
- **DOM for tests:** `deno-dom` for unit tests, real Chrome for integration
- **No other dependencies**

## Future (Post-MVP)

- `scraper search "<query>"` — Google search, return result links
- MCP server wrapper — expose the same capabilities as MCP tools
- Intelligent diffing — semantic comparison of scrape results over time
- Persistent storage — schemas, scraped data, change history
- Concurrent scraping — parallel pages across multiple Chrome instances
- `Deno.cron` scheduling for periodic scrapes
