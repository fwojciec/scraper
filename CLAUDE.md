## Design Philosophy

- Ben Johnson Standard Package Layout — `src/domain/` is the pure functional core (zero imports from
  other `src/` modules), packages organized by dependency not theme, /go-standard-package-layout
  skill if in doubt
- `src/main.ts` is the composition root — wires adapters together
- dependency injection via function factory parameter objects

## Dependency Rule

- `domain/` imports nothing from `src/`
- adapters import only from `domain/`, never from each other
- enforced by `deno lint` — violations are build failures

## Test Philosophy

- write failing tests first, then implement
- prefer behavioral assertions to testing implementation
- **Unit tests** co-located as `<name>.test.ts` in `src/` and `scripts/` — no Chrome, no real
  servers, no real network; stubs/mocks and fast local I/O only
- **Integration tests** live under `tests/integration/` — real Chrome, real servers, subprocesses,
  multi-component wiring, or any test needing `--allow-net`/`--allow-run`
- `deno task test` runs unit tests only (`--allow-read --allow-write --allow-env`)
- `deno task test:integration` runs integration tests (`--allow-all`)
- `deno task ci` runs both as the full quality gate

## Quality Gate

deno task ci
