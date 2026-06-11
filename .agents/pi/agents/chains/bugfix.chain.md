---
name: bugfix
description: Diagnose and fix a bug, then review the fix
---

## bugfixer

phase: Diagnose
label: Reproduce and fix
as: fix
output: fix.md
outputMode: file-only

Diagnose and fix this bug.

Task:
{task}

Rules:

- Establish a feedback loop before changing production code.
- Reproduce the issue when possible.
- State the observed failure.
- Fix the root cause.
- Add a regression test when feasible.
- Remove temporary debug artifacts before finishing.
- Do not broaden scope.

## reviewer

phase: Review
label: Review bugfix
reads: fix.md
as: review
output: review.md

Review the bugfix for:

- root cause correctness
- regression coverage
- debug artifact cleanup
- behavior correctness
- scope expansion
- unnecessary complexity

Return actionable findings only.
Do not implement fixes.
