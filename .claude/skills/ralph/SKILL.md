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

Run `roborev review` exactly once — each invocation is a paid review. **NEVER re-run to "retry".**

### Step 1: Submit

```bash
roborev review --dirty
```

This prints a job ID and returns immediately. Note the job ID.

### Step 2: Wait for results

Poll until the job finishes (usually 30-90 seconds):

```bash
roborev status
```

When status shows the job is complete, read findings:

```bash
roborev show <job-id>
```

If `roborev show` says "no review found", the job is still running — wait and re-check status.

### Step 3: Act on findings

- **No findings**: proceed to Phase 5.
- **Has findings**: exercise judgment — fix findings you agree with at any severity, skip ones you
  don't. You have better context than a separate fix agent. Re-validate with `deno task ci`, then
  re-review once more (max 2 paid reviews per issue). After the 2nd review: fix what you agree with,
  proceed — no further reviews.

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
