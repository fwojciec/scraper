# CLI reference

Seven commands. All commands except `tabs` and `navigate --new` require `--tab <id>`.

`<id>` is a unique prefix of a target's full hex id (or the full id itself). `scraper tabs` prints
full ids; the first 8 hex chars are usually enough. Ambiguous prefixes error with a list.

Exit code is `0` on success, `1` on any error. Errors print to stderr prefixed `error:`.

## Global behaviour

**Attach-only.** Every invocation reads `DevToolsActivePort` from the Chrome user data directory,
opens a fresh CDP connection, does its work, and closes. There is no persistent session and no
notion of an "active tab."

**Dialog handling.** Native JS dialogs (`alert`, `confirm`, `prompt`, `beforeunload`) are dismissed
by default. Override per-command with `--on-dialog`:

- `--on-dialog dismiss` — explicit dismiss (same as default)
- `--on-dialog accept` — accept with no prompt text
- `--on-dialog accept:<text>` — accept a `prompt()` with `<text>` as its value

Any dialog that fires during a command is reported in that command's snapshot under the top-level
`dialog:` key.

**Auto-snapshot rule.** `navigate` and `wait` (on success) auto-snapshot because the page just
changed. `eval` and `upload` do not — many evals are reads, and snapshotting reads would invalidate
refs for nothing. After an `eval` or `upload` that mutated the DOM, run `scraper snapshot` with
`--tab <id>` explicitly.

**Pointer line.** Commands that auto-snapshot print a single line to stdout:

```
navigated · snapshot s47 · "Direct Medical Reimbursement" · 14 refs · 8421B
waited · snapshot s48 · "Step 2" · 22 refs · 11240B
snapshot s49 · "Inbox (42)" · 31 refs · 15012B
```

Shape: `[<verb> · ]snapshot s{N} · <title|url> · <n> refs · <bytes>B`. The full YAML tree lives on
disk at `~/.scraper/s{N}.yaml`.

---

## `tabs`

```
scraper tabs
```

List open page tabs. Prints one line per tab:

```
<targetId>\t<url>\t<JSON-encoded title>
```

Fields are tab-separated; title is JSON-encoded so embedded whitespace, quotes, and newlines are
unambiguous.

After a successful list, scraper opportunistically deletes `refs.<targetId>.json` files for tabs
that no longer exist.

Errors: connection failure, Chrome not reachable.

---

## `navigate`

```
scraper navigate --tab <id> <url>
scraper navigate --new <url>
```

Navigate to `<url>` and wait for network idle. Auto-snapshots on success.

Flags:

- `--tab <id>` — target an existing tab. Mutually exclusive with `--new`.
- `--new` — create a new tab first (via `Target.createTarget`). Prints the new tab's full `targetId`
  on its own line _before_ the snapshot pointer, so the caller can address it on later commands.
- `--on-dialog <policy>` — see [Dialog handling](#global-behaviour).

Stdout:

```
# --tab form
navigated · snapshot s47 · <label> · <n> refs · <bytes>B

# --new form
<full-targetId>
navigated · snapshot s47 · <label> · <n> refs · <bytes>B
```

A "network idle timed out" warning is printed to stderr when the page is still loading after the
idle window; the command still succeeds.

---

## `snapshot`

```
scraper snapshot --tab <id> [--selector <css>] [--max-depth N] [--max-nodes N]
```

Generate an ARIA snapshot of the current page. Writes `~/.scraper/s{N}.yaml` and a sibling
`refs.<targetId>.json` mapping ref tokens (`e1`, `e2`, …) to CDP node handles.

Flags:

- `--selector <css>` — scope the tree to the matching element's subtree. If the selector does not
  match, the snapshot renders an empty tree (no refs minted).
- `--max-depth N` — cap tree depth.
- `--max-nodes N` — cap total node count.

Stdout: the pointer line (no leading verb).

Ref counter is monotonic across tabs for the session; you will never see two `e3`s refer to
different elements within one Chrome session.

---

## `eval`

```
scraper eval --tab <id> '<expression>' [--on-dialog <policy>]
```

Evaluate a JS expression in the page. Prints the JSON-encoded result to stdout (pretty-printed,
two-space indent). `$ref("eN")` inside the expression resolves to the live DOM element for ref `eN`.

Does not auto-snapshot. Run `scraper snapshot --tab <id>` afterwards if the expression mutated the
DOM.

Stale `$ref` → exits 1 with:

```
error: ref e3 is stale — not in refs.<full-targetId>.json (current refs: e15..e22).
Run `scraper snapshot --tab <full-targetId>` and retry with a fresh ref.
```

Multi-statement expressions work — the expression is passed to `Runtime.callFunctionOn`, so `const`,
statements, and early returns are fine. `this` is not `window` (it's the function's own `this`);
top-level `var` is function-scoped.

---

## `wait`

```
scraper wait --tab <id> --selector <css>                     [--timeout <ms>]
scraper wait --tab <id> --text <text>                        [--timeout <ms>]
scraper wait --tab <id> --ref <ref> --text <text>            [--timeout <ms>]
```

Wait for one of three conditions. Default timeout is 30_000ms.

- `--selector <css>` — a CSS selector matches.
- `--text <text>` — the text appears anywhere on the page.
- `--ref <ref> --text <text>` — the text appears inside the element bound to `<ref>`.

Auto-snapshots on success; pointer line to stdout. Timeout exits 1 with the timeout error to stderr
— no pointer printed.

Stale `--ref` raises the same canonical stale-ref error as `eval` and `upload`.

`--ref` requires `--text`; `--ref` and `--selector` are mutually exclusive.

---

## `upload`

```
scraper upload --tab <id> --ref <ref>       <path>
scraper upload --tab <id> --selector <css>  <path>
```

Upload a file to an `<input type="file">`. Works only on file inputs — scraper calls CDP
`DOM.setFileInputFiles` directly, bypassing the OS file picker.

Does not auto-snapshot. Run `scraper snapshot --tab <id>` afterwards if the upload altered the form.
Stale `--ref` raises the canonical stale-ref error.

Stdout: `uploaded to ref <ref>` or `uploaded to selector "<css>"`.

---

## `screenshot`

```
scraper screenshot --tab <id>
```

Capture a viewport PNG. Writes `~/.scraper/shot{N}.png` and prints its absolute path to stdout.

No snapshot, no dialog handling (the capture is a pure CDP round-trip).

---

## Artifact directory

Everything lives under `~/.scraper/`:

```
counter                monotonic int for snapshot/screenshot ids (shared)
counter-refs           monotonic int for element-ref ids (session-scoped, cross-tab)
state.lock             advisory flock serializing counter allocations
refs.<targetId>.json   per-tab ref → CDP node handle map (overwritten per snapshot)
s{N}.yaml              snapshot artifacts
shot{N}.png            screenshot artifacts
```

After every snapshot or screenshot write, scraper prunes: keep the newest 20 `s*.yaml` + `shot*.png`
artifacts, delete anything older than 24 hours. Ref files and counters are not touched by the sweep.

Concurrent `scraper snapshot` and `scraper screenshot` invocations serialize on `state.lock` so two
parallel processes cannot mint colliding `sN` ids or overlapping ref ranges. The Chrome round-trip
for `screenshot` runs outside the lock — only the counter allocation and disk write are serialized.
