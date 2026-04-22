---
description: Stage git changes for files modified in the current conversation thread
agent: build
model: openai/gpt-5.4-mini-fast
---

Stages file modifications identified from the conversation thread for commit using git.

## Steps

1. **Identify modified files from thread**
   - Review conversation history for file operations (write, edit, create, delete)
   - Extract unique file paths

2. **Stage files**
   - Run `git add <file>` for each identified file
   - Skip files that no longer exist

3. **Show result**
   - Run `git status --short`
   - Display summary (e.g., "Staged 3 files (2 modified, 1 new)")
