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

Run `roborev review` exactly once — each invocation is a paid review. **NEVER re-run this command**
to "retry" — a second run creates a second paid review.

Use this exact command (the trailing `echo` prevents the Bash tool from framing exit 1 as an error):

```bash
roborev review --dirty --wait; echo "ROBOREV_EXIT=$?"
```

### Reading results

`--wait` produces **no stdout** — all signal is in the exit code captured by the `echo`:

- `ROBOREV_EXIT=0` → review passed → proceed to Phase 5
- `ROBOREV_EXIT=1` → review has findings (this is NOT a failure) → read them

**IMPORTANT**: exit 1 means "findings exist", not "command failed". Do NOT re-run the command.

To read findings, get the job ID from `roborev status`, then `roborev show <job-id>`:

```bash
roborev status          # find latest job ID
roborev show <job-id>   # read findings (only works after job finishes)
```

If `roborev show` says "no review found", the job is still running — check `roborev status` and
wait.

**PASS**: proceed. **FAIL**: read findings with `roborev show`. Exercise judgment — fix findings you
agree with at any severity, skip ones you don't. You have better context than a separate fix agent.
Re-validate with `deno task ci`, then re-review once more (max 2 paid reviews per issue). After the
2nd review: fix what you agree with, proceed — no further reviews.

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
