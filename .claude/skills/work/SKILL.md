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

Run `roborev review` exactly once — each invocation is a paid review. **NEVER re-run this command**
to "retry" — a second run creates a second paid review.

Use this exact command (the trailing `echo` prevents the Bash tool from framing exit 1 as an error):

```bash
roborev review --dirty --wait; echo "ROBOREV_EXIT=$?"
```

### Reading results

`--wait` produces **no stdout** — all signal is in the exit code captured by the `echo`:

- `ROBOREV_EXIT=0` → review passed → proceed to Phase 4
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
