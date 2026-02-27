## Design Philosophy

- Ben Johnson Standard Package Layout — `src/domain/` is the pure functional core (zero imports from other `src/` modules), packages organized by dependency not theme, /go-standard-package-layout skill if in doubt
- `src/main.ts` is the composition root — wires adapters together
- dependency injection via function factory parameter objects

## Dependency Rule

- `domain/` imports nothing from `src/`
- adapters import only from `domain/`, never from each other
- enforced by `deno task lint:deps` — violations are build failures

## Test Philosophy

- write failing tests first, then implement
- prefer behavioral assertions to testing implementation
- co-located as `<name>.test.ts`

## Quality Gate

deno task ci
