# v0.1 Refinements

## Context

Post-MVP code review identified four areas for improvement: test structure doesn't separate fast
unit tests from slow Chrome-dependent integration tests; the shutdown path is optimistic (CLI claims
"daemon stopped" before cleanup completes); `main.ts` has accreted generic persistence concerns
beyond composition; and PID file writes are not atomic.

This plan establishes conventions that reduce ambiguity for future contributors and keep failures
local, testable, and easy to reason about.

The four workstreams are mostly independent. The daemon E2E test (#4) depends on the shutdown fix
(#2) being finalized first. The rest can be implemented in any order.

---

## 1. Establish unit / integration test split as a project convention

**Problem:** Three test files launch real Chrome (`cdp/chrome.test.ts`, `cdp/connection.test.ts`,
`tests/integration/pipeline.test.ts`), two `server.test.ts` tests do real `Deno.serve` + `fetch`,
and `deno task ci` doesn't run `tests/integration/` at all. There's no way to run "fast tests only."

**Goal:** A clean operational distinction: `deno task test` is fast and local (no Chrome, no real
servers); `deno task test:integration` is slower and environment-dependent (Chrome, real network,
subprocesses). `deno task ci` is the full quality gate that runs both.

**Current test classification:**

| File                                 | Type        | Why                                         |
| ------------------------------------ | ----------- | ------------------------------------------- |
| `src/aria/snapshot.test.ts`          | Unit        | Mock `evaluateInPage`                       |
| `src/aria/tree.test.ts`              | Unit        | `deno-dom`, no Chrome                       |
| `src/aria/render.test.ts`            | Unit        | Pure data in, string out                    |
| `src/cli/mod.test.ts`                | Unit        | All deps stubbed                            |
| `scripts/lint-deps.test.ts`          | Unit        | `Deno.lint.runPlugin`, no I/O               |
| `src/http/server.test.ts:1-269`      | Unit        | `server.request()` with stubs               |
| `src/http/server.test.ts:271-294`    | Integration | Real `Deno.serve` + `fetch`                 |
| `src/cdp/chrome.test.ts`             | Integration | Launches real Chrome                        |
| `src/cdp/connection.test.ts`         | Integration | Real Chrome + CDP + filesystem (screenshot) |
| `tests/integration/pipeline.test.ts` | Integration | Real Chrome + fixture server + CDP          |

**Convention (document in CLAUDE.md):**

- **Unit tests** remain co-located as `<name>.test.ts` inside `src/` and `scripts/`. They never
  launch Chrome, never bind real ports, never do real network I/O. They may use stubs/mocks or fast
  local I/O (e.g. temp directories for filesystem adapters) — the criterion is speed and no
  environment dependencies, not purity from all I/O.
- **Integration tests** live under `tests/integration/`. They exercise real Chrome, real
  `Deno.serve` + `fetch`, subprocesses, and multi-component system wiring. The dividing line: any
  test that requires Chrome, binds a real network port, or spawns subprocesses belongs here.

**File moves:**

- Move `src/cdp/chrome.test.ts` → `tests/integration/chrome.test.ts`
- Move `src/cdp/connection.test.ts` → `tests/integration/connection.test.ts`
- Extract the two `serve`/`shutdown` tests from `src/http/server.test.ts:271-294` →
  `tests/integration/server.test.ts`
- Update imports in moved files (relative paths change)

**Task definitions in `deno.json`:**

```json
{
  "test": "deno test --allow-read --allow-write --allow-env src/ scripts/",
  "test:integration": "deno test --allow-all tests/integration/",
  "ci": "deno fmt --check && deno lint && deno task check && deno task test && deno task test:integration"
}
```

The tighter permissions for `deno task test` enforce the split: if a test accidentally needs
`--allow-net` or `--allow-run`, it will fail, signaling it belongs in `tests/integration/`.

**CLAUDE.md update:** Add to the Test Philosophy section:

```
- unit tests are co-located as `<name>.test.ts` in `src/` and `scripts/` — no Chrome, no real
  servers, no real network; stubs/mocks or fast local I/O (e.g. temp dirs) are fine
- integration tests live under `tests/integration/` — real Chrome, real servers, subprocesses,
  multi-component wiring
- `deno task test` runs unit tests only (fast, no Chrome required)
- `deno task test:integration` runs integration tests (requires Chrome)
- `deno task ci` runs both — this is the full quality gate
```

**Files to modify:**

- `deno.json` — update `ci` task
- `CLAUDE.md` — document the convention
- `src/cdp/chrome.test.ts` → `tests/integration/chrome.test.ts`
- `src/cdp/connection.test.ts` → `tests/integration/connection.test.ts`
- `src/http/server.test.ts` — remove lines 271-294
- Create `tests/integration/server.test.ts` — two tests extracted from `server.test.ts`

---

## 2. Fix optimistic shutdown

**Problem:** `handleStop` in `src/cli/mod.ts:167-191` sends `POST /shutdown`, then immediately
deletes the PID file and prints "daemon stopped" without confirming the daemon process has actually
exited. A quick `stop && start` sequence can race — the old daemon may still hold the port and be
cleaning up Chrome.

On the server side, `/shutdown` in `src/http/server.ts:175-184` queues `httpServer.shutdown()` via
`queueMicrotask` and returns `{ ok: true }` immediately, before any cleanup runs.

**Shutdown contract (replaces current behavior):**

| `/shutdown` response | Process alive after timeout? | Action                                                | Exit code |
| -------------------- | ---------------------------- | ----------------------------------------------------- | --------- |
| OK                   | No (exited within timeout)   | Remove PID file, print "daemon stopped"               | 0         |
| OK                   | Yes (still alive)            | Print error, **keep PID file**                        | 1         |
| Unreachable          | No (already dead)            | Remove PID file (stale state), print "daemon stopped" | 0         |
| Unreachable          | Yes (still alive)            | Print error, **keep PID file**                        | 1         |

**Safety rule:** Never remove the PID file while the daemon may still be a live, valid process. PID
file cleanup is only safe when liveness is disproven or shutdown is confirmed complete.

**Approach:**

1. **CLI side (`src/cli/mod.ts` → `handleStop`):** After sending `/shutdown` (or discovering the
   daemon is unreachable), poll `deps.isProcessAlive(pf.pid)` with short sleeps (100ms) until the
   process is dead, with a timeout (5s). Behavior depends on the outcome per the table above.

2. **No server-side change needed.** The `/shutdown` endpoint already triggers the full cleanup
   chain (`httpServer.shutdown()` → `httpServer.finished` → close CDP → kill Chrome → remove PID
   file). The fix is purely about the CLI waiting for completion rather than racing ahead.

**`CliDeps` interface change:**

Add `sleep(ms: number): Promise<void>` to `CliDeps` so the polling loop is testable (tests inject an
instant-resolving sleep). `main.ts` wires it to a real `setTimeout`-based delay.

**Files to modify:**

- `src/cli/mod.ts` — `CliDeps` interface (add `sleep`), `handleStop` implementation
- `src/cli/mod.test.ts` — update `stubDeps`, add tests for all four shutdown scenarios
- `src/main.ts` — wire `sleep` in the deps object

---

## 3. Extract `src/fs/` adapter for PID persistence

**Problem:** `main.ts` owns PID file I/O (`readPidFile`, `writePidFile`, `removePidFile`). Per Ben
Johnson's layout, packages are named after the dependency they wrap — JSON file persistence is a
filesystem concern and should live in a dedicated `src/fs/` adapter.

**Scope:** This extraction is specifically about moving generic JSON file persistence out of
`main.ts`. It is not a broader cleanup of all infrastructure. `main.ts` will continue to own
lifecycle orchestration for the concrete system it wires together — that includes daemon
startup/shutdown coordination and child-process lifecycle management (`isProcessAlive`,
`killProcess`, `withTimeout`, `spawnDaemon`). Those stay in `main.ts` because they are
composition-level concerns tied to the specific adapters being wired, not generic persistence.

**Interface:**

```typescript
// src/fs/mod.ts

/** Async filesystem adapter for JSON file persistence. */
export interface JsonFileStore {
  read<T>(path: string): Promise<T | null>;
  write(path: string, data: unknown): Promise<void>;
  remove(path: string): Promise<void>;
}

export function createJsonFileStore(): JsonFileStore;
```

**Behavior:**

- `read` — `Deno.readTextFile` + `JSON.parse`. Returns `null` on missing file. Returns `null` on
  malformed JSON (treats corrupt content as stale/invalid state, consistent with current
  `readPidFile` behavior — does not crash during start/stop).
- `write` — atomic: `Deno.makeTempFile` in the target directory, `Deno.writeTextFile` to temp,
  `Deno.rename` to final path. `Deno.mkdir` with `{ recursive: true }` for the parent directory.
- `remove` — `Deno.remove`, swallows "not found"
- All async, no sync methods

**`main.ts` becomes:**

```typescript
import { createJsonFileStore } from "./fs/mod.ts";

const store = createJsonFileStore();

const deps: CliDeps = {
  readPidFile: () => store.read<PidFile>(PID_PATH),
  writePidFile: (pf) => store.write(PID_PATH, pf),
  removePidFile: () => store.remove(PID_PATH),
  isProcessAlive, // stays in main.ts — process lifecycle, not persistence
  killProcess, // stays in main.ts — process lifecycle, not persistence
  // ...
};
```

**Dependency lint update:** Add `fs` to the adapter list in `scripts/lint-deps-plugin.ts`:
`ADAPTER_MODULES = ["cdp", "aria", "http", "cli", "fs"]`, with `fs: ["domain"]` in
`ALLOWED_IMPORTS`.

**Files to create:**

- `src/fs/mod.ts` — `JsonFileStore` interface + `createJsonFileStore` implementation
- `src/fs/mod.test.ts` — tests using a real temp directory (fast — no Chrome, just temp files)

**Files to modify:**

- `src/main.ts` — remove `readPidFile`/`writePidFile`/`removePidFile`, import from `src/fs/`
- `scripts/lint-deps-plugin.ts` — add `fs` to module lists
- `scripts/lint-deps.test.ts` — add test case for `fs/` boundary if needed

---

## 4. Add daemon E2E smoke test

**Problem:** No test exercises the full public surface: `main.ts` spawning a daemon, the HTTP API
responding, and the CLI stopping it. The most important wiring (composition root) is untested.

**Goal:** A minimal smoke test for composition correctness — verify that main.ts wires all adapters
together and the start/stop lifecycle works. This is not a broad behavioral suite; detailed behavior
is covered by the existing unit and integration tests.

**Approach:** The test uses the CLI (`deno run src/main.ts`) for `start` and `stop` (lifecycle), and
uses HTTP directly (`fetch`) for the middle steps (wiring verification). This is intentional: the
goal is "wiring is correct," not a full CLI black-box suite.

```typescript
// tests/integration/daemon.test.ts

Deno.test("daemon smoke: start, navigate, snapshot, eval, stop", async () => {
  // 1. Start daemon subprocess with HOME pointed at a temp dir and a random port
  //    deno run --allow-all src/main.ts start --port <free-port>
  // 2. Wait for readiness: poll /health (or PID file) with timeout
  // 3. POST /pages { url: fixture-server-url } → verify 200
  // 4. POST /snapshot → assert one small structural marker (e.g. "heading")
  // 5. POST /eval { expression: "document.title" } → assert one small JSON result
  // 6. Run: deno run --allow-all src/main.ts stop
  // 7. Assert the process exits and the PID file is removed
});
```

Uses the existing fixture server from `tests/integration/fixture-server.ts`.

The test uses `HOME` env var set to a temp directory for the subprocess to isolate the PID file from
any real running daemon. This requires no production code changes.

**Files to create:**

- `tests/integration/daemon.test.ts`

**Dependencies:** Depends on #2 (shutdown fix) so the stop-then-verify-dead assertion is reliable.

---

## Implementation Order

Mostly independent. Recommended order:

1. **Extract `src/fs/` adapter** (#3) — no test changes, pure refactor
2. **Fix optimistic shutdown** (#2) — modifies `cli/mod.ts` and its tests
3. **Separate test suites** (#1) — file moves, `deno.json` and `CLAUDE.md` updates
4. **Daemon E2E smoke test** (#4) — depends on #2 for reliable stop assertions

## Verification

After all changes:

```bash
# Fast unit tests — no Chrome required, should complete in under 2 seconds
deno task test

# Integration tests — requires Chrome, exercises real I/O, under 30 seconds
deno task test:integration

# Full quality gate — both suites + lint + fmt + type-check
deno task ci
```
