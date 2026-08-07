---
name: writing-plans
description: Create and maintain a plan file for multi-step work
---

---

# Writing Plans

For multi-step work, create and maintain `plan.md` in the project root.

## Create the Plan

Create `plan.md` before implementation. If it already exists, read and update it instead of overwriting useful existing content.

Keep it short and include only the goal and actionable tasks.

```markdown
# [Work] Plan

## Metadata

- Updated: YYYY-MM-DD HH:mm
- Overall Status: In Progress

## Goal

[Expected outcome]

## Tasks

- [ ] [Task 1]
- [ ] [Task 2]
```

Add file paths, constraints, dependencies, or verification commands only when they are needed to execute the work correctly.

## Manage the Plan

Treat `plan.md` as the source of truth while working.

- Update it immediately after an important state change.
- Mark a task `- [x]` only after the work and its verification are complete.
- Keep incomplete, blocked, failed, or unverified tasks as `- [ ]`.
- Add one short `Status:` line only when a task is blocked or verification fails.
- Update the task list before continuing when the scope or approach changes.
- Do not add work logs, detailed implementation results, or final-result sections.
- Do not remove completed tasks unless they are no longer part of the work.

Before reporting completion:

- Confirm that `plan.md` matches the actual work state.
- Confirm that every required task is marked `- [x]`.
- Set `Overall Status` to `Completed` only when all required tasks are complete and verified.
