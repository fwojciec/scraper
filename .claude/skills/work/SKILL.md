---
name: work
description: Use when picking up a GitHub issue to implement, or when asked to work on an issue by number
argument-hint: "[issue-number]"
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, Skill, AskUserQuestion
---

# Work on GitHub Issue

Issue -> branch -> implement -> review -> PR. Minimal user interaction.

## Current State

Branch: !`git branch --show-current` Uncommitted changes: !`git status --porcelain`

## Arguments

$ARGUMENTS

---

## Phase 1: Setup

Pre-flight:

- [ ] On `main` branch (ask if not)
- [ ] Clean working tree (ask if not)

If no issue in $ARGUMENTS, list open issues and let user pick:

```bash
gh issue list --state open --json number,title,labels --limit 20
```

Read issue **including comments** (earlier work leaves context):

```bash
gh issue view <number> --comments
```

Create branch: `<number>-<short-kebab-description>`

---

## Phase 2: Implement

TDD (RED-GREEN-REFACTOR) for logic. Skip for types/config/wiring.

Validate frequently: `deno task ci`

Do NOT commit until after review.

---

## Phase 3: Review

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

- **No findings**: proceed to Phase 4.
- **Has findings**: exercise judgment — fix findings you agree with at any severity, skip ones you
  don't. You have better context than a separate fix agent. Re-validate with `deno task ci`, then
  re-review once more (max 2 paid reviews per issue). After the 2nd review: fix what you agree with,
  proceed — no further reviews.

---

## Phase 4: Finish

Commit:

```bash
git add .
git commit -m "$(cat <<'EOF'
<issue-title>

<brief description>

Closes #<number>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
deno task ci
```

Create PR:

```bash
git push -u origin <branch>
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
<2-3 bullets>

Closes #<number>

## Test Plan
- [ ] `deno task ci` passes
- [ ] roborev review passed

Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Comment on issue with PR URL, then ask user: merge / leave / keep working.

**Merge**:

```bash
gh pr merge <pr> --squash --delete-branch
git checkout main && git pull origin main
```
