---
description: Generate PR description from branch commits
agent: talk 
model: openai/gpt-5.4-mini-fast
---

Creates a clear, concise PR description by analyzing your branch's commit history—saving you time and ensuring consistent documentation.

## What You Get

A short, well-structured paragraph that describes your changes, automatically determining whether they "fix" or "implement" something based on your commit messages.

## Optional Context

Add `$ARGUMENTS` to provide additional context beyond commit messages. Useful when:
- Your commits don't tell the full story
- You want to highlight specific aspects
- You need to clarify intent or scope

## How It Works

### Prerequisites

**Git repository check:**
!`git rev-parse --git-dir`

**Current branch:**
!`git branch --show-current`

**Commit messages:**
!`git log main..HEAD --pretty=format:"%s"`

### Process

1. **Verify git repo** → Exit if not in git repository

2. **Determine base branch** → Uses `main` as the comparison point

3. **Get commit messages** → Fetches all commits between main and your current branch; exits if none exist

4. **Detect change type** → Scans for fix keywords (fix, fixup, bugfix, etc.)
   - Found fix keywords → Uses "fixes"
   - Otherwise → Uses "implements"

5. **Generate summary** → Creates a paragraph starting with "This PR ${TYPE}...", incorporating any `$ARGUMENTS` you provided as context

6. **Output result** → Returns the formatted description

## Error Handling

| Error | What It Means |
|-------|---------------|
| Not in git repo | Run this command from within a git repository |
| No commits on branch | Make at least one commit before summarizing |
| Base branch not found | Ensure `main` branch exists or create it |
