# Browser Automation: Input Commands + Attach Mode

**Date:** 2026-03-14 **Status:** Draft (revision 4)

## Problem

The scraper is read-only — it can navigate, snapshot, eval, and screenshot, but can't interact with
pages. Real browser automation (filling insurance forms, extracting data from authenticated
dashboards) requires clicking, typing, uploading files, and connecting to the user's existing
browser session.

## Scope and Limitations (v1)

**In scope:**

- Element actions (click, fill, type, select, submit, upload)
- Keyboard input (press_key)
- Dialog handling as part of actions (--on-dialog flag)
- Page/tab management (list, switch)
- Attach to existing Chrome session
- Snapshot-ref-based and CSS-selector-based element targeting
- Post-action network idle waiting
- Ref persistence across CLI invocations

**Out of scope for v1 (eval is the escape hatch):**

- **Frames and iframes.** Embedded auth/payment/vendor widgets are common but add significant
  complexity (frame tree traversal, cross-origin restrictions, frame-scoped CDP sessions). When a
  target element is inside an iframe, use `eval` with `contentDocument` access for same-origin
  frames. Cross-origin iframes are not addressable from page JS — these require explicit
  `Target.attachToTarget` for the iframe's target, which we defer.
- **Shadow DOM.** Open shadow roots are queryable via `eval` using `element.shadowRoot`. Closed
  shadow roots are not accessible from JS at all. CDP's `DOM.describeNode` can pierce shadow roots,
  but integrating this with our element resolution adds complexity we defer.
- **Drag and drop.** Niche interaction pattern. Use `eval` to dispatch custom DragEvent sequences.
- **Network interception / request modification.**
- **Cookie / storage manipulation** (use eval + `document.cookie` or `localStorage` API).
- **Standalone dialog command.** See "Dialog Handling" section for why.

---

## Architectural Changes

### 1. Snapshot Pipeline Redesign

This is the largest change in this design. The current snapshot pipeline produces refs that are
fiction — sequential counters with no connection to real DOM nodes. Making refs the primary control
surface for actions requires a fundamentally different pipeline.

#### Current pipeline (being replaced)

```
evaluateInPage("outerHTML")  →  deno-dom parse  →  buildAriaTree(DomElement)  →  renderYaml
                                                          ↑
                                                  refs = sequential counters
                                                  no connection to live DOM
```

- `snapshot.ts` calls `evaluateInPage` to get `outerHTML` as a string
- Parses HTML server-side with `deno-dom` (`DOMParser`)
- `tree.ts` walks deno-dom elements via `DomElement` interface
- Assigns `ref=eN` to interactable elements (sequential counter)
- `render.ts` formats `AriaNode[]` to YAML

**Problem:** refs are meaningless outside the snapshot. `e5` means "5th interactable element in
traversal order" but there's no way to resolve `e5` back to a real DOM node for clicking/filling.
The outerHTML copy also misses JS-generated content and dynamic state.

#### New pipeline

```
CDP Accessibility.getFullAXTree()  →  transformAXTree  →  renderYaml
         ↑                                   ↓
   each AXNode has                    AriaNode[] with refs
   backendDOMNodeId                   + Record<ref, backendDOMNodeId>
                                                ↓
                                      persisted to ~/.scraper/refs.json
```

- `snapshot.ts` calls `Accessibility.getFullAXTree()` via a new CDP dependency
- `tree.ts` transforms Chrome's `AXNode[]` → our `AriaNode[]` format
  - Filters ignored/invisible nodes
  - Extracts role, name, level from AX properties
  - Assigns `ref=eN` to interactable nodes
  - Records `ref → backendDOMNodeId` mapping as it goes
- `render.ts` is unchanged — still formats `AriaNode[]` to YAML
- Returns `{ yaml, refs }` where refs is the mapping
- **Refs are persisted to disk** so subsequent CLI invocations can resolve them

**Why CDP Accessibility tree, not in-page script or DOM walking:**

| Approach                          | Correctness                              | Ref resolution                           | Testability                                            | Complexity                                        |
| --------------------------------- | ---------------------------------------- | ---------------------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| CDP `Accessibility.getFullAXTree` | Chrome is the authority on accessibility | `backendDOMNodeId` is free               | Transform layer is unit-testable with mock AXNode data | Medium — new CDP domain, new transformer          |
| In-page JS script                 | Same as current (approximation)          | Store elements in `window.__scraperRefs` | Script is testable in deno-dom                         | Medium — must serialize/deserialize, page globals |
| CDP `DOM.getDocument(depth:-1)`   | Same as current (our computation)        | `backendNodeId` is free                  | Transformer testable with mock data                    | High — many CDP calls, rewrite tree builder       |

**The CDP Accessibility approach wins because:**

1. **Chrome is correct.** Our `tree.ts` is a 280-line approximation of what Chrome computes
   natively. When they disagree — on computed roles, name calculation, visibility — Chrome is right.
   Using Chrome's tree eliminates a category of bugs.
2. **backendDOMNodeId comes free.** Every AXNode has it. No hacks, no page globals, no parallel
   walkers that must stay in sync.
3. **Dynamic content is captured.** The outerHTML pipeline misses JS-injected content, CSS-driven
   visibility, ARIA attributes set via JS, and content inside web components. Chrome's AX tree
   reflects the live computed state.
4. **The transform layer is unit-testable.** Given mock `AXNode[]` input, verify `AriaNode[]`
   output. No Chrome needed for unit tests.
5. **deno-dom drops from production.** Becomes a dev/test-only dependency.

**What changes in the codebase:**

- `src/aria/tree.ts` — rewrite. New input type (`AXNode[]` from CDP), same output type
  (`AriaNode[]`). The `DomElement` interface, `getImplicitRole`, `getAccessibleName`, `isHidden` all
  go away — Chrome handles these. The transformer maps AX roles/names/properties to our `AriaNode`
  format and assigns refs.
- `src/aria/snapshot.ts` — rewrite. No longer calls `evaluateInPage("outerHTML")`. Instead receives
  AX tree data via a new dependency. No longer imports deno-dom.
- `src/aria/render.ts` — unchanged. Still renders `AriaNode[]` to YAML.
- `src/domain/snapshot.ts` — `SnapshotResult` gains `refs` field.
- `src/domain/browser.ts` — `SnapshotService` interface changes (new dependency shape).
- Existing tree/snapshot unit tests — rewrite to test transformer with mock AXNode data.

#### AXNode → AriaNode transform rules

Chrome's AXNode has:

```
{ nodeId, ignored, role: {value}, name: {value}, properties: [{name, value}],
  childIds, backendDOMNodeId }
```

Transform:

- **Skip** nodes where `ignored: true`
- **role** = `axNode.role.value` (Chrome uses same ARIA role vocabulary)
- **name** = `axNode.name.value` (if non-empty)
- **level** = from `properties` array (name: "level", value.value: N)
- **ref** = assigned to interactable roles (same set: link, button, textbox, checkbox, radio,
  combobox), recording `ref → backendDOMNodeId`
- **children** = recursively transform `childIds`

The `maxDepth` and `maxNodes` options apply during transform, same as current.

The `selector` option: `Accessibility.getFullAXTree` doesn't support CSS selectors natively. To
scope to a subtree: first resolve the selector to a `backendNodeId` via `Runtime.evaluate` +
`DOM.describeNode`, then pass it to `Accessibility.getFullAXTree`'s optional `root` parameter (which
accepts a backendNodeId). If the `root` parameter isn't supported in our target Chrome versions,
fall back to getting the full tree and pruning.

### 2. Ref Persistence Across Processes

The scraper is one-process-per-command. `scraper snapshot` runs, builds a RefMap, exits.
`scraper click --ref e5` runs in a new process. The RefMap must be persisted to disk.

#### Storage

Refs are stored in `~/.scraper/refs.json`, separate from the connection state in
`~/.scraper/chrome.json`. Rationale: refs change on every snapshot; connection state changes rarely.
Separate files avoid rewriting connection state on every snapshot.

```json
{
  "e1": 42,
  "e2": 87,
  "e3": 123,
  "e5": 256
}
```

This is a plain `Record<string, number>` — JSON-serializable. The domain type `RefMap` is
`Record<string, number>` throughout — no Map↔Object conversion needed.

#### Lifecycle

- **Written by:** `snapshot` command, and any action with `--snapshot` flag, and `navigate` with
  `--snapshot` flag. Each write replaces the entire file — old refs are fully invalidated.
- **Read by:** any action with `--ref` flag. Loaded at the start of the command, used for
  `resolveElement`, then discarded.
- **Deleted by:** `scraper stop` (refs are meaningless without a Chrome session), `scraper start`
  (new session = new DOM = old refs are stale).

#### Staleness

`backendDOMNodeId` values are stable within a Chrome process lifetime but become invalid if the DOM
node is removed (e.g., page navigation, SPA rerender). When `DOM.resolveNode` fails for a persisted
backendNodeId:

- Error:
  `"ref e5 is stale — the element no longer exists. Run 'scraper snapshot' to get
  fresh refs."`
- Do NOT silently fall back to a different element. Do NOT auto-snapshot.

### 3. SnapshotResult Becomes Structured

```typescript
// domain/snapshot.ts — CHANGED

export interface SnapshotOptions {
  maxDepth?: number;
  maxNodes?: number;
  selector?: string;
}

/** Serializable ref map: ref string → backendDOMNodeId. */
export type RefMap = Record<string, number>;

export interface SnapshotResult {
  yaml: string;
  refs: RefMap;
}
```

Changed `RefMap` from `ReadonlyMap<string, number>` to `Record<string, number>` — this is the type
that goes to disk and comes back. Using a plain record throughout avoids Map↔Object conversion at
boundaries.

### 4. Actions Return Optional Snapshot

Every mutating action (click, fill, type, select, submit, navigate) can optionally return an updated
snapshot. This eliminates the extra round trip between every action and the subsequent snapshot that
an agent would otherwise need.

```typescript
// domain/action.ts — NEW

export interface ActionResult {
  /** Updated snapshot, present when the caller requested it. */
  snapshot?: SnapshotResult;
}
```

In the CLI, the `--snapshot` flag triggers this:

```bash
scraper click --ref e5 --snapshot
```

Output:

```
clicked ref e5
- navigation:
    - link "Home" [ref=e1]
    ...
```

First line to stderr (status), YAML to stdout (machine-readable). This matches the existing
`snapshot` command's output convention.

**Implementation:** after the action completes and post-action wait settles, run the snapshot
pipeline and include the result. The returned RefMap replaces the previous one — old refs are
invalidated. **The new refs are persisted to `~/.scraper/refs.json`**, so the next command can use
them immediately.

### 5. Post-Action Waiting (narrowed contract)

Every mutating action waits for the page to settle before returning. But "settle" has a precise,
narrow definition — we promise network idle, not "page is fully stable."

**Mechanism: CDP Network domain events, not JS polling.**

1. Enable `Network` domain at connection time.
2. Track in-flight requests via:
   - `Network.requestWillBeSent` → increment counter
   - `Network.loadingFinished` → decrement counter
   - `Network.loadingFailed` → decrement counter
3. After performing an action, wait until:
   - In-flight request count is 0 for 500ms (network idle grace period)
   - OR hard timeout of 5s (configurable via `--wait-timeout`)
4. For navigation-triggering actions (`navigate`, clicks that trigger `Page.frameNavigated`), also
   wait for `Page.loadEventFired`.

**What this does NOT guarantee:**

- SPA router transitions that don't make network requests
- `setTimeout`/`requestAnimationFrame`-driven animations
- Service-worker-mediated background work
- WebSocket message handling

For these cases, the explicit `wait` command is the correct tool:

- `wait --selector <css>` — poll for an element to appear in the DOM
- `wait --text '<text>'` — poll for text content to appear on the page
- `wait --selector <css> --text '<text>'` — poll for text within a specific element

**Why CDP events, not JS polling:** as the code review identified, page JS cannot reliably observe
navigations, subresource loads, or service worker work. CDP events are the authoritative source for
network activity.

### 6. Dialog Handling: --on-dialog, Not a Standalone Command

A standalone `scraper dialog accept` command is not viable with our one-process-per-command
architecture. The CDP `Page.javascriptDialogOpening` event is ephemeral — you only receive it if
you're connected when the dialog opens. There is no CDP API to query "is a dialog currently open?"
on reconnect. So a dialog that opens between CLI invocations is invisible.

**Solution: handle dialogs as part of the action that triggers them.**

```bash
scraper click --ref e5 --on-dialog accept          # if click triggers dialog, accept it
scraper click --ref e5 --on-dialog dismiss          # dismiss instead
scraper navigate 'page.html' --on-dialog accept     # handle beforeunload
scraper click --ref e5 --on-dialog 'accept:answer'  # prompt() with response text
```

**Mechanism:**

1. Before performing ANY mutating action, register a `Page.javascriptDialogOpening` listener. This
   is always-on, not opt-in — dialog detection is unconditional.
2. Perform the action.
3. If a dialog opens:
   - If `--on-dialog` was provided: handle it per the flag (accept/dismiss/prompt text).
   - If `--on-dialog` was NOT provided: **fail immediately** with:
     `"a dialog appeared — retry with --on-dialog accept|dismiss"` Do NOT wait for a timeout. The
     dialog event is the signal.
4. If no dialog opens, the listener is removed after post-action wait. No error.

**Why always-on detection:** A click that opens `alert()` with no network activity leaves the
network idle tracker satisfied — `inflight == 0`, grace period passes, action returns "success"
while the dialog is still blocking the page. Passive timeout-based detection is unreliable. Active
detection via the CDP event is definitive.

**What about async dialogs** (e.g., a timer triggers `alert()` between commands)? These are
genuinely not handleable in a stateless CLI without a long-lived session. For these, use `eval` to
override dialog functions:

```bash
scraper eval "window.alert = () => {}"
```

This is documented as a known limitation. A long-lived session (daemon) mode could solve it in the
future, but is out of scope for v1.

---

## Design Decisions

### Element addressing: dual mode (snapshot refs + CSS selectors)

Action commands accept either a snapshot ref or a CSS selector:

```bash
scraper click --ref e5              # from latest snapshot
scraper click --selector '#btn-xyz' # CSS selector
```

Both resolve to a DOM node via `resolveElement(target)` in the CDP adapter. The rest of the action
pipeline is identical.

**Snapshot refs** are the primary path for agent workflows: snapshot → read tree → act on ref →
re-snapshot. This follows the Chrome DevTools MCP model. Refs are stable within a snapshot,
invalidated by any mutating action (or by passing `--snapshot` to get fresh ones).

**CSS selectors** are for hand-written scripts where selectors are stable across sessions.

**Resolution mechanisms:**

- **Ref:** look up `backendNodeId` in the persisted `refs.json`, then
  `DOM.resolveNode({backendNodeId})` to get a `RemoteObjectId`. Error if ref not in map (unknown
  ref) or if `DOM.resolveNode` fails (stale — element removed from DOM since snapshot).
- **Selector:** `Runtime.evaluate('document.querySelectorAll(...)')`, error if 0 or >1 matches.
  Returns `RemoteObjectId`.

Both paths produce a `RemoteObjectId` — from there, all action code is unified.

### Action semantics

- **click** — `DOM.getContentQuads` (or `DOM.getBoxModel`) to find element center coordinates, then
  `Input.dispatchMouseEvent` sequence: `mouseMoved` → `mousePressed` → `mouseReleased`. Real pointer
  events, not `element.click()`. This triggers hover effects, focus changes, and event listeners
  that coordinate-based clicks trigger.
- **fill** — `Runtime.callFunctionOn` the element: focus, clear existing value, set `.value`,
  dispatch `input` event (bubbles), dispatch `change` event (bubbles). Covers standard HTML inputs
  and most framework bindings.
- **type** — `DOM.focus` on the element, then `Input.dispatchKeyEvent` per character (`keyDown`
  - `char` + `keyUp`). Needed for autocomplete, live-search, and framework key handlers.
- **select** — `Runtime.callFunctionOn`: set `<select>.value`, dispatch `change`. Error if value not
  in options.
- **submit** — resolve target to its containing `<form>` (or the form itself), then
  `Runtime.callFunctionOn`: `form.requestSubmit()`. This runs constraint validation AND submit event
  handlers, unlike `form.submit()` which skips both.
- **press_key** — parse key descriptor (e.g. `"Control+a"`, `"Enter"`, `"Tab"`), dispatch
  `Input.dispatchKeyEvent` with correct `key`, `code`, `modifiers` fields.
- **upload** — resolve to `<input type="file">`, then
  `DOM.setFileInputFiles({files, backendNodeId})`. Resolve local path to absolute. Error if element
  is not a file input.
- **navigate** — `Page.navigate` + wait for load + optional snapshot. Now returns `ActionResult`
  like other mutating actions.

### Page management

In attached mode, the user's Chrome has many tabs. Page management is explicit — no implicit "most
recently active" selection.

- **`pages`** — `Target.getTargets({filter: [{type: "page"}]})`. Returns list with targetId, URL,
  title. Marks the currently selected page.
- **`page <id>`** — switches the active target. If a target is currently selected, detaches from it
  first. Attaches to the new target via `Target.attachToTarget`. Updates `targetId` in state file.
  **Deletes `refs.json`** — refs from the old page are meaningless for the new page.

---

## Connection Modes

### Owned (existing, unchanged)

`scraper start` launches headless Chrome with a temp profile. Behavior unchanged.

State (`~/.scraper/chrome.json`):

```json
{
  "mode": "owned",
  "chromePid": 12345,
  "cdpPort": 9222,
  "userDataDir": "/tmp/scraper-xyz",
  "targetId": "abc-123"
}
```

`stop` kills the process, cleans up state files (both `chrome.json` and `refs.json`).

### Attached (new)

`scraper start --attach` connects to the user's running Chrome (requires Chrome 144+).

**Prerequisites:** user must enable remote debugging at `chrome://inspect/#remote-debugging`.

**Discovery:** read `<user-data-dir>/DevToolsActivePort` → parse port (line 1) + ws path (line 2) →
connect via `ws://127.0.0.1:<port><path>`.

**Platform-specific default user data dirs:**

- macOS: `~/Library/Application Support/Google/Chrome`
- Linux: `~/.config/google-chrome`
- Windows: `%LOCALAPPDATA%\Google\Chrome\User Data`

`--channel` selects beta/canary/etc (different data dir).

**Attach handshake:** Chrome 144+ shows a permission dialog when an external client connects. The
CLI must handle three outcomes:

- **Approval:** connection succeeds → write state (no page selected yet). User must follow with
  `scraper pages` then `scraper page <id>` to select a tab. Output:
  `"attached to Chrome (port <N>). Run 'scraper pages' to list tabs."` This keeps `start --attach`
  non-interactive and consistent with the argument-driven CLI model.
- **Denial:** WebSocket connection refused or closed → error with guidance:
  `"connection denied — approve the dialog in Chrome, or check chrome://inspect/#remote-debugging"`
- **Timeout:** no response within 30s → error:
  `"timed out waiting for Chrome — approve the dialog in Chrome"`

While waiting, print `"waiting for Chrome to approve connection..."` to stderr.

**Security:** we do NOT support `--remote-debugging-port` on the user's default profile. Chrome's
March 2025 security change tightened this. The `DevToolsActivePort` + approval dialog is the
sanctioned path.

State (`~/.scraper/chrome.json`):

```json
{
  "mode": "attached",
  "cdpPort": 9222,
  "wsPath": "/devtools/browser/abc-123"
}
```

Note: no `targetId` at this point. The `targetId` field is added by `scraper page <id>`.

After `scraper page <id>`:

```json
{
  "mode": "attached",
  "cdpPort": 9222,
  "wsPath": "/devtools/browser/abc-123",
  "targetId": "abc-123"
}
```

`stop` disconnects but does NOT kill Chrome. Deletes both state files.

### Connection levels

The scraper now has two connection levels, which determines what commands are available:

**Browser-level connection** (no targetId needed):

- Available after `start` (owned) or `start --attach`
- Owned mode: discovers browser WebSocket via `http://127.0.0.1:<cdpPort>/json/version` →
  `webSocketDebuggerUrl` (same mechanism the existing `discoverWsUrl` uses)
- Attached mode: uses stored `wsPath` → `ws://127.0.0.1:<cdpPort><wsPath>`
- Commands that work: `pages`, `page`, `stop`
- Commands that error if no targetId: everything else →
  `"no page selected — run 'scraper pages' then 'scraper page <id>'"`

**Page-level connection** (targetId required):

- Available after `start` (owned, auto-selects the single headless tab) or `start --attach` +
  `page <id>`
- All commands work

This means `withConnection` splits into two paths:

- `withBrowserConnection(fn)` — connects to the browser WebSocket, does NOT attach to a target. Used
  by `pages`, `page`, `stop`.
- `withPageConnection(fn)` — connects and attaches to the stored `targetId`. Used by everything
  else. Errors if `targetId` is absent.

For owned mode, `start` always produces a state with `targetId` (the single headless tab), so
`withPageConnection` always works immediately.

### Recovery behavior (both modes)

Each CLI invocation reads state and connects accordingly:

1. Read state file. If absent → `"chrome is not running — run 'scraper start'"`
2. For owned mode: verify process ownership (existing logic)
3. For browser-level commands (`pages`, `page`, `stop`): connect to browser WebSocket only
4. For page-level commands: check `targetId` exists in state
   - If absent → `"no page selected — run 'scraper pages' then 'scraper page <id>'"`
   - If present → connect to browser, then verify target still exists via `Target.getTargets()`
     - If target gone → `"selected tab was closed — run 'scraper pages' to pick a new one"`
     - Do NOT auto-select a different tab
5. If CDP connection fails entirely (Chrome closed):
   - Owned mode: clean up state (existing logic)
   - Attached mode: remove state files → `"Chrome is no longer running"`

---

## State Files Summary

All state lives in `~/.scraper/`:

| File          | Contents                                                                                               | Written by                               | Read by                                                           | Deleted by                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `chrome.json` | Connection info (mode, port, pid, targetId?). targetId absent after `start --attach` until `page <id>` | `start`, `page`                          | Every command via `withBrowserConnection` or `withPageConnection` | `stop`, `start` (fresh session)                                         |
| `refs.json`   | `Record<string, number>` — ref→backendDOMNodeId                                                        | `snapshot`, any action with `--snapshot` | Any action with `--ref`                                           | `stop`, `start`, `page` (tab switch), `navigate` (without `--snapshot`) |

**`refs.json` invalidation rules:**

- `navigate` without `--snapshot`: deletes `refs.json` (page changed, old refs are stale)
- `navigate` with `--snapshot`: replaces `refs.json` with new refs from the post-navigation page
- `page <id>`: deletes `refs.json` (different tab = different DOM)
- `start` / `stop`: deletes `refs.json` (session boundary)
- Any action with `--snapshot`: replaces `refs.json` with new refs
- Any action without `--snapshot`: does NOT delete `refs.json`. Refs may be stale, but the user
  bears that risk — `DOM.resolveNode` will fail with a clear error if the element is gone.

---

## Command Signatures

```
# Lifecycle
scraper start [--chrome-path <path>]     # launch headless Chrome (existing)
scraper start --attach [--channel <ch>]  # connect to running Chrome
scraper stop                              # kill / disconnect

# Page management
scraper pages                             # list open tabs
scraper page <id>                         # switch active tab

# Observation
scraper snapshot [--selector <css>] [--max-depth <n>] [--max-nodes <n>]
scraper screenshot [--full-page]
scraper eval '<expression>'

# Navigation (now supports --snapshot)
scraper navigate <url> [--snapshot] [--on-dialog accept|dismiss|'accept:<text>']

# Actions (all support --snapshot and --on-dialog)
scraper click <target> [--snapshot] [--on-dialog ...]
scraper fill <target> <value> [--snapshot] [--on-dialog ...]
scraper type <target> <text> [--snapshot] [--on-dialog ...]
scraper select <target> <value> [--snapshot] [--on-dialog ...]
scraper submit <target> [--snapshot] [--on-dialog ...]
scraper press_key <key> [--snapshot] [--on-dialog ...]
scraper upload <target> <path> [--snapshot] [--on-dialog ...]

# Synchronization
scraper wait --selector <css> [--timeout 5000]           # wait for element to exist in DOM
scraper wait --text '<text>' [--timeout 5000]            # wait for text to appear on page
scraper wait --ref <ref> --text '<text>' [--timeout 5000]  # wait for text within element
scraper wait --selector <css> --text '<text>' [--timeout 5000]  # wait for text within element
```

Where `<target>` is `--ref <ref>` or `--selector <css>`. Exactly one must be provided (except
`press_key` which doesn't target an element). For `wait`: `--selector` alone waits for the element
to exist; `--text` alone waits for text anywhere on the page; `--selector --text` or `--ref --text`
waits for text within an element. `--ref` without `--text` is an error — a ref names a node from an
existing snapshot, so "wait for ref to appear" is not meaningful.

`--on-dialog` values: `accept`, `dismiss`, `accept:<text>` (for prompt responses).

---

## Domain Layer Types

```typescript
// domain/snapshot.ts — CHANGED
export interface SnapshotOptions {
  maxDepth?: number;
  maxNodes?: number;
  selector?: string;
}

/** Serializable ref map: ref string → backendDOMNodeId. */
export type RefMap = Record<string, number>;

export interface SnapshotResult {
  yaml: string;
  refs: RefMap;
}

// domain/action.ts — NEW
export interface ActionResult {
  snapshot?: SnapshotResult;
}

/** How a mutating action should handle a dialog if one appears. */
export type DialogPolicy =
  | { action: "accept"; text?: string }
  | { action: "dismiss" };

// domain/element.ts — NEW
export type ElementTarget =
  | { ref: string }
  | { selector: string };

// domain/page.ts — CHANGED (add PageInfo)
export interface NavigateRequest {
  url: string;
}

export interface PageInfo {
  targetId: string;
  url: string;
  title: string;
  active: boolean;
}

// domain/browser.ts — CHANGED

/** Browser-level operations. Work without a selected page (no targetId needed). */
export interface BrowserContext {
  listPages(): Promise<PageInfo[]>;
  selectPage(targetId: string): Promise<void>;
}

/** Page-level operations. Require an attached page target. */
export interface PageContext {
  // observation
  evaluate(expression: string): Promise<EvalResult>;
  screenshot(fullPage?: boolean): Promise<string>;

  // navigation
  navigate(url: string, opts?: ActionOptions): Promise<ActionResult>;

  // element actions
  click(target: ElementTarget, opts?: ActionOptions): Promise<ActionResult>;
  submit(target: ElementTarget, opts?: ActionOptions): Promise<ActionResult>;
  fill(target: ElementTarget, value: string, opts?: ActionOptions): Promise<ActionResult>;
  selectOption(target: ElementTarget, value: string, opts?: ActionOptions): Promise<ActionResult>;
  type(target: ElementTarget, text: string, opts?: ActionOptions): Promise<ActionResult>;
  pressKey(key: string, opts?: ActionOptions): Promise<ActionResult>;
  upload(target: ElementTarget, filePath: string, opts?: ActionOptions): Promise<ActionResult>;

  // synchronization
  waitFor(opts: WaitOptions): Promise<void>;
}

/** Options common to all mutating actions. */
export interface ActionOptions {
  includeSnapshot?: boolean;
  onDialog?: DialogPolicy;
}

export interface SnapshotService {
  snapshot(
    options: SnapshotOptions,
    deps: SnapshotDeps,
  ): Promise<SnapshotResult>;
}

/**
 * What to wait for.
 * Valid combinations:
 * - { target: { selector } }              — wait for element to exist in DOM
 * - { text }                               — wait for text anywhere on page
 * - { target: { selector }, text }         — wait for text within element
 * - { target: { ref }, text }              — wait for text within ref'd element
 * Invalid: { target: { ref } } without text — ref already exists, nothing to wait for.
 */
export interface WaitOptions {
  /** Element to scope the wait to. If selector-only (no text), waits for element to exist. */
  target?: ElementTarget;
  /** Text content to wait for (substring match). */
  text?: string;
  /** Timeout in ms (default 5000). */
  timeoutMs?: number;
}

/** CDP operations needed by the snapshot service. Injected, not imported. */
export interface SnapshotDeps {
  getAccessibilityTree(rootBackendNodeId?: number): Promise<AXNode[]>;
  resolveSelector(selector: string): Promise<number>;
}

/** Chrome Accessibility tree node (subset of CDP Accessibility.AXNode). */
export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  properties?: Array<{ name: string; value: { value: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}
```

---

## CDP Implementation Notes

### New CDP domains to enable

Currently enabled: `Page`, `Runtime` Add: `Accessibility`, `DOM`, `Network`, `Input`

### Element resolution

```
resolveElement(target: ElementTarget, refs: RefMap) → RemoteObjectId

  if target.ref:
    backendNodeId = refs[target.ref]
    if (backendNodeId === undefined) → error "unknown ref e5 — run 'scraper snapshot' first"
    remoteObject = DOM.resolveNode({ backendNodeId })
    if (error) → error "ref e5 is stale — element no longer exists. Run 'scraper snapshot'"
    return remoteObject.objectId

  if target.selector:
    result = Runtime.evaluate("document.querySelectorAll(selector)")
    if length == 0 → error "no element matches selector"
    if length > 1  → error "N elements match selector, expected 1"
    return result[0].objectId
```

The `refs` parameter is loaded from `~/.scraper/refs.json` at the start of the command.

### Action implementations

| Command                        | CDP calls                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigate`                     | `Page.navigate` → wait for `Page.loadEventFired` → wait for network idle → optional snapshot                                                             |
| `click`                        | `resolveElement` → `DOM.getContentQuads` → compute center → `Input.dispatchMouseEvent` (mouseMoved, mousePressed, mouseReleased) → wait for network idle |
| `fill`                         | `resolveElement` → `Runtime.callFunctionOn(focus, clear, setValue, dispatchInput, dispatchChange)` → wait for network idle                               |
| `type`                         | `resolveElement` → `DOM.focus` → per char: `Input.dispatchKeyEvent(keyDown, keyUp)` → wait for network idle                                              |
| `select`                       | `resolveElement` → `Runtime.callFunctionOn(setValue, dispatchChange)` → wait for network idle                                                            |
| `submit`                       | `resolveElement` → `Runtime.callFunctionOn(form.requestSubmit())` → wait for network idle                                                                |
| `press_key`                    | Parse key descriptor → `Input.dispatchKeyEvent` (keyDown + keyUp, modifier flags) → wait for network idle                                                |
| `upload`                       | `resolveElement` → get `backendNodeId` → `DOM.setFileInputFiles({files, backendNodeId})`                                                                 |
| `wait --selector`              | Poll: `Runtime.evaluate(querySelectorAll)` with exponential backoff up to timeout                                                                        |
| `wait --text`                  | Poll: `Runtime.evaluate(document.body.textContent.includes(text))` with exponential backoff                                                              |
| `wait --ref/--selector --text` | Poll: resolve element, then `Runtime.evaluate(element.textContent.includes(text))`                                                                       |
| `pages`                        | `Target.getTargets({filter: [{type: "page"}]})`                                                                                                          |
| `page <id>`                    | `Target.detachFromTarget` current (if targetId exists) → `Target.attachToTarget` new → re-enable domains                                                 |

### Dialog handling within actions

```
// Before performing ANY mutating action:
let dialogFired = false
register Page.javascriptDialogOpening handler:
  dialogFired = true
  if (opts.onDialog):
    → Page.handleJavaScriptDialog({ accept: ..., promptText: ... })
  else:
    → Page.handleJavaScriptDialog({ accept: false })  // dismiss to unblock
    → throw error "a dialog appeared — retry with --on-dialog accept|dismiss"

// Perform action...
// Wait for network idle...

// After wait:
remove Page.javascriptDialogOpening handler
```

### Snapshot via CDP Accessibility

```
snapshot(options, deps):
  if options.selector:
    rootNodeId = deps.resolveSelector(options.selector)
    axNodes = deps.getAccessibilityTree(rootNodeId)
  else:
    axNodes = deps.getAccessibilityTree()

  { ariaNodes, refs } = transformAXTree(axNodes, options)
  yaml = renderYaml(ariaNodes)
  return { yaml, refs }
```

The CDP adapter implements `SnapshotDeps`:

```
getAccessibilityTree(rootBackendNodeId?):
  if rootBackendNodeId:
    result = Accessibility.getFullAXTree({ root: rootBackendNodeId })
  else:
    result = Accessibility.getFullAXTree()
  return result.nodes  // mapped to our AXNode type

resolveSelector(selector):
  result = Runtime.evaluate("document.querySelector(selector)")
  if no result → error "selector not found"
  description = DOM.describeNode({ objectId: result.objectId })
  return description.backendNodeId
```

### Network idle tracking

```
// On connection setup:
Network.enable()
let inflight = 0
Network.requestWillBeSent → inflight++
Network.loadingFinished  → inflight--
Network.loadingFailed    → inflight--

// After action:
waitForNetworkIdle(graceMs = 500, timeoutMs = 5000):
  wait until (inflight == 0 for graceMs) OR (timeoutMs elapsed)
  // timeout is not an error — just means the page is still loading
  // the action itself succeeded; we just can't guarantee full idle
```

### Attach via DevToolsActivePort

```
readDevToolsActivePort(userDataDir):
  content = readFile(userDataDir + "/DevToolsActivePort")
  lines = content.split("\n")
  port = parseInt(lines[0])
  wsPath = lines[1]
  return { port, wsPath }

attach(channel = "stable"):
  userDataDir = platformDefaultUserDataDir(channel)
  { port, wsPath } = readDevToolsActivePort(userDataDir)
  wsUrl = "ws://127.0.0.1:" + port + wsPath
  // connect via simple-cdp with 30s timeout
  // Chrome shows approval dialog — user must click Allow
  // on denial: WebSocket close/error → surface as CLI error
```

---

## Implementation Order

### Phase 1: Snapshot Redesign + Ref Persistence

This is prerequisite to everything else — refs must work before actions can use them.

1. **Domain types:** `AXNode`, `RefMap` (as `Record`), updated `SnapshotResult`, `SnapshotDeps`,
   `ActionResult`, `ActionOptions`, `DialogPolicy`, `ElementTarget`, `PageInfo`, `WaitOptions`,
   `BrowserContext`, `PageContext`
2. **Ref store** (`src/fs/`): read/write `~/.scraper/refs.json` using existing `createJsonFileStore`
3. **AX tree transformer** (`src/aria/tree.ts`):
   `AXNode[] → { ariaNodes: AriaNode[], refs: RefMap }`
4. **Unit tests for transformer:** mock AXNode data → verify AriaNode output + ref mapping
5. **Snapshot adapter** (`src/aria/snapshot.ts`): use `SnapshotDeps` instead of `evaluateInPage`
6. **CDP adapter:** enable `Accessibility` + `DOM` domains, implement `SnapshotDeps`
7. **Composition root** (`main.ts`): wire new snapshot deps through `withPageConnection`, persist
   refs
8. **Integration test:** snapshot a real page, verify YAML output + non-empty refs.json on disk

### Phase 2: Attach + Page Management

9. **Attach connection path:** `readDevToolsActivePort`, connect, approval handling
10. **State file:** `mode` field ("owned" | "attached"), optional `targetId`, conditional stop
11. **`withBrowserConnection` / `withPageConnection`:** two connection paths in composition root
12. **`pages` command:** `Target.getTargets` via `withBrowserConnection` → formatted output
13. **`page` command:** target switch via `withBrowserConnection`, state file update, refs.json
    deletion
14. **Target verification** in `withPageConnection`: check targetId present + target exists
15. **Integration tests:** attach to Chrome, list pages, switch page, disconnect; **attach then
    snapshot/click without page → error "no page selected"**

### Phase 3: Core Input Actions

16. **Element resolution:** `resolveElement(target, refs)` — ref path (from refs.json) + selector
    path
17. **Network idle tracker:** enable `Network` domain, request counting, idle waiting
18. **`click`:** coordinate-based pointer events + wait
19. **`fill`:** focus + set value + dispatch events + wait
20. **`waitFor`:** polling with selector/text/both, ref+text validation, timeout
21. **`--snapshot` flag pipeline:** action → wait → snapshot → persist refs → output
22. **`navigate`:** returns `ActionResult`, supports `--snapshot`, invalidates/replaces refs.json
23. **CLI commands:** `click`, `fill`, `wait`, updated `navigate` with
    `--ref`/`--selector`/`--snapshot`
24. **Integration tests:** click button, fill input, verify DOM state; test with `--snapshot`; test
    stale ref error; test refs.json written/read across processes

### Phase 4: Full Input Suite

25. **`type`:** focus + per-character key events
26. **`select`:** value set + change dispatch on `<select>`
27. **`submit`:** `requestSubmit()` on containing form
28. **`press_key`:** key descriptor parsing + dispatch with modifiers
29. **CLI commands:** `type`, `select`, `submit`, `press_key`
30. **Integration tests:** type into live search, select dropdown, submit form, keyboard shortcut

### Phase 5: Upload + Dialog Handling

31. **`upload`:** `DOM.setFileInputFiles`
32. **`--on-dialog` flag:** always-on dialog listener on mutating actions, policy-based handling
33. **CLI commands:** `upload` command, `--on-dialog` flag on all action commands
34. **Integration tests:** upload file + verify; click triggers alert → --on-dialog accept; click
    triggers confirm → --on-dialog dismiss; unhandled dialog → immediate fail with message

---

## Testing Strategy

### Unit tests (co-located, `deno task test`)

**Transformer tests (replaces current tree.ts tests):**

- Given mock `AXNode[]` → verify `AriaNode[]` output and `RefMap` contents
- Ignored nodes filtered
- Role/name/level extraction
- Ref assignment only to interactable roles
- `maxDepth` and `maxNodes` limits
- Empty tree handling

**Renderer tests (existing render.ts tests — unchanged):**

- Given `AriaNode[]` → verify YAML output
- These tests are unaffected by the pipeline change

**CLI argument parsing:**

- Each new command: both `--ref` and `--selector` paths
- `--snapshot` flag parsing
- `--on-dialog` flag parsing (accept, dismiss, accept:text)
- `--timeout` parsing for `wait`
- Key descriptor parsing for `press_key`
- Error cases: missing target, both ref and selector, unknown command

**Element resolution (with mock CDP):**

- Ref found in map → success
- Ref not in map → unknown ref error
- Ref in map but DOM.resolveNode fails → stale ref error
- Selector matches 1 → success
- Selector matches 0 → error
- Selector matches N > 1 → error with count

**Ref persistence:**

- Write refs.json → read back → verify round-trip
- Missing refs.json on `--ref` → error "run snapshot first"
- Verify refs.json deleted on start/stop/page

**Network idle tracker (with mock events):**

- Requests start and finish → idle detected
- Requests start, timeout → returns anyway
- No requests → immediate idle

**Dialog handling (with mock CDP events):**

- --on-dialog accept: dialog opens → handled, action succeeds
- --on-dialog dismiss: dialog opens → dismissed, action succeeds
- --on-dialog accept:text: prompt opens → text provided, action succeeds
- No --on-dialog, dialog opens → immediate fail with "a dialog appeared" error
- --on-dialog provided, no dialog opens → no error (flag is "if needed")

### Integration tests (`tests/integration/`, `deno task test:integration`)

All run against a real Chrome instance with test HTML pages.

**Snapshot pipeline:**

- Snapshot a page with known structure → verify YAML content
- Snapshot with selector scoping → verify subtree only
- Snapshot → verify refs.json written with entries for interactable elements
- Verify backendDOMNodeIds in refs.json resolve to correct elements via DOM.resolveNode

**Ref lifecycle across processes:**

- `scraper snapshot` → verify refs.json exists
- `scraper click --ref e1` in separate process → verify action succeeds using persisted ref
- `scraper navigate` without --snapshot → verify refs.json deleted
- `scraper navigate --snapshot` → verify refs.json replaced with new refs

**Attach flow:**

- Successful attach + disconnect (Chrome stays alive)
- DevToolsActivePort not found → clear error
- Connection refused / denied → clear error

**Page management:**

- List pages → verify page count and URLs
- Switch page → verify subsequent commands target new page
- Switch page → verify refs.json deleted
- Selected tab closed → verify error on next command

**Actions:**

- Click button → verify click handler fired (check DOM state)
- Fill input → verify value set and events dispatched
- Type into input → verify keystroke events fired
- Select dropdown option → verify selection changed
- Submit form → verify form submission (check via onsubmit handler)
- Upload file → verify file name appears in DOM
- Press key → verify key handler fired

**Action + snapshot:**

- Click with `--snapshot` → verify returned snapshot reflects post-click state
- Click with `--snapshot` → verify refs.json updated with new refs
- Fill with `--snapshot` → verify input value visible in snapshot

**Ref staleness:**

- Snapshot → act on ref → re-snapshot → verify new refs assigned
- Snapshot → navigate → act on old ref → verify stale ref error
- Snapshot → click that triggers DOM removal → act on old ref → verify stale error

**Dialogs:**

- Click triggers alert() → --on-dialog accept → page continues
- Click triggers confirm() → --on-dialog dismiss → verify false returned
- Click triggers prompt() → --on-dialog accept:answer → verify text received
- Click triggers alert() → no --on-dialog → immediate fail with "a dialog appeared" error

**Network idle:**

- Click that triggers fetch → verify wait completes after fetch done
- Click that triggers slow fetch → verify timeout doesn't error, action still succeeds

**Recovery:**

- Owned mode: Chrome crashes → next command gives clean error
- Attached mode: Chrome closed → next command gives clean error
- Target closed between commands → "tab closed" error
