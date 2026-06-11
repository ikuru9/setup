---
name: review
description: Review current work from correctness, tests, architecture, and scope perspectives
---

## reviewer

phase: Review
label: Correctness review
as: correctness
output: correctness.md
outputMode: file-only

Review the current work for correctness against the assigned task, issue, PRD, or approved plan.

Focus on:

- behavior correctness
- edge cases
- acceptance criteria mismatch
- regressions

Do not implement fixes.

## reviewer

phase: Review
label: Test quality review
as: tests
output: tests.md
outputMode: file-only

Review the current work for test quality.

Focus on:

- missing behavior tests
- weak assertions
- implementation-detail tests
- missing regression tests for bug fixes

Do not implement fixes.

## reviewer

phase: Review
label: Architecture and scope review
as: architecture
output: architecture.md
outputMode: file-only

Review the current work for architecture and scope.

Focus on:

- unnecessary complexity
- architecture drift
- CONTEXT.md terminology mismatch
- ADR constraint violations
- unapproved scope expansion

Do not implement fixes.

## reviewer

phase: Synthesis
label: Synthesize review findings
reads: correctness.md, tests.md, architecture.md
as: synthesis
output: review-summary.md

Merge the review findings into one actionable list.

Rules:

- Remove duplicates.
- Separate blockers from non-blockers.
- Do not invent new requirements.
- Do not request broad refactors unless necessary.
- Include suggested verification commands.
