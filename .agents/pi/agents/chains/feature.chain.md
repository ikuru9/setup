---
name: feature
description: Align a feature, create a PRD, and break it into vertical implementation issues
---

## planner

phase: Align
label: Align with project context
as: plan
output: plan.md
outputMode: file-only

Align this feature request with project terminology, CONTEXT.md, and ADRs.

Task:
{task}

Do not implement.
Do not create issues.
Clarify only blocking ambiguity.
Produce a concise aligned plan.

## prd-writer

phase: PRD
label: Create PRD
reads: plan.md
as: prd
output: prd.md
outputMode: file-only

Create a PRD from the resolved planning context.

Use:

- the original task: {task}
- the planner output
- CONTEXT.md
- ADRs when relevant

Do not implement.
Do not break into issues yet.

## issue-breaker

phase: Issues
label: Break into vertical slices
reads: prd.md
as: issues
output: issues.md

Break the PRD into ordered vertical tracer-bullet implementation issues.

Each issue must include:

- title
- AFK or HITL classification
- dependencies
- acceptance criteria
- test expectations
- notes for worker

Do not implement.
Do not broaden scope.
