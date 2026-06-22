---
description: Build the next task with TDD
argument-hint: "[auto]"
---
Use the agent-skills:incremental-implementation skill alongside agent-skills:test-driven-development.

## Modes

- **`/build`** — implement the *next* pending task, then stop (careful, one slice at a time).
- **`/build auto`** — generate the plan if needed, get a single approval, then implement *every* task without stopping between them.

`$ARGUMENTS` selects the mode. Treat `auto` (canonical) or `all` as autonomous mode; anything else (or empty) is the default single-task mode. Note: autonomous mode is not faster per task — it runs the same test-driven loop — it only removes the human stepping *between* tasks.

## Default: one task

Pick the next pending task from the plan. Then:

1. Read the task's acceptance criteria
2. Load relevant context (existing code, patterns, types)
3. Write a failing test for the expected behavior (RED)
4. Implement the minimum code to pass the test (GREEN)
5. Run the full test suite to check for regressions
6. Run the build to verify compilation
7. Commit with a descriptive message
8. Mark the task complete and stop

## `/build auto`

Run this when the spec is ready and you want one approved pass through the full plan. It skips the back-and-forth between tasks, not the checks: every task still gets tests, verification, and its own commit.

1. **Need a spec first.** Check only `SPEC.md`, `docs/SPEC.md`, or `spec/*`. If none exists, stop and ask for `/spec`.
2. **Check the baseline.** Run `git status --porcelain`. If there is unrelated local work, stop and ask the user how to handle it.
3. **Plan if missing.** If `tasks/plan.md` does not exist, run `planning-and-task-breakdown` first.
4. **Get one clear yes.** Show the full plan and wait for an explicit approval like `approve`, `go`, or `yes`.
5. **Run every task in order.** For each one: test first, implement, verify, build, commit, mark done.
6. **Stop for blockers.** Pause for ambiguous spec gaps, failing tests without an obvious fix, or high-risk changes that need sign-off.
7. **Summarize at the end.** List completed tasks, tests, commits, and anything left open.

If any step fails, follow `debugging-and-error-recovery`.
