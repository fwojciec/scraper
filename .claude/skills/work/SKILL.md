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

Invoke the `codex-review` skill (Skill tool, skill=`codex-review`). It blocks, runs a Codex
review of the working tree, and prints findings verbatim. Each review is a paid Codex call —
**never re-run on an unchanged tree** and cap at **2 paid reviews per issue**.

### Act on findings

- **No findings**: proceed to Phase 4.
- **Has findings**: invoke the `superpowers:receiving-code-review` skill (Skill tool,
  skill=`superpowers:receiving-code-review`). Verify each finding against the code before acting,
  and push back with technical reasoning when a finding is wrong. Do not reflexively fix every
  finding — external reviewers lack full context and some findings will be wrong.
- After fixes, re-validate with `deno task ci` and re-review once more (max 2 paid reviews per
  issue). After the 2nd review: apply what you still agree with, proceed — no further reviews.

### Stuck?

If implementation blocks on a non-trivial bug or design question, delegate to the
`codex:codex-rescue` subagent (Agent tool, subagent_type=`codex:codex-rescue`) rather than
spinning. Rescue is not a replacement for review — use it only when actually blocked.

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
- [ ] Codex review passed

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
