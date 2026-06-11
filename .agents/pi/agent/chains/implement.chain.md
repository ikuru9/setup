---
name: implement
description: Implement one approved issue or plan using TDD, then review it
---

## worker

phase: Implement
label: Implement approved slice
as: implementation
output: implementation.md
outputMode: file-only

Implement this approved issue or plan using TDD discipline.

Task:
{task}

Rules:

- Implement only this slice.
- Keep scope narrow.
- Do not create PRDs.
- Do not create issues.
- Do not modify CONTEXT.md or ADRs unless explicitly assigned.
- Run relevant checks before finishing.

## reviewer

phase: Review
label: Review implementation
reads: implementation.md
as: review
output: review.md

Review the implementation against:

- the assigned task
- acceptance criteria
- behavior correctness
- test quality
- CONTEXT.md terminology
- ADR constraints
- unnecessary complexity
- unapproved scope expansion

Return actionable findings only.
Do not implement fixes.
