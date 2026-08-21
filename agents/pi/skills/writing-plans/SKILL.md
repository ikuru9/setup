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
# Implementation Plan: [Feature]

## Overview

[One paragraph summary of what we're building]

## Architecture Decisions

- [Key decision 1 and rationale]
- [Key decision 2 and rationale]

## Task List

### Phase 1: Foundation

- [ ] Task 1: ...
- [ ] Task 2: ...

### Checkpoint: Foundation

- [ ] Tests pass, builds clean

### Phase 2: Core Features

- [ ] Task 3: ...
- [ ] Task 4: ...

### Checkpoint: Core Features

- [ ] End-to-end flow works

### Phase 3: Polish

- [ ] Task 5: ...
- [ ] Task 6: ...

### Checkpoint: Complete

- [ ] All acceptance criteria met
- [ ] Ready for review

## Risks and Mitigations

| Risk   | Impact         | Mitigation |
| ------ | -------------- | ---------- |
| [Risk] | [High/Med/Low] | [Strategy] |

## Open Questions

- [Question needing human input]
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
