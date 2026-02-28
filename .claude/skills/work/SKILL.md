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

Run `roborev review` exactly once — each invocation is a paid review.

```bash
roborev review --dirty --wait
```

### Reading results

`--wait` produces **no stdout**. Interpret the exit code:

- **exit 0** → review passed → proceed
- **exit 1** → review had findings → read them with `roborev show <job-id>`

The job ID is printed by the initial `roborev review --dirty` line (e.g. `Enqueued dirty review job 578`). If you missed it, use `roborev status` to find the latest job ID, then `roborev show <job-id>`.

`roborev show` only works **after** the job finishes. If it says "no review found", the job is still
running — check `roborev status` and wait.

**PASS**: proceed. **FAIL**: read findings with `roborev show <job-id>`. Exercise judgment — fix
findings you agree with at any severity, skip ones you don't. You have better context than a
separate fix agent. Re-validate with `deno task ci`, then re-review once more (max 2 paid reviews
per issue). After the 2nd review: fix what you agree with, proceed — no further reviews.

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
