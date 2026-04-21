# Architecture

Scraper follows the [Ben Johnson standard package layout][bj]: a pure domain in the middle, a thin
application layer that orchestrates it, adapters wrapping external systems, and one composition
root. Dependency direction is enforced by a lint plugin — violations are build failures.

[bj]: https://www.gobeyond.dev/standard-package-layout/

## Layers

```
          ┌───────────────────────────┐
          │         main.ts           │   composition root — wires everything
          └──────────────┬────────────┘
                         │
       ┌─────────────────┼─────────────────┐
       ▼                 ▼                 ▼
┌────────────┐    ┌────────────┐    ┌────────────┐
│    cli/    │    │    app/    │    │ adapters:  │
│  (cli arg  │───▶│ ScraperApp │◀───│ cdp/ aria/ │
│  parsing)  │    │  orch.     │    │            │
└────────────┘    └─────┬──────┘    └─────┬──────┘
                        │                 │
                        └───── domain/ ◀──┘
                           (pure core)
```

- `src/domain/` — pure types, algorithms, contracts. Zero imports from elsewhere in `src/`. This is
  where the stale-ref tokenizer, retention policy, and service interfaces live.
- `src/app/` — orchestration. Implements `ScraperApp`; the only module allowed to import multiple
  adapters. Knows _when_ to snapshot, serialize counters, handle dialogs, and re-raise stale refs.
- `src/cdp/` — Chrome DevTools Protocol adapter. Owns all simple-cdp imports and CDP-specific
  translation (AX-node shape, dialog event wiring, network-idle bookkeeping).
- `src/aria/` — ARIA tree → YAML renderer. Consumes the shape `domain/` defines; emits the snapshot
  artifact text.
- `src/cli/` — argv parser + dispatcher. Translates flags into calls on `ScraperApp`, formats stdout
  pointer lines, maps exceptions to exit codes + stderr text.
- `src/main.ts` — composition root. Builds the stores (`RefsStore`, `CounterStore`,
  `ArtifactStore`), defines `withStateLock` (file-backed advisory flock), wires the adapters
  together, and invokes the CLI.

## Dependency rule

From `scripts/lint-deps-plugin.ts`:

```ts
domain: [],
app:    ["domain", "cdp", "aria", "fs"],
cdp:    ["domain"],
aria:   ["domain"],
cli:    ["domain"],
fs:     ["domain"],
```

Consequences:

- `domain/` cannot reach out — no `simple-cdp`, no `Deno.*`, no adapters. This makes every domain
  test pure.
- Adapters can only talk to `domain/`, never to each other. `cdp/` has no idea `aria/` exists.
- `cli/` depends only on the `ScraperApp` interface and domain types — it's completely decoupled
  from how the app is implemented.
- `app/` is the one place where adapters meet. It sits on top of the domain types and wires them
  into a useful whole.
- `main.ts` is the only file allowed to import across all modules; it's the composition root.

Violations fail `deno lint` (run in CI via `deno task ci`).

## `ScraperApp` interface

Defined in `src/domain/app.ts`. Seven methods, one per CLI command:

```ts
interface ScraperApp {
  navigate(targetId, url, options?): Promise<ActionResult>;
  navigateNew(url, options?): Promise<NavigateNewResult>;
  snapshot(targetId, options): Promise<SnapshotResult>;
  evaluate(targetId, expression, options?): Promise<EvalResult>;
  screenshot(targetId): Promise<string>;
  upload(targetId, target, filePath, options?): Promise<ActionResult>;
  wait(targetId, request, options?): Promise<ActionResult>;
}
```

Every method takes a canonical full `targetId` — a 32-hex Chrome target id. Canonicalization from a
user-supplied prefix lives in `cdp/tabs.ts::canonicalizeTargetId` and is invoked by `cli/` before
any method call. The app layer never sees ambiguous input.

`ActionOptions` carries two cross-cutting concerns: `includeSnapshot` (whether to auto-snapshot
after the action) and `onDialog` (how to respond to native JS dialogs). `WaitRequest` is a
discriminated union over `selector | text | textInElement` that makes invalid combinations
unrepresentable.

## Ports (stores)

`app/mod.ts` depends on three stores through narrow interfaces:

```ts
interface RefsStore {
  read(targetId): Promise<RefMap | null>;
  write(targetId, refs, snapshotId): Promise<void>;
  remove(targetId): Promise<void>;
}

interface CounterStore {
  read(): Promise<number>;
  write(value): Promise<void>;
}

interface ArtifactStore {
  writeSnapshot(snapshotId, yaml): Promise<string>;
  writeScreenshot(screenshotId, png): Promise<string>;
}
```

`main.ts` backs them with atomic `Deno.writeFile`/`Deno.rename` writes under `~/.scraper/`. Tests
back them with in-memory stubs.

## State and concurrency

`~/.scraper/` layout:

```
counter         monotonic int for s{N}/shot{N} ids
counter-refs    monotonic int for element ref ids (cross-tab, session-scoped)
state.lock      advisory flock
refs.<tid>.json per-tab ref map (overwritten per snapshot)
s{N}.yaml       snapshot artifacts
shot{N}.png     screenshot artifacts
```

`ScraperAppDeps.withStateLock` wraps every counter-allocating region in an exclusive advisory flock
(backed by `Deno.FsFile.lock(true)` on `state.lock`). Two parallel `scraper snapshot` processes
serialize through the lock; neither can read the same counter, mint the same `sN`, or overlap ref
ranges.

`screenshot` locks only around the counter bump and disk write — the Chrome `CaptureScreenshot`
round-trip runs outside the lock so a slow capture does not stall other invocations.

`navigate` and `wait --includeSnapshot` invalidate `refs.<targetId>.json` eagerly (before the
auto-snapshot) so a snapshot failure can't leave a caller resolving refs against the prior page's
DOM.

Retention is purely functional: `domain/retention.ts` returns the list of names to delete given an
`ArtifactEntry[]` and a `RetentionPolicy` (max count, max age, current time). `main.ts` scans the
directory, gathers entries, calls `selectDeletions`, and deletes.

## Stale-ref contract

The canonical stale-ref error is produced by `domain/eval.ts::formatStaleRefError` and raised from
three places in `app/mod.ts`:

- `evaluate` — before resolving any `$ref()` in the expression.
- `upload` with `--ref` — before `resolveTarget`.
- `wait --ref --text` — before `resolveTarget`.

Keeping the check in the app layer (rather than letting the lower-level "unknown ref" surface) makes
the caller's recovery loop uniform: _see stale-ref error → run `scraper snapshot` → retry with a
fresh ref._

## Testing

- **Unit tests** co-located as `*.test.ts` in `src/` and `scripts/`. No Chrome, no network. Run with
  `deno task test`.
- **Integration tests** live under `tests/integration/`. Real Chrome (launched per test suite via
  `runtime.ts`), real local HTTP fixtures, subprocess invocations of the built CLI. Run with
  `deno task test:integration`.
- `deno task ci` = `fmt --check + lint + check + test + test:integration`. This is the quality gate.

## Key design decisions

- **Attach-only, no active tab.** Every invocation addresses a tab explicitly. There is no persisted
  `~/.scraper/target` — the v0.1 rewrite removed it, enforced by an integration test asserting the
  file is never written.
- **Asymmetric auto-snapshot.** Mutating actions that the caller sequences explicitly (`navigate`,
  `wait`) snapshot because the page changed. `eval` and `upload` don't, because most evals are reads
  and uploading doesn't always change the DOM.
- **Domain-free of Deno.** The lint rule keeps `domain/` portable — it would run unchanged on Node,
  Bun, or in-browser. The current composition root is Deno; swapping it is a `main.ts` task.
- **Tokenizer does not parse comments or regex literals.** `scanRefs` in `domain/eval.ts` skips
  string and template literals but deliberately leaves `/…/` regex bodies alone. Distinguishing `/`
  as comment-start vs regex-start vs division requires stateful lexing of the preceding token class;
  the cost/benefit favors accepting false positives inside comments over misparsing regex literals.
  See the docstring on `scanRefs` for the full argument.
