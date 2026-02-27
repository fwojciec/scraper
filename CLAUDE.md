# Scraper

Intelligent web scraping CLI for LLM agents. Uses CDP to control headless Chrome, ARIA snapshots for
compact page representation, JS eval for surgical data extraction.

## Architecture

Ben Johnson's standard package layout adapted for TypeScript/Deno.

### Dependency rule (NEVER violate)

- `src/domain/` is the functional core: pure types, interfaces, and pure functions. Zero I/O, zero
  side effects, imports NOTHING from other `src/` modules.
- Adapter packages (`cdp/`, `aria/`, `http/`, `cli/`) are the imperative shell. Each imports only
  from `domain/`.
- Adapters NEVER import from other adapters.
- `src/main.ts` is the composition root — imports from all adapters and wires them together.

Enforced by `deno task lint:deps` using `deno info --json`. Violations are build failures.

### File patterns

- Domain: `src/domain/<concept>.ts` — types, interfaces, and pure orchestration functions
- Adapters: `src/<dependency-name>/<implementation>.ts`
- Tests: co-located as `<filename>.test.ts`
- Integration tests: `tests/integration/` with local HTML fixtures
- All dependencies injected via function factory parameter objects

## Commands

- `deno task dev` — run the daemon
- `deno task test` — run unit tests
- `deno task test:integration` — run integration tests (requires Chrome)
- `deno task lint:deps` — check dependency boundaries
- `deno task ci` — full CI pipeline (fmt, lint, check, lint:deps, test)
- `deno lint && deno fmt --check` — verify formatting

## Tech Stack

- Deno 2.x, TypeScript (strict)
- `@simple-cdp/simple-cdp` (JSR) — CDP over WebSocket
- `@b-fuze/deno-dom` — DOM for unit tests
- `Deno.serve` — HTTP server (no framework)
- `Deno.Command` — Chrome process management

## Design Doc

See `docs/plans/2026-02-26-intelligent-scraper-mvp-design.md` for full architecture.
