# Tier B Minimal: Text-Native Browser Control for LLMs

**Date:** 2026-04-19 **Status:** Draft

## Problem

The current scraper has 15 CLI commands built around semantic actions (`click`, `fill`,
`type`, `select`, `submit`, `press-key`, `upload`) plus page selection, dual launch modes
(owned Chrome vs. attached), and a `DialogPolicy` threaded through every mutation.

Real-world usage (the UHC Direct Medical Reimbursement form captured in
`/Users/filip/Desktop/Invoices/CLAUDE.md`) showed that the semantic-action surface is a
footgun: `fill` fails on React-managed inputs, `fill` fails on certain field types where
aria-label selectors miss the element, dual-input date widgets need paired updates, and
form validation fires on blur. The agent fell back to `evaluate_script` with a
React-setter dance three or four times per form anyway.

The tool abstraction was fuzzy: it offered "click" and "fill" as if those were primitives,
but the underlying browser treats them as conditional heuristics over a React/AEM
component system. Agents spent cycles rediscovering the fallback each session.

## Thesis

LLMs are superhuman at manipulating text APIs — writing JS against the DOM, composing
CSS queries, dispatching events. They are not good at pixel-reasoning or mouse aiming.
The right primitive for an LLM browser tool is therefore **accessibility-tree
observation + arbitrary JS evaluation**, not pre-wrapped "click this coordinate" or
"fill this input" commands.

Browser-harness takes the opposite position — screenshots + pixel clicks — because it
targets vision-capable agents. Our target is CLI-invoked Claude Code operating on real
user Chrome instances. Text-first, not pixel-first.

## Scope

**In:** A thin CLI over Chrome DevTools Protocol with:

- Attach-only to the user's running Chrome (no owned launch mode)
- A single persisted active-target pointer (one `targetId` in `refs.json`), switched
  only by explicit `scraper tab <ref>`
- ARIA snapshots written to disk, returned as pointers
- Arbitrary JS evaluation against snapshot-identified elements
- File upload (CDP `DOM.setFileInputFiles` — the one thing JS can't do)
- Selector/text waits, screenshots, tab switching, explicit new-tab opening

**Out:** Owned Chrome launch, headless mode, stop command, multi-mode Chrome state
(`OwnedState`/`AttachedState` union, ownership classification, PID tracking),
semantic action commands (`click`/`fill`/`type`/`select`/`submit`/`press-key`),
per-action `DialogPolicy` plumbing, self-healing helper files, form-helper stdlib
(deferred until observed repetition justifies it), frames/iframes, shadow DOM, drag
and drop, network interception, cookie manipulation.

## Command Surface (7 commands)

| Command | Purpose | Auto-snapshot? |
|---|---|---|
| `scraper navigate <url>` | Navigate active tab. `--new` opens a new tab via `Target.createTarget` and makes it active. Waits for network idle. | **Yes** |
| `scraper snapshot` | Capture ARIA tree + tabs + dialog state. | — (it *is* the snapshot) |
| `scraper eval '<expr>'` | Evaluate JS in the page with `$ref(id)` helper bound. | **No** |
| `scraper wait ...` | Wait for selector, text, or text-in-ref. | **Yes** on success |
| `scraper tab <ref>` | Activate a tab by its ref; becomes the active target. | **Yes** |
| `scraper upload --ref e3 <path>` | `DOM.setFileInputFiles` on the element. | **No** |
| `scraper screenshot` | Capture a PNG of the viewport. | No — returns image path |

### Auto-snapshot rule (asymmetric)

Commands that change page context (`navigate`, `tab`, `wait` on success) auto-snapshot
and return a one-line pointer to stdout. `eval` and `upload` do **not** auto-snapshot
— the agent calls `scraper snapshot` explicitly after DOM-mutating evals or uploads
that change the form.

Rationale: an eval is often a read (`document.title`, `el.value`). Auto-snapshotting
reads would invalidate the agent's current refs pointlessly (see [Handle Scheme](#handle-scheme)).
The agent decides when the DOM changed meaningfully.

Snapshots are always written to disk, so when they *are* returned the token cost is
one line — the agent reads the full file only when it needs the tree.

Example:

```
$ scraper navigate https://memberforms.uhc.com/DirectMedicalReimbursement.html
navigated · snapshot s47 · "Direct Medical Reimbursement" · 14 refs · 8421B

$ scraper eval 'document.title'
"Direct Medical Reimbursement"

$ scraper eval '$ref("e8").click()'
undefined

$ scraper snapshot
snapshot s48 · step 2 visible · 22 refs · 11240B
```

### Deleted commands

`start`, `stop`, `pages`, `page <id>`, `click`, `fill`, `type`, `select`, `submit`,
`press-key`. `start` becomes implicit (first command attaches). Everything else is
subsumed by `eval` or removed.

## Handle Scheme

Element refs are opaque short strings (`e1`, `e14`, `e47`). Tab refs use a `t` prefix
(`t1`, `t2`). Both are backed by CDP `backendNodeId` (elements) or `targetId` (tabs),
persisted in `refs.json`, resolved inside `eval` via a single injected helper:

```js
$ref("e8")  // → Element, or throws "stale ref" if not in current refs.json
```

### Monotonic counter (session-scoped)

The counter that generates ref names **never resets within a Chrome session**.
Snapshot `s47` might assign `e1..e14`; the next snapshot `s49` starts at `e15`, never
reuses `e3`. This matters because `refs.json` holds only the latest snapshot's
subset — a stale ref is one not present in current `refs.json`, and monotonic numbering
guarantees a stale ref never silently binds to a different node.

The counter is persisted in `~/.scraper/counter-refs` (separate from the `counter`
used for snapshot/screenshot IDs since they increment at different rates).

### Stale ref error

```
error: ref e3 is stale — not in current snapshot (s49, refs e15..e22).
Run `scraper snapshot` and retry with a fresh ref.
```

### Eval context

`$ref` is the *only* helper preloaded. No `$`, no `$$`, no form-manipulation helpers,
no React-setter wrapper. Agents write raw JS against the DOM.

A shipped-stdlib for common patterns is a future addition driven by observed
repetition, not speculation. **Top candidate:** `$fill(ref, value)` that bundles the
React-controlled-input setter dance:

```js
// Agent writes this repeatedly for React forms today:
const el = $ref("e3");
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
setter.call(el, "Emil");
el.dispatchEvent(new Event("input",  { bubbles: true }));
el.dispatchEvent(new Event("change", { bubbles: true }));

// With $fill shipped, becomes:
$fill("e3", "Emil");
```

Ship it as soon as we see this pattern repeated across 2–3 independent forms.
(UHC Reimbursement already requires it for subscriber fields — one data point.)

## Snapshot Artifact

Snapshots are written to `~/.scraper/s{N}.yaml` with a monotonic counter shared across
all artifacts (snapshots and screenshots). Screenshots are `~/.scraper/shot{N}.png`
using the same counter space, so numbering preserves the timeline at a glance.

### Ref coverage

The current tree builder (`src/aria/tree.ts`) emits refs only for a narrow set of
roles: link, button, textbox, checkbox, radio, combobox. This is too narrow for the
thesis — real forms include spinbuttons (date widgets), sliders, tabs, menuitems,
switches, textareas, etc., and the UHC form hit exactly this problem with its Date
spinbutton widget.

Widen `INTERACTABLE_ROLES` to cover the full WAI-ARIA widget category:

```
link, button, textbox, searchbox, textarea,
checkbox, radio, switch,
combobox, listbox, option, menuitem, menuitemcheckbox, menuitemradio,
slider, spinbutton,
tab, treeitem,
gridcell, row, columnheader, rowheader
```

Also assign a ref to any element that carries an explicit accessible name even if its
role is non-interactive (e.g., a named landmark the agent might want to scope a
`querySelector` to). Non-interactive structural nodes without a name remain unref'd —
use `document.querySelector` in `eval` for those.

### YAML shape

```yaml
snapshot: s47
url: https://memberforms.uhc.com/DirectMedicalReimbursement.html
title: Direct Medical Reimbursement
tabs:
  - ref: t1
    active: true
    url: https://memberforms.uhc.com/...
    title: Direct Medical Reimbursement
  - ref: t2
    url: https://mail.google.com/...
    title: Inbox
dialog: null
tree:
  - role: main
    name: Reimbursement Form
    children:
      - role: textbox, name: Member ID, ref: e3
      - role: button, name: Next, ref: e8
```

`tabs:` is always present, so the agent never needs a separate `pages` command.
`dialog:` surfaces any JavaScript dialog observed during the command that produced
this snapshot (see [Dialog Handling](#dialog-handling)).

### Cleanup

On every snapshot write: keep the newest 20 artifacts in `~/.scraper/`, delete any
older than 24 hours. Opportunistic, no daemon.

Old ids are never reused. Counters are persisted in `~/.scraper/counter` (artifact
IDs) and `~/.scraper/counter-refs` (ref IDs).

## Dialog Handling

Native JS dialogs (`alert`, `confirm`, `prompt`, `beforeunload`) cannot be handled
from page JS. They require CDP `Page.handleJavaScriptDialog`.

**Default:** auto-**dismiss**. Safer default — "say no to the thing I didn't ask for."
Dialog text appears in the snapshot produced by the current command under a `dialog:`
key so the agent observes that it happened and can retry with an explicit accept
if needed.

**Observability scope (narrow).** Dialog detection is a per-CDP-connection event
listener (`src/cdp/dialog.ts`) that only fires for `javascriptDialogOpening` events
while the listener is registered. Because Tier B opens a fresh CDP connection per
command, `dialog:` in a snapshot reflects **only dialogs that opened during the
current command's execution**.

**Known limitation — inter-command dialogs.** Dialogs that opened between commands
(when no scraper process was attached) are not observed: CDP does not replay missed
`javascriptDialogOpening` events on reattach, and we do not probe for pending
dialogs at attach time. Such a dialog remains pending in Chrome and may cause the
next command to block or error on page interaction.

The `--on-dialog` flag does **not** help here — `Page.handleJavaScriptDialog` is
only issued from inside the opening-event callback, so it has no effect without a
fresh event. Recovery today is manual: the user dismisses the dialog in Chrome's
UI, then re-runs the command.

Possible future additions (deferred until observed need):

- Attach-time pending-dialog probe: issue a blind `Page.handleJavaScriptDialog`
  with `accept: false` once on every attach; errors silently if nothing is
  pending, clears the dialog if one is.
- A `scraper dialog dismiss|accept[:text]` escape hatch command that wraps the
  blind handle call explicitly.

**Override flag** (single, simple):

- `--on-dialog accept` — accept with no text
- `--on-dialog accept:<text>` — accept with prompt text
- `--on-dialog dismiss` — explicit dismiss (same as default)

Available on `navigate`, `eval`, `wait`, `tab`, `upload`. No discriminated-union
`DialogPolicy` type threaded through the domain. One flag, local to the CLI layer.

## State and Filesystem

```
~/.scraper/
├── counter          # monotonic int for snapshot/screenshot IDs
├── counter-refs     # monotonic int for e/t ref IDs (session-scoped)
├── refs.json        # { activeTargetId, snapshotId, refs: { e3: backendId, t1: targetId, ... } }
├── s{N}.yaml        # snapshot artifacts
└── shot{N}.png      # screenshot artifacts
```

### refs.json shape

```json
{
  "activeTargetId": "B2E7C1A4...",
  "snapshotId": "s47",
  "refs": {
    "e3":  { "kind": "element", "backendNodeId": 1234 },
    "e8":  { "kind": "element", "backendNodeId": 1287 },
    "t1":  { "kind": "tab", "targetId": "B2E7C1A4..." },
    "t2":  { "kind": "tab", "targetId": "D9F3A8E1..." }
  }
}
```

Overwritten on every snapshot. `activeTargetId` is *scraper's* notion of the active
tab — **not** derived from Chrome's focused window. The user can switch tabs in
Chrome manually without redirecting automation. Switching the scraper's active
target requires explicit `scraper tab <ref>` (or `scraper navigate --new <url>`,
which creates a new tab and makes it active).

### Active-target resolution (three cases)

Every command resolves the active target before running:

1. **`refs.json` exists and `activeTargetId` points to a live tab** → attach to it.
2. **`refs.json` exists but `activeTargetId` points to a closed tab** → CDP
   `Target.attachToTarget` fails; fall back to the first `type: "page"` entry in
   `/json/list`, overwrite `activeTargetId` in `refs.json`, continue.
3. **`refs.json` does not exist (first run, fresh session)** → same fallback: pick
   the first `type: "page"` entry from `/json/list`, write a minimal `refs.json`
   with just `{ activeTargetId, snapshotId: null, refs: {} }`, continue. If there
   are no page targets at all (empty Chrome? headless with no tabs?) error with
   a clear "no tabs open; run `scraper navigate --new <url>`" message.

Case 3 means the user never needs an explicit init step — any command Just Works
against whatever tab Chrome has in front.

**Gone:**

- `chrome.json` (no owned-mode state to track)
- `JsonFileStore` generic (one-off file I/O is simpler than the abstraction)
- `StateStore`, `ChromeState`, `OwnedState`/`AttachedState` union, ownership
  classification, `isProcessAlive`, `isOurChromeProcess`, dead-PID recovery,
  foreign-PID handling

**Attach behavior on every command:**

Each invocation reads `DevToolsActivePort` from the default Chrome user data
directory, connects to the `activeTargetId` from `refs.json` (with the closed-tab
fallback above), runs the command, closes the connection. No persistent attachment
state beyond the active-target bookkeeping. First-time users get a clear error
message pointing them at `chrome://inspect/#remote-debugging` if remote debugging
is off.

Channel selection (`--channel beta|canary|dev`) stays as an environment variable or
flag, but without the `attached` vs `owned` branching it's a thin lookup.

## Wait Semantics

Three kinds, unified behind one command (unchanged from current):

```
scraper wait --selector "#submit"           # CSS selector appears
scraper wait --text "Thank you"             # text appears anywhere
scraper wait --ref e8 --text "Loaded"       # text appears within ref
```

All wait kinds auto-snapshot on success. Failure throws with a clear timeout message.
Default timeout 30s, overridable with `--timeout <ms>`.

## Deletion Plan

Large deletions from the current codebase:

- `src/cdp/chrome.ts` — entire file (launch/kill Chrome, headless args, user data
  directory management, free-port discovery)
- `src/fs/mod.ts` — entire file (`JsonFileStore` generic)
- `src/app/mod.ts` — `OwnedState` branch and its classification/cleanup/ownership code;
  `startChrome`'s branching; `stopChrome`'s ownership logic; `DialogPolicy` plumbing
  through every action
- `src/cli/mod.ts` — seven command handlers (`click`, `fill`, `type`, `select`,
  `submit`, `press-key`, plus `start`/`stop`/`pages`/`page` consolidation)
- `src/domain/app.ts` — `StartOptions` (mostly), `StartResult`, six of the
  `ScraperApp` methods
- `src/domain/action.ts` — `DialogPolicy` type (collapse to CLI-local flag parsing)

Preserved / modified:

- `src/aria/` — snapshot pipeline stays, YAML shape gains `tabs:`, `dialog:`, `url:`,
  `title:` header
- `src/cdp/attach.ts` — reused, but caller becomes "every command" not "just start"
- `src/cdp/connection.ts`, `src/cdp/network.ts`, `src/cdp/dialog.ts` — preserved
- `src/cdp/input.ts` — trimmed heavily (upload stays, rest goes)
- `src/cdp/resolve.ts` — becomes ref-only; selector branch goes
- `src/cdp/accessibility.ts` — preserved
- `src/main.ts` — shrinks to roughly half its current size

Rough estimate: **~40% fewer lines** of code, single state mode, zero process
lifecycle management.

## Eval Plumbing

When an eval expression contains `$ref("eN")` calls, the CLI:

1. Reads `refs.json` for the current ref-to-backendNodeId map.
2. For each distinct ref in the expression, verifies it is present in `refs.json`
   (stale-ref check — monotonic counter means a ref not in the map was generated
   by a previous snapshot and is unambiguously stale).
3. Resolves each `backendNodeId` to a live `objectId` via CDP `DOM.resolveNode`.
4. Passes the expression to CDP `Runtime.callFunctionOn` with the resolved nodes
   bound as arguments, and a preamble that defines `$ref` as a lookup over those
   arguments.
5. Errors with a clear "stale ref eN" message if the ref is missing from the map
   or if `DOM.resolveNode` fails because the node was removed from the DOM.

If the expression uses no `$ref`, the CLI skips the resolution step and just runs
`Runtime.evaluate`.

`eval` returns only the JSON-serialized result of the expression. It does **not**
auto-snapshot (see [Auto-snapshot rule](#auto-snapshot-rule-asymmetric)) — the agent
calls `scraper snapshot` explicitly after evals that mutate the DOM.

## Documentation

Ship a `SKILL.md` at the repo root that teaches Claude Code when and how to use the
tool. Key content:

- Attach semantics ("make sure Chrome is running with remote debugging")
- The 7 commands, one line each
- The `$ref` convention and the auto-snapshot feedback loop
- Explicit note: "prefer `eval` with the React setter dance over looking for a
  semantic action — there isn't one"
- Pattern library for the most common forms of JS (set value + dispatch events,
  scroll a container, click a deep element, read form state), as examples not as
  CLI commands

The helper stdlib (`scraper-helpers.js` bundled into every eval context) is
**not shipped in v1**. Add it only after we see the agent writing the same 8-line
dance repeatedly across unrelated forms.

## Open Questions (Post-Design)

- Does `eval` need a way to return multiple values or structured output beyond what
  `Runtime.callFunctionOn` already serializes? (Probably not — agents can return
  arrays or JSON.stringify-able objects.)
- How does `wait` interact with dialogs that pop during the wait? (Probably: same
  `--on-dialog` flag, default dismiss, surface in post-wait snapshot.)
- Should we expose a `scraper refs <ref>` read-only command for debugging (prints the
  DOM node's outerHTML)? Or is that just `eval '$ref("e3").outerHTML'`? (Latter.
  Skip the command.)

## Success Criteria

The UHC form in `/Users/filip/Desktop/Invoices/CLAUDE.md` can be filled and submitted
end-to-end using only: `navigate`, `snapshot`, `eval`, `wait`, `upload`. The agent
does not need to reach for an external MCP (chrome-devtools-mcp, browser-use, etc.)
at any point, and does not get stuck on "this tool doesn't work for this field type,
try a different one" — because there is no type-sensitive semantic-action layer to
get stuck on. Writing raw JS (including the React-setter dance) is the primitive,
not a fallback.

Total CLI command count: 7 (from 15). Code size: ~40% reduction. State: one store
for refs + active target, two monotonic counters, no process-lifecycle bookkeeping.
