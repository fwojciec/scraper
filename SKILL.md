---
name: scraper
description: Drive a running Chrome tab via CDP — list tabs, navigate, snapshot ARIA, eval raw JS with $ref, wait, upload, screenshot. Use when automating a real browser the user can keep using alongside you.
---

# scraper

Seven commands that drive a live Chrome tab over the DevTools Protocol. The user keeps browsing; you
address a specific tab by its `targetId`. No semantic-action layer — when you need to click, fill,
submit, or read form state, write raw JS with `eval` and let `$ref` resolve element handles.

## Attach semantics

Every command opens a fresh CDP connection, does its work, closes. There is no persistent session
and no "active tab."

Chrome must already be running with remote debugging enabled. If `scraper tabs` errors with
"DevToolsActivePort not found," the user needs to start Chrome with `--remote-debugging-port=0`.
Tell them that and stop — do not try to launch Chrome yourself.

Scraper reads `DevToolsActivePort` from the Chrome user data directory. Default channel is stable;
override with the `SCRAPER_CHROME_CHANNEL` env var (`beta` | `canary` | `dev` | `stable`) or point
at a custom directory with `SCRAPER_USER_DATA_DIR`.

## Standard opening move

1. `scraper tabs` → full targetIds, URLs, titles on stdout (tab-separated).
2. Pick a unique prefix (first 8 hex chars is usually enough).
3. Pass it via `--tab <prefix>` on every subsequent command. Scraper canonicalises it to the full id
   internally.

```
$ scraper tabs
4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2	https://memberforms.uhc.com/...	"Direct Medical Reimbursement"
9F3BA1C2D7E4F1A8B5C3E9F6A4D2B0C5	https://mail.google.com/...	"Inbox"

$ scraper navigate --tab 4AE7B2C9 https://example.com
```

`scraper navigate --new <url>` creates a new tab; it prints the new full targetId on its own line,
then the snapshot pointer. Copy the targetId for subsequent commands.

## The seven commands

Every command except `tabs` and `navigate --new` requires `--tab <id>`.

| Command                                     | What it does                                                 | Auto-snapshots? |
| ------------------------------------------- | ------------------------------------------------------------ | --------------- |
| `scraper tabs`                              | List open page tabs (full targetId, URL, title).             | No              |
| `scraper navigate --tab <id> <url>`         | Navigate that tab; wait for network idle.                    | **Yes**         |
| `scraper navigate --new <url>`              | Create a new tab, print its targetId, navigate.              | **Yes**         |
| `scraper snapshot --tab <id>`               | ARIA snapshot → `~/.scraper/s{N}.yaml`. Refreshes refs.      | —               |
| `scraper eval --tab <id> '<expr>'`          | Run JS in page. `$ref("eN")` bound. JSON result on stdout.   | **No**          |
| `scraper wait --tab <id> ...`               | Wait for selector / text / text-in-ref. Default 30s.         | **Yes** on ok   |
| `scraper upload --tab <id> --ref eN <path>` | `DOM.setFileInputFiles` — works on `<input type=file>` only. | **No**          |
| `scraper screenshot --tab <id>`             | Viewport PNG → `~/.scraper/shot{N}.png`. Prints the path.    | No              |

`snapshot` accepts optional scoping flags for large pages: `--selector "<css>"` restricts the tree
to that subtree, `--max-depth N` caps tree depth, `--max-nodes N` caps total nodes. `upload` accepts
`--selector "<css>"` as an alternative to `--ref` when you already know the CSS path.

## Auto-snapshot rule (asymmetric — this matters)

`navigate` and `wait` (on success) auto-snapshot because the page just changed. `eval` and `upload`
do **not** auto-snapshot — many evals are reads, and auto-snapshotting reads would invalidate your
current refs for nothing.

After an `eval` or `upload` that **mutated the DOM**, call `scraper snapshot --tab <id>` explicitly
to refresh refs. After a pure read, don't.

## Pointer lines on stdout

Commands that auto-snapshot print a single line:

```
navigated · snapshot s47 · "Direct Medical Reimbursement" · 14 refs · 8421B
waited · snapshot s48 · "Step 2" · 22 refs · 11240B
snapshot s49 · "Inbox (42)" · 31 refs · 15012B
```

Shape: `[verb · ]snapshot s{N} · <title|url> · <n> refs · <bytes>B`. The full YAML tree lives on
disk at `~/.scraper/s{N}.yaml` — only read it when you need the tree.

## The `$ref` convention

`scraper snapshot` writes a YAML tree and a sibling `refs.<targetId>.json` that maps short ref
tokens (`e1`, `e14`, `e47`) to CDP node handles. Inside `scraper eval` only, the expression is
wrapped so that `$ref("e8")` resolves to the live DOM element.

```
$ scraper eval --tab 4AE7B2C9 '$ref("e8").textContent'
"Submit"
```

**Available only in `eval`.** Not in `wait --selector`, not in `wait --text`, and not anywhere else
— those take raw CSS selectors or text.

**Stale refs throw.** The ref counter is monotonic across tabs for the whole Chrome session. When
`e3` is not in the tab's current refs file, you get:

```
error: ref e3 is stale — not in refs.<full-targetId>.json (current refs: e15..e22).
Run `scraper snapshot --tab <full-targetId>` and retry with a fresh ref.
```

Recovery is always: run `snapshot`, read the new tree, pick a fresh ref.

**Multi-statement expressions work.** The expression is passed to `Runtime.callFunctionOn`, so you
can write:

```js
const el = $ref("e3");
el.dispatchEvent(new Event("input", { bubbles: true }));
el.value;
```

Caveat: `$ref` runs inside a function, so top-level `var` is function-scoped and `this` is not
`window`. For the React-setter dance below this doesn't bite.

## Raw-JS eval patterns

There is **no `fill`, `click`, `type`, `submit`, `select`**. Write the JS. This is not a fallback;
it is the primitive.

### React / controlled input — set value + fire events

Just assigning `el.value = "x"` does not notify React. Use the native setter and dispatch events:

```
$ scraper eval --tab 4AE7B2C9 '
  const el = $ref("e3");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(el, "Emil");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
'
```

For `<textarea>`, replace `HTMLInputElement` with `HTMLTextAreaElement`. For `<select>`, use
`HTMLSelectElement`.

### Click a deeply-nested element

```
$ scraper eval --tab 4AE7B2C9 '$ref("e12").click()'
```

If the element is inside a custom element / shadow DOM and `$ref` didn't find it, fall back to
`document.querySelector(...)` in the eval body.

### Scroll a container so an element is in view

```
$ scraper eval --tab 4AE7B2C9 '$ref("e12").scrollIntoView({ block: "center" })'
```

### Read form state in one round-trip

```
$ scraper eval --tab 4AE7B2C9 '
  const form = document.querySelector("form");
  JSON.stringify(Object.fromEntries(new FormData(form)))
'
```

### Submit a form (not via a button)

```
$ scraper eval --tab 4AE7B2C9 'document.querySelector("form").requestSubmit()'
```

## `wait` variants

```
scraper wait --tab <id> --selector "#done"                  # CSS selector appears
scraper wait --tab <id> --text "Thank you"                  # text appears anywhere
scraper wait --tab <id> --ref e8 --text "Loaded"            # text appears inside ref
```

`--timeout <ms>` overrides the 30s default. On timeout, scraper exits 1 with the error on stderr —
no pointer line on stdout.

## Dialog handling

Native JS dialogs (`alert`, `confirm`, `prompt`, `beforeunload`) cannot be handled from page JS —
CDP has to dismiss or accept them. Scraper does this automatically:

- **Default: dismiss** (the safe "say no" choice).
- Override with `--on-dialog accept` or `--on-dialog accept:<text>` (for `prompt`) on `navigate`,
  `eval`, `wait`, `upload`.
- Any dialog that fires **during** the command is reported in the snapshot it produces, under the
  top-level `dialog:` key:

```yaml
dialog:
  type: confirm
  message: "Are you sure?"
  handled: dismiss
```

`null` when no dialog fired.

### Known limitation — inter-command dialogs

A dialog that opened **between** scraper commands (e.g. fired from a `setTimeout` after the previous
command returned) will NOT be observed on the next command's snapshot. CDP does not replay missed
`javascriptDialogOpening` events on reattach. The dialog stays pending inside Chrome and the next
interaction may hang or error. `--on-dialog` does not help — it only wires a response to a _fresh_
opening event.

Recovery: tell the user to dismiss the dialog in Chrome's UI, then retry.

## Artifact directory

Everything lives under `~/.scraper/`:

```
counter                monotonic int for snapshot/screenshot ids
counter-refs           monotonic int for element-ref ids (session-scoped, cross-tab)
refs.<targetId>.json   per-tab ref → backendNodeId map (overwritten per snapshot)
s{N}.yaml              snapshot artifacts
shot{N}.png            screenshot artifacts
```

On every snapshot/screenshot write, scraper keeps the newest 20 snapshot+screenshot artifacts and
drops anything over 24 hours old. Ref files and counters are untouched by the retention sweep.

## Quick recipes

**Fill and submit a form (read-only flow first, then act):**

```
scraper navigate --tab 4AE7B2C9 https://example.com/form
# read the snapshot at ~/.scraper/s{N}.yaml to find refs
scraper eval --tab 4AE7B2C9 '
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call($ref("e3"), "Emil");
  $ref("e3").dispatchEvent(new Event("input", { bubbles: true }));
  $ref("e3").dispatchEvent(new Event("change", { bubbles: true }));
'
scraper snapshot --tab 4AE7B2C9     # refresh refs after a DOM mutation
scraper eval --tab 4AE7B2C9 '$ref("e8").click()'
scraper wait --tab 4AE7B2C9 --text "Thank you"
```

**Recover from a stale ref:**

```
scraper snapshot --tab 4AE7B2C9
# pick the matching role/name from the new tree, read its ref, retry
```
