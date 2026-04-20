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

**"Here is the browser. Use it."** No magic, no hidden state, no clever abstractions
papering over what's actually happening. The tool exposes the smallest set of
primitives needed to let a text-native LLM drive a real Chrome tab, and then stays
out of the way.

LLMs are superhuman at manipulating text APIs — writing JS against the DOM,
composing CSS queries, dispatching events. They are not good at pixel-reasoning or
mouse aiming. The right primitive for an LLM browser tool is therefore
**accessibility-tree observation + arbitrary JS evaluation**, not pre-wrapped
"click this coordinate" or "fill this input" commands.

Browser-harness takes the opposite position — screenshots + pixel clicks — because
it targets vision-capable agents. Our target is CLI-invoked Claude Code operating on
real user Chrome instances. Text-first, not pixel-first.

### Design rules derived from the thesis

1. **No hidden tab-selection state.** Scraper does not remember "which tab"
   across commands. The agent names its tab on every call. Scraper does persist
   two things — listed explicitly in [State and Filesystem](#state-and-filesystem)
   so there are no surprises: (a) artifact files (snapshots, screenshots, both
   on disk for the agent to `Read`), and (b) a per-tab ref map
   (`refs.<targetId>.json`) that scopes snapshot-minted refs to the tab they
   came from and gets overwritten by that tab's next snapshot. Refs model how
   the browser works — a node in a page's DOM — not a scraper-specific layer.
   There is no "active target," no implicit cross-command tab context.
2. **No magic target discovery.** Scraper does not guess which tab you mean.
   The agent calls `scraper tabs`, picks one, and passes the targetId.
3. **No semantic-action wrapping.** There is no `click` command that hides
   whether Chrome received a real mouse event or a JS `.click()`. Agent writes
   the JS it wants.
4. **Minimum primitives.** If a capability can be expressed by composing the
   existing commands, we do not add a new command for it. Helpers come later,
   only on evidence of real repetition.
5. **Artifacts on disk, pointers on stdout.** Snapshots and screenshots are
   files the agent can `Read` on demand; token cost is opt-in.

## Scope

**In:** A thin CLI over Chrome DevTools Protocol with:

- Attach-only to the user's running Chrome (no owned launch mode)
- **Stateless tab selection**: every command that needs a tab takes `--tab <targetId>`
  as a required argument. No persisted active-target; the agent supplies the target on
  every call
- `scraper tabs` as the bootstrap listing command (no state required)
- ARIA snapshots written to disk, returned as pointers
- Per-tab element ref state (`refs.<targetId>.json`), invalidated on each tab's next
  snapshot, session-wide monotonic ref counter
- Arbitrary JS evaluation against snapshot-identified elements
- File upload (CDP `DOM.setFileInputFiles` — the one thing JS can't do)
- Selector/text waits, screenshots, explicit new-tab opening

**Out:** Owned Chrome launch, headless mode, stop command, multi-mode Chrome state
(`OwnedState`/`AttachedState` union, ownership classification, PID tracking),
**persisted active-target pointer** (stateless instead — see [Active Target Selection](#active-target-selection)),
semantic action commands (`click`/`fill`/`type`/`select`/`submit`/`press-key`),
per-action `DialogPolicy` plumbing, self-healing helper files, form-helper stdlib
(deferred until observed repetition justifies it), frames/iframes, shadow DOM, drag
and drop, network interception, cookie manipulation.

## Command Surface (7 commands)

Every command below requires `--tab <targetId>` **except** `tabs` (lists, no target
needed) and `navigate --new <url>` (creates a new tab, so there's nothing to address
yet). `targetId` is Chrome's CDP target identifier, a 32-hex-character string. The
agent learns them from `scraper tabs` output and passes them literally. Unique
prefixes are accepted on input for convenience, but `scraper tabs` prints the **full**
targetId for each tab to guarantee the agent can always address any tab
unambiguously.

**Canonicalization.** Every command's first step is to resolve `--tab <input>` to the
unique full targetId by scanning `/json/list`. All subsequent file I/O (`refs.*.json`
names, snapshot metadata) and all user-facing output (messages, pointer lines, error
text) use the **full canonical targetId**, never the user's input. A tab has exactly
one ref file on disk regardless of whether the agent addressed it via a 4-char prefix,
an 8-char prefix, or the full ID — so `$ref` continuity across commands is guaranteed.

| Command | Purpose | Auto-snapshot? |
|---|---|---|
| `scraper tabs` | List all page tabs with full targetIds, URLs, titles. No `--tab`. | No |
| `scraper navigate --tab <id> <url>` | Navigate that tab. Waits for network idle. | **Yes** |
| `scraper navigate --new <url>` | Create a new tab via `Target.createTarget` and print its targetId. No `--tab` (there's nothing to address). | **Yes** |
| `scraper snapshot --tab <id>` | Capture ARIA tree + dialog state for that tab. Writes `refs.<canonical-targetId>.json`. | — (it *is* the snapshot) |
| `scraper eval --tab <id> '<expr>'` | Evaluate JS in that tab's page with `$ref(id)` helper bound. | **No** |
| `scraper wait --tab <id> ...` | Wait for selector, text, or text-in-ref in that tab. | **Yes** on success |
| `scraper upload --tab <id> --ref e3 <path>` | `DOM.setFileInputFiles` on the element. | **No** |
| `scraper screenshot --tab <id>` | Capture a PNG of that tab's viewport. | No — returns image path |

### Auto-snapshot rule (asymmetric)

Commands that change page context (`navigate`, `wait` on success) auto-snapshot
and return a one-line pointer to stdout. `eval` and `upload` do **not** auto-snapshot
— the agent calls `scraper snapshot --tab <id>` explicitly after DOM-mutating evals
or uploads that change the form.

Rationale: an eval is often a read (`document.title`, `el.value`). Auto-snapshotting
reads would invalidate the agent's current refs pointlessly (see [Handle Scheme](#handle-scheme)).
The agent decides when the DOM changed meaningfully.

Snapshots are always written to disk, so when they *are* returned the token cost is
one line — the agent reads the full file only when it needs the tree.

Example:

```
$ scraper tabs
4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2  https://memberforms.uhc.com/...   "Direct Medical Reimbursement"
9F3BA1C2D7E4F1A8B5C3E9F6A4D2B0C5  https://mail.google.com/...        "Inbox"

$ scraper navigate --tab 4AE7B2C9 https://memberforms.uhc.com/DirectMedicalReimbursement.html
navigated · snapshot s47 · "Direct Medical Reimbursement" · 14 refs · 8421B

$ scraper eval --tab 4AE7B2C9 'document.title'
"Direct Medical Reimbursement"

$ scraper eval --tab 4AE7B2C9 '$ref("e8").click()'
undefined

$ scraper snapshot --tab 4AE7B2C9
snapshot s48 · step 2 visible · 22 refs · 11240B
```

### Deleted commands

`start`, `stop`, `pages`, `page <id>`, `tab <ref>` (as a switch-verb — replaced by
passing `--tab <id>` explicitly), `click`, `fill`, `type`, `select`, `submit`,
`press-key`. `start` becomes implicit (first command attaches). Everything else is
subsumed by `eval` or removed.

## Handle Scheme

### Tabs — no refs, use targetIds directly

Tabs are identified by Chrome's CDP `targetId` (32-hex-char strings). No short-ref
aliasing, no `t1`/`t2` mapping file to maintain. `scraper tabs` prints the **full**
targetId for each tab so the agent can always address any tab unambiguously; the CLI
accepts any unique prefix on input for convenience. If two tabs share the prefix the
agent tried, scraper errors with "ambiguous prefix, matches N tabs; use more
characters or the full targetId from `scraper tabs`." Full IDs on display, prefix-
tolerant on input.

### Elements — short monotonic refs, per-tab state

Element refs are opaque short strings (`e1`, `e14`, `e47`). Backed by CDP
`backendNodeId`, persisted in `~/.scraper/refs.<targetId>.json`, resolved inside
`eval` via a single injected helper:

```js
$ref("e8")  // → Element, or throws "stale ref" if not in this tab's current refs file
```

### Monotonic counter (session-scoped, cross-tab)

The counter that generates element-ref names **never resets within a Chrome session
and is shared across tabs**. If tab A's snapshot assigns `e1..e14`, tab B's next
snapshot starts at `e15`. No `e3` ever appears in two places. This matters because:

- A stale ref is detected as "not present in this tab's current `refs.<targetId>.json`."
- Since `e3` is minted exactly once across the whole session, there is no possibility
  of it silently re-binding to a different node — either on the same tab or a different
  one.

The counter is persisted in `~/.scraper/counter-refs`. Snapshot/screenshot IDs use
a separate counter at `~/.scraper/counter` since they increment at different rates.

### Stale ref error

```
error: ref e3 is stale — not in refs.4AE7B2C9.json (current refs: e15..e22).
Run `scraper snapshot --tab 4AE7B2C9` and retry with a fresh ref.
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
targetId: 4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2
url: https://memberforms.uhc.com/DirectMedicalReimbursement.html
title: Direct Medical Reimbursement
dialog: null
tree:
  - role: main
    name: Reimbursement Form
    children:
      - role: textbox, name: Member ID, ref: e3
      - role: button, name: Next, ref: e8
```

`targetId` is included so the agent (and anyone reading the file later) can tell
which tab the snapshot came from. Tabs are not included inline here — for the list
of open tabs, the agent calls `scraper tabs` (cheap, no snapshot write).

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

Available on `navigate`, `eval`, `wait`, `upload`. No discriminated-union
`DialogPolicy` type threaded through the domain. One flag, local to the CLI layer.

## State and Filesystem

```
~/.scraper/
├── counter                       # monotonic int for snapshot/screenshot IDs
├── counter-refs                  # monotonic int for element-ref IDs (session-scoped, cross-tab)
├── refs.<targetId>.json          # latest element refs for that tab (overwritten per snapshot)
├── s{N}.yaml                     # snapshot artifacts
└── shot{N}.png                   # screenshot artifacts
```

### refs.<targetId>.json shape

```json
{
  "snapshotId": "s47",
  "refs": {
    "e3": 1234,
    "e8": 1287
  }
}
```

Maps element ref names to CDP `backendNodeId`. Overwritten on every snapshot of the
same tab. Not shared across tabs — each tab has its own file. Dead tabs' leftover
files get cleaned up opportunistically on `scraper tabs` (when we can see which
targetIds no longer exist) or by age (anything older than 24h, matching the
snapshot-artifact rule).

### Active Target Selection

**There is no active target.** Every command that interacts with a page requires
`--tab <targetId>`. Resolution logic is trivial:

1. Parse `--tab <input>` from CLI. `<input>` may be a prefix or a full targetId.
2. Call `/json/list`, find unique match by prefix against the set of live page
   targets. Call the result `canonicalTargetId`.
3. If zero matches: error "no tab with prefix `<input>`; run `scraper tabs` to see
   available tabs."
4. If multiple matches: error "ambiguous prefix `<input>`, matches N tabs; provide
   more characters (full IDs are printed by `scraper tabs`)."
5. **From this point on, every file name, snapshot metadata field, stdout pointer,
   and error message refers to `canonicalTargetId`, not `<input>`.** Ref files live
   at `refs.<canonicalTargetId>.json`, snapshot YAML `targetId:` is the canonical
   form, etc.
6. Attach and run.

This invariant guarantees that if the agent calls
`scraper snapshot --tab 4AE7B2C9` and later `scraper eval --tab 4AE7B2C9E1D4F0...`,
both resolve to the same on-disk refs file and `$ref` continuity holds.

This removes the entire "what should scraper pick on first run?" question — the
agent always picks. The trade-off is command-line verbosity; the payoff is that
there is literally no state to go stale and no heuristic to be wrong about.

**Bootstrap flow (two paths):**

- `scraper tabs` → see what's open → pick a prefix → use it on subsequent commands.
- `scraper navigate --new <url>` → creates a new tab, prints its full targetId on
  stdout, agent copies the prefix.

Commands that need a tab error clearly if `--tab` is missing:

```
error: --tab <targetId> is required. Run `scraper tabs` to list tabs,
or `scraper navigate --new <url>` to open a new one.
```

**Gone:**

- `chrome.json` (no owned-mode state to track)
- `JsonFileStore` generic (one-off file I/O is simpler than the abstraction)
- `StateStore`, `ChromeState`, `OwnedState`/`AttachedState` union, ownership
  classification, `isProcessAlive`, `isOurChromeProcess`, dead-PID recovery,
  foreign-PID handling
- **`activeTargetId` and all three-case resolution logic** (replaced by explicit
  `--tab` on every command)

**Attach behavior on every command:**

Each invocation reads `DevToolsActivePort` from the default Chrome user data
directory, connects to the `--tab <targetId>` Chrome target, runs the command,
closes the connection. No persistent attachment state. First-time users get a
clear error message pointing them at `chrome://inspect/#remote-debugging` if remote
debugging is off.

Channel selection (`--channel beta|canary|dev`) stays as an environment variable or
flag, but without the `attached` vs `owned` branching it's a thin lookup.

## Wait Semantics

Three kinds, unified behind one command:

```
scraper wait --tab <id> --selector "#submit"           # CSS selector appears
scraper wait --tab <id> --text "Thank you"             # text appears anywhere
scraper wait --tab <id> --ref e8 --text "Loaded"       # text appears within ref
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

- `src/aria/` — snapshot pipeline stays, YAML shape gains `targetId:`, `dialog:`,
  `url:`, `title:` header. Widens ref coverage to the full WAI-ARIA widget category.
- `src/cdp/attach.ts` — reused, but caller becomes "every command" not "just start"
- `src/cdp/connection.ts` — preserved; `listPages` becomes the backing call for the
  new `scraper tabs` command
- `src/cdp/network.ts`, `src/cdp/dialog.ts` — preserved
- `src/cdp/input.ts` — trimmed heavily (upload stays, rest goes)
- `src/cdp/resolve.ts` — becomes ref-only; selector branch goes
- `src/cdp/accessibility.ts` — preserved
- `src/main.ts` — shrinks substantially; no ownership bookkeeping, no state store
  wiring, no active-target resolution

Rough estimate: **~40% fewer lines** of code, zero persistent ownership state, no
active-target resolution logic.

## Eval Plumbing

When an `eval --tab <input>` expression contains `$ref("eN")` calls, the CLI
(after canonicalizing `<input>` to the full `canonicalTargetId` — see
[Active Target Selection](#active-target-selection)):

1. Reads `refs.<canonicalTargetId>.json` for the ref-to-backendNodeId map scoped
   to that tab.
2. For each distinct ref in the expression, verifies it is present in that file
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
calls `scraper snapshot --tab <id>` explicitly after evals that mutate the DOM.

## Documentation

Ship a `SKILL.md` at the repo root that teaches Claude Code when and how to use the
tool. Key content:

- Attach semantics ("make sure Chrome is running with remote debugging")
- The 7 commands, one line each, with `--tab <id>` shown as required
- Standard opening move: `scraper tabs` to list, pick a prefix, then operate
- The `$ref` convention and the asymmetric auto-snapshot rule
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
end-to-end using only: `tabs`, `navigate`, `snapshot`, `eval`, `wait`, `upload`. The
agent does not need to reach for an external MCP (chrome-devtools-mcp, browser-use,
etc.) at any point, and does not get stuck on "this tool doesn't work for this field
type, try a different one" — because there is no type-sensitive semantic-action
layer to get stuck on. Writing raw JS (including the React-setter dance) is the
primitive, not a fallback.

The user can continue browsing freely in Chrome (opening tabs, reading, typing)
while Claude is driving a specific tab — because Claude always addresses its tab by
explicit targetId, and there is no "active tab" state that could shift out from
under either party.

Total CLI command count: 7 (from 15). Code size: ~40% reduction. State: per-tab
refs files + two monotonic counters. No process-lifecycle bookkeeping, no active
target, no three-case resolution.
