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
- Foreground-tab implicit addressing (no persisted page selection)
- ARIA snapshots written to disk, returned as pointers
- Arbitrary JS evaluation against snapshot-identified elements
- File upload (CDP `DOM.setFileInputFiles` — the one thing JS can't do)
- Selector/text waits, screenshots, tab switching

**Out:** Owned Chrome launch, headless mode, stop command, page-selection state,
semantic action commands (`click`/`fill`/`type`/`select`/`submit`/`press-key`),
per-action `DialogPolicy` plumbing, self-healing helper files, form-helper stdlib
(deferred until observed repetition justifies it), frames/iframes, shadow DOM, drag
and drop, network interception, cookie manipulation.

## Command Surface (7 commands)

| Command | Purpose | Auto-snapshot? |
|---|---|---|
| `scraper navigate <url>` | Navigate foreground tab (or open one). Waits for network idle. | Yes |
| `scraper snapshot` | Capture ARIA tree + tabs + dialog state. | — (it *is* the snapshot) |
| `scraper eval '<expr>'` | Evaluate JS in the page with `$ref(id)` helper bound. | Yes |
| `scraper wait ...` | Wait for selector, text, or text-in-ref. | Yes on success |
| `scraper tab <ref>` | Activate a tab by its ref from the latest snapshot. | Yes |
| `scraper upload --ref R3 <path>` | `DOM.setFileInputFiles` on the element. | Yes |
| `scraper screenshot` | Capture a PNG of the viewport. | No — returns image path |

### Auto-snapshot rule

Every command that changes page state writes a fresh snapshot and returns a one-line
pointer to stdout. The agent reads the file via Claude Code's `Read` tool when it needs
the content. This keeps the token cost of auto-snapshotting near zero.

Example:

```
$ scraper navigate https://memberforms.uhc.com/DirectMedicalReimbursement.html
navigated · snapshot s47 · "Direct Medical Reimbursement" · 14 refs · 8421B

$ scraper eval '$ref("R8").click()'
undefined
snapshot s48 · step 2 visible · 22 refs · 11240B
```

### Deleted commands

`start`, `stop`, `pages`, `page <id>`, `click`, `fill`, `type`, `select`, `submit`,
`press-key`. `start` becomes implicit (first command attaches). Everything else is
subsumed by `eval` or removed.

## Handle Scheme

Opaque refs (`R3`, `R47`) assigned during snapshot, persisted in `refs.json`,
backed by CDP `backendNodeId`. Resolved inside `eval` via a single injected helper:

```js
$ref("R8")  // → Element, or throws "stale ref" if snapshot has been replaced
```

Refs are valid only against the latest snapshot. Using a ref from `s47` after `s49`
exists is an error. Agent must re-snapshot and retry.

`$ref` is the *only* helper preloaded into the eval context. No `$`, no `$$`, no
form-manipulation helpers, no React-setter wrapper. Agents write raw JS. A
shipped-stdlib for common patterns (fill-with-react-setter, scroll-to-bottom, etc.)
is a future addition, driven by observed repetition — not speculation.

Tab refs (`T1`, `T2`) follow the same scheme but are scoped to tabs, usable only with
the `tab` command.

## Snapshot Artifact

Snapshots are written to `~/.scraper/s{N}.yaml` with a monotonic counter shared across
all artifacts (snapshots and screenshots). Screenshots are `~/.scraper/shot{N}.png`
using the same counter space, so numbering preserves the timeline at a glance.

### YAML shape

```yaml
snapshot: s47
url: https://memberforms.uhc.com/DirectMedicalReimbursement.html
title: Direct Medical Reimbursement
tabs:
  - ref: T1
    active: true
    url: https://memberforms.uhc.com/...
    title: Direct Medical Reimbursement
  - ref: T2
    url: https://mail.google.com/...
    title: Inbox
dialog: null
tree:
  - role: main
    name: Reimbursement Form
    children:
      - role: textbox, name: Member ID, ref: R3
      - role: button, name: Next, ref: R8
```

`tabs:` is always present, so the agent never needs a separate `pages` command.
`dialog:` surfaces any JavaScript dialog that appeared since the last snapshot (see
[Dialog Handling](#dialog-handling)).

### Cleanup

On every snapshot write: keep the newest 20 artifacts in `~/.scraper/`, delete any
older than 24 hours. Opportunistic, no daemon.

Old ids are never reused. Counter is persisted in `~/.scraper/counter`.

## Dialog Handling

Native JS dialogs (`alert`, `confirm`, `prompt`, `beforeunload`) cannot be handled from
page JS. They require CDP `Page.handleJavaScriptDialog`.

**Default:** auto-**dismiss**. Safer default — "say no to the thing I didn't ask for."
Dialog text appears in the next auto-snapshot under a `dialog:` key so the agent
observes that it happened and can retry with an explicit accept if needed.

**Override flag** (single, simple):

- `--on-dialog accept` — accept with no text
- `--on-dialog accept:<text>` — accept with prompt text
- `--on-dialog dismiss` — explicit dismiss (same as default)

Available on `navigate`, `eval`, `wait`, `tab`, `upload`. No discriminated-union
`DialogPolicy` type threaded through the domain. One flag, local to the CLI layer.

## State and Filesystem

```
~/.scraper/
├── counter          # monotonic int
├── refs.json        # current ref → backendNodeId map (latest snapshot only)
├── s{N}.yaml        # snapshot artifacts
└── shot{N}.png      # screenshot artifacts
```

**Gone:**

- `chrome.json` (no owned-mode state to track)
- `JsonFileStore` generic (one-off file I/O is simpler than the abstraction)
- `StateStore`, `ChromeState`, `OwnedState`/`AttachedState` union, ownership
  classification, `isProcessAlive`, `isOurChromeProcess`, dead-PID recovery,
  foreign-PID handling

**Attach behavior on every command:**

Each invocation reads `DevToolsActivePort` from the default Chrome user data directory,
connects, runs the command, closes the connection. No persistent attachment state.
First-time users get a clear error message pointing them at
`chrome://inspect/#remote-debugging` if remote debugging is off.

Channel selection (`--channel beta|canary|dev`) stays as an environment variable or
flag, but without the `attached` vs `owned` branching it's a thin lookup.

## Wait Semantics

Three kinds, unified behind one command (unchanged from current):

```
scraper wait --selector "#submit"           # CSS selector appears
scraper wait --text "Thank you"             # text appears anywhere
scraper wait --ref R8 --text "Loaded"       # text appears within ref
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

When an eval expression contains `$ref("Rn")` calls, the CLI:

1. Reads `refs.json` for the current snapshot's ref-to-backendNodeId map.
2. For each distinct ref in the expression, resolves `backendNodeId` to a live
   `objectId` via CDP `DOM.resolveNode`.
3. Passes the expression to CDP `Runtime.callFunctionOn` with the resolved nodes
   bound as arguments, and a preamble that defines `$ref` as a lookup over those
   arguments.
4. Errors with a clear "stale ref Rn — re-snapshot" message if the backendNodeId no
   longer resolves.

If the expression uses no `$ref`, the CLI skips the resolution step and just runs
`Runtime.evaluate`.

The agent sees eval's return value (JSON-serialized) followed by the auto-snapshot
pointer line.

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
  DOM node's outerHTML)? Or is that just `eval '$ref("R3").outerHTML'`? (Latter.
  Skip the command.)

## Success Criteria

The UHC form in `/Users/filip/Desktop/Invoices/CLAUDE.md` can be filled and submitted
end-to-end using only: `navigate`, `snapshot`, `eval`, `wait`, `upload`. No agent-side
workarounds, no reach for an external MCP, no "this tool doesn't work for this field
type, try a different one."

Total CLI command count: 7 (from 15). Code size: ~40% reduction. State: one store
for refs + one counter, no process-lifecycle bookkeeping.
