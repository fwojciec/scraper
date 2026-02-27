---
name: gh-workflow
description: Use when creating GitHub issues, organizing milestones, or replying to PR review comments via CLI
---

# GitHub Workflow

## Issue Template (mandatory)

### Context

WHAT and WHY, never HOW.

### Investigation Starting Points

- Relevant files, functions, tests

### Scope Constraints

- What is NOT in scope

### Validation

- Testable acceptance criteria

## Milestones

Issues executed sequentially by number (ascending). Order matters.

```bash
gh api repos/{owner}/{repo}/milestones -f title="v0.1" -f description="..."
gh issue create --title "..." --body "..." --milestone "v0.1"
gh issue list --milestone "v0.1" --state open --json number,title --jq 'sort_by(.number)'
```

## PR Review Comments

```bash
# Reply to inline review comment
gh api repos/{owner}/{repo}/pulls/<pr>/comments -f body="..." -F in_reply_to=<comment_id>

# List review comments to find IDs
gh api repos/{owner}/{repo}/pulls/<pr>/comments
```
