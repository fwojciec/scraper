# Project Setup Implementation Plan

> **STATUS: EXECUTED.** This plan has been implemented. The architecture was subsequently
> simplified: `app/` layer was removed; `domain/` became the functional core (types + pure
> functions); all adapters import only from `domain/` with uniform rules. See the design doc and
> CLAUDE.md for current architecture.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task.

**Goal:** Scaffold the scraper project with Deno config, directory structure, dependency lint
enforcement, CLAUDE.md, and a GitHub repo.

**Architecture:** Deno 2.x project following functional core / imperative shell. Domain is the
functional core (pure types, interfaces, pure functions). Adapters are the imperative shell, each
named after the dependency they wrap. Composition root wires them. Dependency boundaries enforced by
a `deno info --json` based lint script.

**Tech Stack:** Deno 2.7+, TypeScript, `@simple-cdp/simple-cdp` (JSR)

---

### Task 1: Initialize git repo and deno.json

**Files:**

- Create: `deno.json`
- Create: `.gitignore`

**Step 1: Initialize git**

```bash
cd /Users/filip/code/deno/scraper && git init
```

**Step 2: Create .gitignore**

Create `/Users/filip/code/deno/scraper/.gitignore`:

```
# Deno
.deno/

# OS
.DS_Store

# Editor
.vscode/
.idea/

# Runtime
~/.scraper/

# Temp
tmp/
*.png
```

**Step 3: Create deno.json**

Create `/Users/filip/code/deno/scraper/deno.json`:

```json
{
  "name": "@fwojciec/scraper",
  "version": "0.1.0",
  "imports": {
    "@simple-cdp/simple-cdp": "jsr:@simple-cdp/simple-cdp@^1.8",
    "@b-fuze/deno-dom": "jsr:@b-fuze/deno-dom@^0.1",
    "@std/assert": "jsr:@std/assert@^1"
  },
  "tasks": {
    "dev": "deno run --allow-net --allow-read --allow-write --allow-env --allow-run src/main.ts",
    "test": "deno test --allow-net --allow-read --allow-env src/",
    "test:integration": "deno test --allow-all tests/integration/",
    "lint": "deno lint",
    "fmt": "deno fmt",
    "check": "deno check src/**/*.ts",
    "lint:deps": "deno run --allow-run --allow-read scripts/lint-deps.ts",
    "ci": "deno fmt --check && deno lint && deno task check && deno task lint:deps && deno task test"
  },
  "fmt": {
    "lineWidth": 100
  },
  "compilerOptions": {
    "strict": true
  }
}
```

**Step 4: Verify deno.json is valid**

Run: `cd /Users/filip/code/deno/scraper && deno fmt --check deno.json` Expected: no errors (or
auto-format if needed)

**Step 5: Commit**

```bash
cd /Users/filip/code/deno/scraper && git add deno.json .gitignore && git commit -m "chore: initialize deno project with config and gitignore"
```

---

### Task 2: Create domain types

**Files:**

- Create: `src/domain/page.ts`
- Create: `src/domain/eval.ts`
- Create: `src/domain/browser.ts`
- Create: `src/domain/snapshot.ts`
- Create: `src/domain/mod.ts`

**Step 1: Create src/domain/page.ts**

```ts
/** A named browser page managed by the daemon. */
export interface Page {
  name: string;
  url: string;
  targetId: string;
}

/** Request to navigate a named page to a URL. */
export interface NavigateRequest {
  name?: string;
  url: string;
}

/** Info returned about a page after navigation. */
export interface PageInfo {
  name: string;
  url: string;
  targetId: string;
}
```

**Step 2: Create src/domain/eval.ts**

```ts
/** Request to evaluate a JS expression in a page's browser context. */
export interface EvalRequest {
  name?: string;
  expression: string;
}

/** Result of evaluating a JS expression. */
export interface EvalResult {
  result: unknown;
}
```

**Step 3: Create src/domain/snapshot.ts**

```ts
/** Options for generating an ARIA snapshot. */
export interface SnapshotOptions {
  name?: string;
  maxDepth?: number;
  maxNodes?: number;
  selector?: string;
}

/** Result of generating an ARIA snapshot. */
export interface SnapshotResult {
  yaml: string;
}
```

**Step 4: Create src/domain/browser.ts**

```ts
import type { EvalRequest, EvalResult } from "./eval.ts";
import type { NavigateRequest, PageInfo } from "./page.ts";
import type { SnapshotOptions, SnapshotResult } from "./snapshot.ts";

/** Interface for browser control operations. Implemented by cdp/ adapter. */
export interface BrowserService {
  navigate(req: NavigateRequest): Promise<PageInfo>;
  evaluate(req: EvalRequest): Promise<EvalResult>;
  screenshot(name: string, fullPage?: boolean): Promise<string>;
  listPages(): Promise<PageInfo[]>;
  closePage(name: string): Promise<void>;
}

/** Interface for page snapshot generation. Implemented by aria/ adapter. */
export interface SnapshotService {
  snapshot(
    options: SnapshotOptions,
    evaluateInPage: (expression: string) => Promise<unknown>,
  ): Promise<SnapshotResult>;
}
```

**Step 5: Create src/domain/mod.ts**

```ts
export type { EvalRequest, EvalResult } from "./eval.ts";
export type { NavigateRequest, Page, PageInfo } from "./page.ts";
export type { SnapshotOptions, SnapshotResult } from "./snapshot.ts";
export type { BrowserService, SnapshotService } from "./browser.ts";
```

**Step 6: Type-check**

Run: `cd /Users/filip/code/deno/scraper && deno check src/domain/mod.ts` Expected: no errors

**Step 7: Commit**

```bash
cd /Users/filip/code/deno/scraper && git add src/domain/ && git commit -m "feat: add domain types and interfaces"
```

---

### Task 3: Create directory structure with placeholder mod.ts files

**Files:**

- Create: `src/cdp/mod.ts`
- Create: `src/aria/mod.ts`
- Create: `src/http/mod.ts`
- Create: `src/cli/mod.ts`
- Create: `src/main.ts`
- Create: `tests/integration/.gitkeep`
- Create: `scripts/.gitkeep`

**Step 1: Create placeholder barrel files**

Each `mod.ts` is an empty barrel for now — adapters will export their implementations as we build
them.

Create `src/cdp/mod.ts`:

```ts
// Adapter: Chrome DevTools Protocol. Implements BrowserService.
```

Create `src/aria/mod.ts`:

```ts
// Adapter: DOM Accessibility API. Implements SnapshotService.
```

Create `src/http/mod.ts`:

```ts
// Adapter: Deno.serve HTTP server. Delegates to domain functions via injected deps.
```

Create `src/cli/mod.ts`:

```ts
// Adapter: CLI (Deno.args). Stateless HTTP client to daemon.
```

Create `src/main.ts`:

```ts
// Composition root: wires adapters -> domain.
// `scraper start` launches daemon, all other commands are CLI client.
```

**Step 2: Create test and script directories**

```bash
cd /Users/filip/code/deno/scraper && mkdir -p tests/integration/fixtures scripts && touch tests/integration/.gitkeep scripts/.gitkeep
```

**Step 3: Commit**

```bash
cd /Users/filip/code/deno/scraper && git add src/ tests/ scripts/ && git commit -m "chore: scaffold directory structure with placeholder modules"
```

---

### Task 4: Create dependency lint script

> **Note:** The code below is the original plan version which included `app/` rules and only
> analyzed `mod.ts` graphs. The actual script was updated to remove `app/`, scan all `.ts` files in
> each module directory, and independently check stray files in `src/` root.

**Files:**

- Create: `scripts/lint-deps.ts`

**Step 1: Write the lint script**

Create `/Users/filip/code/deno/scraper/scripts/lint-deps.ts`:

```ts
/**
 * Dependency boundary enforcement using `deno info --json`.
 *
 * Rules:
 * - domain/ may import nothing from src/
 * - app/ may import only from domain/
 * - cdp/ may import only from domain/
 * - aria/ may import only from domain/
 * - http/ may import from domain/ and app/
 * - cli/ may import only from domain/
 * - Only main.ts may import from all modules
 */

const SRC_MODULES = ["domain", "app", "cdp", "aria", "http", "cli"] as const;

type Module = (typeof SRC_MODULES)[number];

const ALLOWED_IMPORTS: Record<Module, readonly Module[]> = {
  domain: [],
  app: ["domain"],
  cdp: ["domain"],
  aria: ["domain"],
  http: ["domain", "app"],
  cli: ["domain"],
};

interface DenoInfoOutput {
  modules: Array<{
    specifier: string;
    dependencies?: Array<{
      specifier: string;
      code?: { specifier: string };
      type?: { specifier: string };
    }>;
  }>;
}

function getModule(specifier: string): Module | null {
  for (const mod of SRC_MODULES) {
    if (specifier.includes(`/src/${mod}/`)) return mod;
  }
  return null;
}

async function checkModule(mod: Module): Promise<string[]> {
  const entryPoint = `src/${mod}/mod.ts`;

  try {
    await Deno.stat(entryPoint);
  } catch {
    return []; // Module doesn't exist yet, skip
  }

  const cmd = new Deno.Command("deno", {
    args: ["info", "--json", entryPoint],
    stdout: "piped",
    stderr: "piped",
  });

  const { stdout, stderr, success } = await cmd.output();

  if (!success) {
    const err = new TextDecoder().decode(stderr);
    // Empty modules are fine
    if (err.includes("Module not found") || err.includes("No modules")) return [];
    return [`Failed to analyze ${entryPoint}: ${err}`];
  }

  const info: DenoInfoOutput = JSON.parse(new TextDecoder().decode(stdout));
  const violations: string[] = [];
  const allowed = ALLOWED_IMPORTS[mod];

  for (const module of info.modules) {
    const sourceModule = getModule(module.specifier);
    if (sourceModule !== mod) continue; // Only check files in this module

    for (const dep of module.dependencies ?? []) {
      const depSpec = dep.code?.specifier ?? dep.specifier;
      const depModule = getModule(depSpec);

      if (depModule === null) continue; // External dependency, ok
      if (depModule === mod) continue; // Self-import, ok
      if (allowed.includes(depModule)) continue; // Allowed import

      violations.push(
        `${mod}/ imports from ${depModule}/ (${module.specifier} -> ${depSpec}). ` +
          `Allowed: [${allowed.join(", ")}]`,
      );
    }
  }

  return violations;
}

async function main(): Promise<void> {
  console.log("Checking dependency boundaries...\n");

  const allViolations: string[] = [];

  for (const mod of SRC_MODULES) {
    const violations = await checkModule(mod);
    if (violations.length > 0) {
      allViolations.push(...violations);
    } else {
      console.log(`  ✓ ${mod}/`);
    }
  }

  if (allViolations.length > 0) {
    console.error("\nDependency boundary violations:\n");
    for (const v of allViolations) {
      console.error(`  ✗ ${v}`);
    }
    Deno.exit(1);
  }

  console.log("\nAll dependency boundaries OK.");
}

main();
```

**Step 2: Run the lint script**

Run: `cd /Users/filip/code/deno/scraper && deno run --allow-run --allow-read scripts/lint-deps.ts`
Expected: All modules pass (they're empty placeholders)

**Step 3: Commit**

```bash
cd /Users/filip/code/deno/scraper && git add scripts/lint-deps.ts && git commit -m "feat: add dependency boundary enforcement via deno info"
```

---

### Task 5: Write the failing test for lint:deps

Verify the lint script actually catches violations.

**Files:**

- Create: `scripts/lint-deps.test.ts`

**Step 1: Write the test**

Create `/Users/filip/code/deno/scraper/scripts/lint-deps.test.ts`:

```ts
import { assertEquals } from "@std/assert";

Deno.test("lint:deps catches no violations on clean project", async () => {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-run", "--allow-read", "scripts/lint-deps.ts"],
    stdout: "piped",
    stderr: "piped",
  });
  const { success } = await cmd.output();
  assertEquals(success, true);
});
```

**Step 2: Run the test**

Run:
`cd /Users/filip/code/deno/scraper && deno test --allow-run --allow-read scripts/lint-deps.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
cd /Users/filip/code/deno/scraper && git add scripts/lint-deps.test.ts && git commit -m "test: add lint:deps smoke test"
```

---

### Task 6: Create CLAUDE.md

> **Note:** The CLAUDE.md content below is the original plan version which included `app/` layer
> rules. The actual CLAUDE.md was updated to reflect the simplified architecture (no `app/`, all
> adapters import only from `domain/`).

**Files:**

- Create: `CLAUDE.md`

**Step 1: Write CLAUDE.md**

Create `/Users/filip/code/deno/scraper/CLAUDE.md`:

```markdown
# Scraper

Intelligent web scraping CLI for LLM agents. Uses CDP to control headless Chrome, ARIA snapshots for
compact page representation, JS eval for surgical data extraction.

## Architecture

Ben Johnson's standard package layout adapted for TypeScript/Deno.

### Dependency rule (NEVER violate)

- `src/domain/` imports NOTHING from this project. Zero imports. Pure types and interfaces.
- `src/app/` imports ONLY from `domain/`.
- Adapter packages (`cdp/`, `aria/`, `http/`, `cli/`) import from `domain/` and (for `http/`)
  `app/`.
- Adapters NEVER import from other adapters.
- `src/main.ts` imports from adapters and wires everything together.
- `cli/` is a stateless HTTP client — it talks to the daemon via fetch, never imports `app/`.

Enforced by `deno task lint:deps` using `deno info --json`. Violations are build failures.

### File patterns

- Domain types: `src/domain/<concept>.ts` — pure interfaces and type aliases
- Use cases: `src/app/<verb>-<noun>.ts` exporting `create<VerbNoun>UseCase(deps)`
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
```

**Step 2: Commit**

```bash
cd /Users/filip/code/deno/scraper && git add CLAUDE.md && git commit -m "docs: add CLAUDE.md with architecture rules"
```

---

### Task 7: Move design doc into the repo and commit

**Step 1: Stage the design doc**

The design doc already exists at `docs/plans/2026-02-26-intelligent-scraper-mvp-design.md`.

```bash
cd /Users/filip/code/deno/scraper && git add docs/ && git commit -m "docs: add MVP design document"
```

---

### Task 8: Create GitHub repo and push

**Step 1: Create the repo**

```bash
cd /Users/filip/code/deno/scraper && gh repo create fwojciec/scraper --public --source . --push --description "Intelligent web scraping CLI for LLM agents"
```

**Step 2: Verify**

Run: `gh repo view fwojciec/scraper --json url` Expected: shows the repo URL

---

### Task 9: Verify full CI pipeline passes

**Step 1: Run the CI task**

Run: `cd /Users/filip/code/deno/scraper && deno task ci` Expected: all checks pass (fmt, lint,
check, lint:deps, test)

**Step 2: Fix any issues and commit**

If anything fails, fix it and commit the fix.
