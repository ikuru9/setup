---
name: handoff
description: Create a compact handoff document for a future session or agent
---

## handoff

phase: Handoff
label: Create handoff
as: handoff
output: handoff.md

Create a handoff document for this work.

Task:
{task}

Include:

- current status
- relevant artifacts
- decisions made
- open decisions
- changed files
- commands run
- known risks
- suggested next agent or skill

Rules:

- Do not implement.
- Do not duplicate full PRDs, ADRs, or issues.
- Reference existing artifacts by path or URL.
- Redact secrets and sensitive values.
