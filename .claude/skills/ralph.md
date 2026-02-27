---
name: ralph
description: Execute one iteration of the Ralph loop - pick next open issue from milestone, implement, review, merge
argument-hint: "<milestone-name>"
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, Skill
---

# Ralph Iterate

One task from a GitHub milestone. Fully autonomous — no user interaction.

Issues processed by number (ascending). Exit cleanly so the loop can restart.

## Arguments

Milestone: $ARGUMENTS

## Current State

Branch: !`git branch --show-current`
Uncommitted changes: !`git status --porcelain`

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
roborev review --dirty --wait
```

Run `roborev review` exactly once — each invocation is a paid review.

**PASS**: proceed. **FAIL**: `roborev fix`, re-validate, re-review. After 2 failed cycles, yield.

### Yield (persistent failure)

Comment learnings on issue, abandon branch, return to main. Do NOT create `.ralph-complete` — loop will retry with improved context.

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
