---
name: ralph
description: Use when autonomously processing a GitHub milestone, or when running in a loop to iterate through open issues
argument-hint: "<milestone-name>"
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, Skill
---

# Ralph Iterate

One task from a GitHub milestone. Fully autonomous — no user interaction.

Issues processed by number (ascending). Exit cleanly so the loop can restart.

## Arguments

Milestone: $ARGUMENTS

## Current State

Branch: !`git branch --show-current` Uncommitted changes: !`git status --porcelain`

---

## Phase 1: Find Next Task

```bash
gh issue list --milestone "$ARGUMENTS" --state open --json number,title --jq 'sort_by(.number)'
```

No open issues → `touch .ralph-complete` and exit.

Take lowest number. Read with comments:

```bash
gh issue view <number> --comments
```

---

## Phase 2: Setup

```bash
git checkout main && git pull origin main
```

Stash uncommitted changes if any. Create branch: `<number>-<short-kebab-description>`

---

## Phase 3: Implement

TDD for features. For refactoring: change, fix, update tests.

Validate frequently: `deno task ci`

Do NOT commit until after review.

---

## Phase 4: Review

```bash
deno task ci
git add .
```

Invoke the `codex-review` skill (Skill tool, skill=`codex-review`). It blocks, runs a Codex review
of the working tree, and prints findings verbatim. Each review is a paid Codex call — **never re-run
on an unchanged tree** and cap at **2 paid reviews per issue**.

### Act on findings

- **No findings**: proceed to Phase 5.
- **Has findings**: invoke the `superpowers:receiving-code-review` skill (Skill tool,
  skill=`superpowers:receiving-code-review`). Verify each finding against the code before acting,
  and push back with technical reasoning when a finding is wrong. Do not reflexively fix every
  finding — external reviewers lack full context and some findings will be wrong.
- After fixes, re-validate with `deno task ci` and re-review once more (max 2 paid reviews per
  issue). After the 2nd review: apply what you still agree with, proceed — no further reviews.

### Stuck?

If implementation blocks on a non-trivial bug or design question, delegate to the
`codex:codex-rescue` subagent (Agent tool, subagent_type=`codex:codex-rescue`) rather than spinning.
Rescue is not a replacement for review — use it only when actually blocked.

---

## Phase 5: Complete

Commit, merge to main, push:

```bash
git add .
git commit -m "$(cat <<'EOF'
<issue-title>

<brief description>

Closes #<number>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
git checkout main && git pull origin main
git merge <branch> --no-edit && git push origin main
git branch -d <branch>
```

Close issue with summary comment. Post context to next 1-3 open issues if genuinely useful.

Exit cleanly — do NOT create `.ralph-complete`.
