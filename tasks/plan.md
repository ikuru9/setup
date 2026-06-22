# Implementation Plan: Claude commands → Pi prompt templates

## Overview
Migrate the eight `.claude/commands/*.md` entry points from `addyosmani/agent-skills` into Pi prompt templates under `.agents/pi/agent/prompts/`, preserving each command's intent, arguments, and linked skill/persona workflow.

## Architecture Decisions
- Keep this as a prompt-template migration only; do not add new installer code unless discovery fails.
- Use the existing `ai-settings-setup.sh` copy behavior for `.agents/pi/agent/**`, which should already install `prompts/` recursively.
- Preserve command names as template filenames so Pi exposes the same slash commands.
- Treat `/webperf` as a special case: the source command wraps the `web-performance-auditor` persona, so the prompt must encode that audit workflow directly rather than relying on persona fan-out.

## Command-to-skill mapping
| Pi prompt | Source command | Linked skill/persona |
|---|---|---|
| `spec.md` | `.claude/commands/spec.md` | `spec-driven-development` |
| `plan.md` | `.claude/commands/plan.md` | `planning-and-task-breakdown` |
| `build.md` | `.claude/commands/build.md` | `incremental-implementation` + `test-driven-development` |
| `test.md` | `.claude/commands/test.md` | `test-driven-development` |
| `review.md` | `.claude/commands/review.md` | `code-review-and-quality` |
| `ship.md` | `.claude/commands/ship.md` | `shipping-and-launch` |
| `code-simplify.md` | `.claude/commands/code-simplify.md` | `code-simplification` |
| `webperf.md` | `.claude/commands/webperf.md` | `web-performance-auditor` + `performance-optimization` references |

## Task List

### Phase 1: Map and normalize command behavior
- [ ] Task 1: Convert each Claude command into a Pi prompt contract
  - Acceptance: every source command has a target prompt filename and the prompt keeps the same user-facing mode/argument behavior.
  - Verify: compare source command text against prompt draft for all eight commands.
  - Files: `.agents/pi/agent/prompts/*.md`

### Checkpoint: Mapping complete
- [ ] All source commands mapped
- [ ] Special cases called out (`build auto`, `webperf`, `ship`)

### Phase 2: Draft prompt templates
- [ ] Task 2: Write the prompt template files
  - Acceptance: the prompt files exist under `.agents/pi/agent/prompts/` with Pi frontmatter (`description`, `argument-hint` where needed) and clear instructions.
  - Verify: prompt files render cleanly as Markdown and keep command names stable.
  - Files: `.agents/pi/agent/prompts/spec.md`, `.agents/pi/agent/prompts/plan.md`, `.agents/pi/agent/prompts/build.md`, `.agents/pi/agent/prompts/test.md`, `.agents/pi/agent/prompts/review.md`, `.agents/pi/agent/prompts/ship.md`, `.agents/pi/agent/prompts/code-simplify.md`, `.agents/pi/agent/prompts/webperf.md`

### Checkpoint: Templates drafted
- [ ] All prompts present
- [ ] `build` preserves `auto` mode
- [ ] `webperf` preserves quick/deep audit intent

### Phase 3: Verify install/discovery path
- [ ] Task 3: Confirm the existing Pi setup script installs prompts automatically
  - Acceptance: `.agents/pi/agent/prompts/` is included in the recursive copy path; no extra installer change is needed unless verification proves otherwise.
  - Verify: trace the installer path and confirm prompt files land in the user/project Pi install roots.
  - Files: `scripts/ai-settings-setup.sh` (only if a fix is required)

### Checkpoint: Install path verified
- [ ] Prompts discoverable in Pi install
- [ ] No unnecessary installer churn

### Phase 4: Documentation and handoff
- [ ] Task 4: Document the migration decisions
  - Acceptance: repo docs note the prompt-template mapping and the `webperf` special case.
  - Verify: docs mention the new prompt location and any limitations.
  - Files: `CONTEXT.md` and/or a short ADR under `docs/adr/`

### Checkpoint: Ready for implementation
- [ ] Plan approved
- [ ] Template strategy is unambiguous
- [ ] Open questions resolved or explicitly deferred

## Risks and Mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Pi prompt templates cannot express Claude-style persona fan-out | Medium | Encode `/ship` and `/webperf` as explicit prompt workflows, not hard dependencies on subagents. |
| Installer path does not recurse into `prompts/` as expected | Medium | Verify copy behavior before touching installer code; only add a script change if needed. |
| `build auto` mode loses nuance when converted to a prompt | Medium | Preserve the explicit mode split and the spec/plan prerequisite checks in the template text. |

## Open Questions
- Should `/webperf` stay prompt-only, or should we also add a dedicated agent/persona later for better parity with Claude Code?
- Do we want these prompts to be exact command clones, or lightly adapted to Pi wording while keeping behavior equivalent?
- Should the migration live only in `.agents/pi/agent/prompts/`, or should we add a short ADR explaining the mapping?