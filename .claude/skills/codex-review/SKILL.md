---
name: codex-review
description: Run a blocking, non-interactive Codex review of the working tree and return findings verbatim. Use when automation (ralph, work, pre-commit gates) needs a one-shot review without the interactive wait-vs-background prompt.
allowed-tools: Bash
---

# Codex Working-Tree Review

One-shot, non-interactive review of the current working tree (staged + unstaged + untracked). Blocks
until Codex finishes and prints findings verbatim.

The slash-command `/codex:review` is interactive — it asks whether to wait or run in the background.
This skill wraps the underlying `codex-companion.mjs` script with `--wait --scope working-tree` so
it is safe to call from autonomous loops.

## When to use

- `ralph` / `work` skills or any automation that needs a review without prompts.
- A pre-commit gate before the skill commits its work.

Not for: branch-level reviews across many commits (use `/codex:review --scope branch` manually),
adversarial or design reviews (use `/codex:adversarial-review`), or Codex-driven fixing (use
`/codex:rescue`).

## Pre-flight

Codex must be installed and authenticated. If the command fails with "codex plugin missing" or an
auth error, run `/codex:setup` and retry.

## Run

```bash
CODEX=$(ls -d ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null | sort -V | tail -1)
[ -z "$CODEX" ] && { echo "codex plugin missing — run /codex:setup" >&2; exit 1; }
node "$CODEX" review --wait --scope working-tree
```

- `--wait` runs in the foreground and blocks until complete — no polling needed.
- `--scope working-tree` covers staged, unstaged, and untracked files (equivalent to the old
  `roborev review --dirty`).
- stdout is the full Codex verdict. Return it verbatim — do not paraphrase.

## Cost guardrail

Each invocation is a paid Codex call. **Never re-run on an unchanged working tree to "retry".**
Callers (ralph, work) enforce their own per-issue review budget; this skill does not.

## Output contract

Codex prints a block containing: verdict, summary, findings (severity + file:line + description),
and any follow-up suggestions. The calling skill consumes that block directly — no further
processing here.
