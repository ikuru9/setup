# Task List: Claude commands → Pi prompt templates

- [x] Task 1: Convert each Claude command into a Pi prompt contract
  - Keep the same filenames and user-facing command names.
  - Preserve the source command behavior, especially `build auto` and `webperf`.

- [x] Task 2: Write the prompt template files
  - Add Pi frontmatter and the actual command instructions under `.agents/pi/agent/prompts/`.

- [x] Task 3: Verify install/discovery path
  - Confirm the existing Pi setup copies `prompts/` into the installed Pi home.

- [x] Task 4: Document the migration decisions
  - Record the mapping and the `webperf` special case in repo docs if needed.