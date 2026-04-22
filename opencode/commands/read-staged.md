---
description: Read and display staged git changes
agent: talk 
model: openai/gpt-5.4-mini-fast
---

Shows staged changes with line-by-line diff view.

## Context

**Git repository check:**
!`git rev-parse --git-dir`

**Staged changes:**
!`git diff --staged`

## Steps

1. **Verify git repo** → Exit if not in git repository
2. **Check staged files** → Exit with "Nothing staged" if empty
3. **Display diff** → Show output from `git diff --staged`

## Error handling

- Not in git repo → Inform and exit
- Nothing staged → Exit with "No staged changes"
