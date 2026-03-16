# Domain/Application Refactor: Project-Owned Types + App Service Layer

**Date:** 2026-03-15 **Status:** Draft

**Goal:** Clean up the abstraction boundaries without changing the core architecture principles:
`domain/` owns project semantics and application contracts, adapters own external protocol details,
invalid states are encoded out of the type system where practical, and `main.ts` returns to being a
thin composition root.

**Architecture:** Introduce project-owned domain types for browser concepts (`PageId`, `RefToken`,
`DomNodeHandle`, `AccessibilityNode`), move raw CDP protocol shapes behind `cdp/` translation, add a
proper application-layer interface (`ScraperApp`) for the real use cases the CLI invokes, and
implement that interface in a new `app/` orchestration layer. `cli/` depends on the application
interface and output sinks only; `aria/` consumes project-owned accessibility types; `fs/` remains
the persistence adapter; `main.ts` wires the graph. The dependency boundary lint rule is updated so
`app/` is the one orchestration layer allowed to depend on multiple adapters.

**Architectural note:** Introducing `src/app/` is a deliberate exception to the current flat adapter
layout. The reason is not "concept purity" but testable orchestration: the behavior now living in
`main.ts` is large enough that it needs a home that can be unit-tested in isolation. This layer is
tightly scoped to coordination logic only.

**Execution order:** First introduce the new domain-owned types and translation seams without
breaking behavior. Then add the `app/` layer and migrate orchestration from `main.ts`. Next tighten
wait requests into a discriminated union and update CLI parsing to construct only valid requests.
Finally delete obsolete types and compatibility shims once all consumers are migrated.

**Tech Stack:** Deno, TypeScript, CDP via `@simple-cdp/simple-cdp`, custom dependency-boundary lint
plugin in `scripts/lint-deps-plugin.ts`, unit tests in `src/`, integration tests in
`tests/integration/`.

---

## Design Targets

### 1. `domain/` owns project semantics, not Chrome wire types

`src/domain/` should describe the scraper's model of the world, not Chrome's protocol schema. The
primary goal is not hypothetical backend-swappability; it is to stop CDP wire shapes and Chrome
naming from leaking into domain contracts. If a backend swap ever happens later, that is a side
benefit, not the justification for this refactor.

Concretely:

- Replace `AXNode`/`AXValue` in `src/domain/ax.ts` with project-owned accessibility types.
- Replace protocol-flavored primitives like `targetId` and `backendDOMNodeId` with named
  project-owned concepts.
- Keep runtime representations simple so persistence and serialization stay easy.

Initial target shapes:

```typescript
// src/domain/page.ts
export type PageId = string;

export interface PageInfo {
  id: PageId;
  url: string;
  title: string;
  active: boolean;
}

// src/domain/snapshot.ts
export type RefToken = string;
export type DomNodeHandle = number;

export type RefMap = Record<RefToken, DomNodeHandle>;

// src/domain/accessibility.ts
export interface AccessibilityValue {
  kind: string;
  value?: string | number | boolean;
}

export interface AccessibilityProperty {
  name: string;
  value: AccessibilityValue;
}

export interface AccessibilityNode {
  id: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: AccessibilityValue;
  name?: AccessibilityValue;
  properties?: AccessibilityProperty[];
  domNode?: DomNodeHandle;
}
```

These remain project-owned even if the first implementation is a near 1:1 translation from CDP.
`PageId = string` and `DomNodeHandle = number` are boundary-ownership and naming improvements, not
nominal type-safety by themselves.

### 2. The real use-case boundary becomes explicit

The current codebase's actual application contract is the `CliDeps` function bag, while the domain
interfaces (`BrowserService`, `SnapshotService`) are too narrow to represent the actual behavior of
the system. The fix is to promote a proper application-facing interface and implement it outside the
CLI.

Target:

```typescript
// src/domain/app.ts
export interface ScraperApp {
  start(options: StartOptions): Promise<StartResult>;
  stop(): Promise<void>;
  pages(): Promise<PageInfo[]>;
  selectPage(pageId: PageId): Promise<void>;
  navigate(url: string, options?: ActionOptions): Promise<ActionResult>;
  snapshot(options: SnapshotOptions): Promise<SnapshotResult>;
  evaluate(expression: string): Promise<EvalResult>;
  screenshot(fullPage?: boolean): Promise<string>;
  click(target: ElementTarget, options?: ActionOptions): Promise<ActionResult>;
  fill(target: ElementTarget, value: string, options?: ActionOptions): Promise<ActionResult>;
  type(target: ElementTarget, text: string, options?: ActionOptions): Promise<ActionResult>;
  selectOption(
    target: ElementTarget,
    value: string,
    options?: ActionOptions,
  ): Promise<ActionResult>;
  submit(target: ElementTarget, options?: ActionOptions): Promise<ActionResult>;
  pressKey(
    key: string,
    target?: ElementTarget,
    options?: ActionOptions,
  ): Promise<ActionResult>;
  upload(
    target: ElementTarget,
    filePath: string,
    options?: ActionOptions,
  ): Promise<ActionResult>;
  wait(request: WaitRequest): Promise<void>;
}
```

This makes the CLI a thin adapter over application use cases instead of the place where the system
contract is implicitly defined.

### 3. Invalid wait combinations become unrepresentable

`WaitOptions` currently relies on comments and downstream checks to define valid combinations. The
domain contract should encode valid requests directly.

Target:

```typescript
export type WaitRequest =
  | { kind: "selector"; selector: string; timeoutMs?: number }
  | { kind: "text"; text: string; timeoutMs?: number }
  | { kind: "text_in_target"; target: ElementTarget; text: string; timeoutMs?: number };
```

This removes cases like `{ target: { ref } }` without text from the domain entirely.

### 4. Dead abstractions are removed, not preserved

Request DTOs that are not used (`EvalRequest`, `NavigateRequest`) and placeholder service interfaces
that no longer represent the system (`BrowserService`, `SnapshotService`) should be deleted once the
new application contract is live.

---

## Task 1: Introduce project-owned domain types

Add the types the project wants to own before changing behavior.

**Files:**

- Create: `src/domain/accessibility.ts`
- Modify: `src/domain/page.ts`
- Modify: `src/domain/snapshot.ts`
- Modify: `src/domain/mod.ts`
- Modify: all direct consumers of renamed types

**Step 1: Add the new named types**

Add:

- `PageId` in `src/domain/page.ts`
- `RefToken` and `DomNodeHandle` in `src/domain/snapshot.ts`
- `AccessibilityNode`, `AccessibilityValue`, and `AccessibilityProperty` in
  `src/domain/accessibility.ts`

Keep the representations simple aliases or plain objects. Do not introduce branded opaque types in
this pass.

**Step 2: Rename domain contracts to use project-owned names**

Update domain-facing APIs to use:

- `PageInfo.id: PageId` instead of `targetId: string`
- `RefMap = Record<RefToken, DomNodeHandle>`
- accessibility tree APIs in terms of `AccessibilityNode[]`

This is a semantic ownership change first. The runtime values can remain identical to the current
CDP-derived values.

**Step 3: Update public exports**

Update `src/domain/mod.ts` so it exports the new project-owned types and stops exporting protocol
shapes.

**Acceptance criteria**

- `src/domain/` no longer exports `AXNode` or `AXValue`.
- Domain consumers compile using `PageId`, `RefToken`, `DomNodeHandle`, and `AccessibilityNode`.

---

## Task 2: Move raw CDP protocol types and translation into `cdp/`

The CDP adapter should own Chrome-specific schemas and translate them to domain types.

**Files:**

- Create: `src/cdp/protocol.ts` or `src/cdp/ax.ts`
- Modify: `src/cdp/connection.ts`
- Modify: `src/aria/tree.ts`
- Modify: `src/aria/snapshot.ts`
- Modify: related tests in `src/aria/*.test.ts` and `tests/integration/`

**Step 1: Move raw protocol types out of domain**

Create a CDP-local module for raw accessibility response shapes:

```typescript
export interface CdpAXValue {
  type: string;
  value?: string | number | boolean;
}

export interface CdpAXNode {
  nodeId: string;
  ignored?: boolean;
  role?: CdpAXValue;
  name?: CdpAXValue;
  properties?: Array<{ name: string; value: CdpAXValue }>;
  childIds?: string[];
  backendDOMNodeId?: number;
  parentId?: string;
}
```

`connection.ts` returns these raw shapes internally, not from the domain.

**Step 2: Add a translation seam**

Create a small translator in `cdp/` from `CdpAXNode` to `AccessibilityNode`. Keep it mechanical. The
translator should be the only place that knows:

- `nodeId` maps to `AccessibilityNode.id`
- `backendDOMNodeId` maps to `domNode`
- raw property/value shapes map to the domain-owned accessibility model

**Step 3: Update the ARIA adapter**

Change `aria/` to consume `AccessibilityNode[]` instead of CDP wire types. The transform logic can
stay structurally similar; the important change is ownership of the input model.

**Acceptance criteria**

- Raw CDP accessibility types live only in `cdp/`.
- `aria/` depends only on domain-owned accessibility types.
- Tests continue to cover transformation behavior without Chrome.

---

## Task 3: Add the application-layer interface in `domain/`

Define the real use-case contract the rest of the program relies on.

**Files:**

- Create: `src/domain/app.ts`
- Modify: `src/domain/mod.ts`
- Modify: `src/cli/mod.ts`
- Modify: any tests that currently stub `CliDeps`

**Step 1: Add `ScraperApp` and supporting types**

Move or add these types under `domain/`:

- `StartOptions`
- `StartResult`
- `WaitRequest`
- `ScraperApp`

`StartOptions` and `StartResult` currently live in `cli/` but they describe application behavior,
not CLI parsing.

Add `WaitRequest` here as part of the application contract so `ScraperApp.wait()` does not depend on
a type introduced later in the plan. Task 5 will complete the migration from `WaitOptions` to
`WaitRequest` across all call sites.

**Step 2: Narrow the CLI boundary**

Replace the current `CliDeps` function bag with a smaller adapter contract:

```typescript
export interface CliDeps {
  app: ScraperApp;
  stdout(s: string): void;
  stderr(s: string): void;
}
```

The CLI remains responsible for parsing and formatting only.

**Step 3: Update CLI tests**

CLI tests should stub a single `app` object instead of building a large flat dependency bag.

**Acceptance criteria**

- The CLI depends on `ScraperApp`.
- Start types live in `domain/`, not `cli/`.
- The use-case surface is explicitly documented in one place.

---

## Task 4: Create `src/app/` as the orchestration layer

Move the real system behavior out of `main.ts` into an application implementation.

**Files:**

- Create: `src/app/mod.ts`
- Create: `src/app/service.ts` (or similar)
- Modify: `src/main.ts`
- Modify: `scripts/lint-deps-plugin.ts`
- Modify: `scripts/lint-deps.test.ts`

**Step 1: Add an `app/` module to the dependency-boundary rules**

Update the lint plugin so:

- `domain/` still depends on nothing internal
- `cdp/`, `aria/`, `cli/`, and `fs/` still depend only on `domain/`
- `app/` may depend on `domain/`, `cdp/`, `aria/`, and `fs/`
- `main.ts` remains the composition root

This preserves the architectural principles while giving orchestration a real home.

**Scope of `app/`**

Allowed responsibilities:

- session resolution and ownership checks
- page selection and state validation
- ref persistence lifecycle
- dialog policy orchestration
- post-action wait/snapshot pipeline
- coordination of adapter calls needed to implement `ScraperApp`

Explicitly not allowed:

- CLI parsing or terminal formatting
- raw CDP protocol types or low-level transport code
- generic utility dumping ground behavior
- rendering or ARIA formatting concerns

This keeps `app/` as a narrow orchestration layer, not a second catch-all core.

**Step 1.5: Sketch `createScraperApp(deps)` before implementation**

Before moving code, lock in the construction shape. The exact names may vary, but the dependency
shape should be explicit and reviewable:

```typescript
export interface ScraperAppDeps {
  stateStore: JsonFileStore<ChromeState>;
  refsStore: JsonFileStore<RefMap>;
  launchChrome: typeof launchChrome;
  discoverWsUrl: typeof discoverWsUrl;
  readDevToolsActivePort: typeof readDevToolsActivePort;
  createBrowserConnection: typeof createBrowserConnection;
  createPageConnection: typeof createPageConnection;
  createSnapshotService: typeof createSnapshotService;
  defaultUserDataDir: typeof defaultUserDataDir;
  resolveTarget: typeof resolveTarget;
  now?: () => number;
}

export function createScraperApp(deps: ScraperAppDeps): ScraperApp;
```

This step is the design check for whether `app/` actually simplifies the code. If the dependency
list becomes obviously incoherent or forces `app/` to know too many low-level details, stop and
revise before continuing.

**Step 2: Move orchestration from `main.ts` into `app/`**

Move these concerns into the `ScraperApp` implementation:

- Chrome session resolution and state validation
- page selection logic
- ref persistence
- post-action waiting
- dialog handling policy
- per-command action execution wrappers

`main.ts` should retain only:

- environment-derived paths and top-level constants
- dependency construction
- `runCli(Deno.args, deps)`

**Step 3: Keep CDP/ARIA/FS as implementation details**

The `app/` layer should depend on adapter interfaces or factories as needed, but callers should see
only `ScraperApp`.

**Acceptance criteria**

- `main.ts` is substantially reduced and acts as a composition root.
- The orchestration logic lives in `app/`.
- `app/` is the only internal layer allowed to coordinate multiple adapters.

---

## Task 5: Replace `WaitOptions` usage with `WaitRequest` end-to-end

Tighten the wait contract so invalid states are not expressible.

**Files:**

- Modify: `src/domain/action.ts`
- Modify: `src/domain/mod.ts`
- Modify: `src/cli/mod.ts`
- Modify: application-layer wait execution
- Modify: tests covering wait parsing and wait behavior

**Step 1: Replace `WaitOptions` with `WaitRequest` in domain and consumers**

Replace:

```typescript
export interface WaitOptions {
  target?: ElementTarget;
  text?: string;
  timeoutMs?: number;
}
```

with a discriminated union:

```typescript
export type WaitRequest =
  | { kind: "selector"; selector: string; timeoutMs?: number }
  | { kind: "text"; text: string; timeoutMs?: number }
  | { kind: "text_in_target"; target: ElementTarget; text: string; timeoutMs?: number };
```

`WaitRequest` is introduced in Task 3 as part of the application contract. This task completes the
replacement by removing `WaitOptions` from domain exports and updating all consumers.

**Step 2: Make CLI parsing construct a valid request**

The CLI wait handler should parse flags and construct exactly one valid variant. It should stop
passing partially validated optional fields deeper into the system.

**Step 3: Simplify application-side branching**

The application implementation should branch on `request.kind`, not on combinations of nullable
fields.

**Acceptance criteria**

- Invalid wait combinations are not representable in the domain type.
- The application layer no longer contains branches like `"ref" in target` with special-case error
  handling for invalid wait requests.

---

## Task 6: Remove dead code and obsolete interfaces

Delete types that no longer add value once the new abstractions are in place.

**Files:**

- Modify: `src/domain/eval.ts`
- Modify: `src/domain/page.ts`
- Modify: `src/domain/browser.ts`
- Modify: `src/domain/mod.ts`
- Modify: consumers and tests

**Step 1: Remove unused request DTOs**

Delete `EvalRequest` and `NavigateRequest` unless a concrete consumer is introduced during the app
service refactor. Do not preserve them as speculative abstractions.

**Step 2: Remove superseded service interfaces**

Delete `BrowserService` and `SnapshotService` if `ScraperApp` and the new internal ports fully
replace them. If any adapter still needs an internal interface, keep it local to the layer that
actually consumes it.

The important distinction is:

- delete misleading domain-level placeholder interfaces that no longer describe the system
- keep useful local injection seams such as `SnapshotDeps` inside `aria/`

This refactor should remove fake abstraction boundaries, not eliminate adapter-local dependency
injection where it is still useful.

**Step 3: Clean up type import hacks and transitional aliases**

Examples:

- inline type-only import expressions in `cli/`
- compatibility aliases kept during migration
- domain exports that exist only to support the pre-refactor structure

**Acceptance criteria**

- `src/domain/` contains only live, project-owned contracts and models.
- No unused request DTOs remain.
- No placeholder service abstractions remain in the domain.

---

## Task 7: Verification strategy

This refactor changes contracts more than behavior. Verification should focus on preserving
behavioral semantics while tightening boundaries.

**Step 1: Keep tests green incrementally**

Run after each task group:

```bash
deno task test
deno task test:integration
```

Run full quality gate before completion:

```bash
deno task ci
```

**Step 2: Add focused tests for new boundaries**

Add or update tests for:

- domain wait request construction and exhaustiveness
- CLI wait parsing into `WaitRequest`
- `ScraperApp` stubs in CLI tests
- accessibility translation from CDP wire types to domain types
- dependency-boundary lint behavior for the new `app/` layer

**Step 3: Review migration leftovers**

Before closing the refactor, verify:

- no CDP wire types are re-exported from `domain/`
- `main.ts` is composition-only
- CLI tests stub `ScraperApp`, not low-level implementation details
- no dead compatibility types remain

---

## Suggested commit structure

Keep the refactor incremental. Recommended commit sequence:

1. `refactor: introduce project-owned domain ids and accessibility types`
2. `refactor: move raw cdp accessibility types behind adapter translation`
3. `refactor: add scraper application interface`
4. `refactor: introduce app orchestration layer`
5. `refactor: encode wait requests as discriminated union`
6. `refactor: remove obsolete domain request and service types`

This sequence keeps the codebase runnable between steps and avoids a single large boundary rewrite.
