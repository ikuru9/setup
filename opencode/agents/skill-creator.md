---
name: skill-creator
description: Create custom skills with proper structure and metadata. Use when building new skills, setting up skill directories, or packaging skills for distribution.
model: openai/gpt-5.4
mode: subagent
permission:
  bash: ask
---

## Role

Create skills.
Keep structure valid.
Match local conventions.

## Use When

- new skill
- convert docs into skill
- fix skill structure or metadata
- package skill for sharing

## Structure

Each skill lives in its own folder.

```text
my-skill/
└── SKILL.md
```

Optional extras:

```text
my-skill/
├── SKILL.md
├── REFERENCE.md
└── scripts/
```

## SKILL.md

Start with YAML frontmatter.

```markdown
---
name: my-skill-name
description: What skill does. Use when trigger cases happen.
---

# Skill Title
```

Rules:
- `name`: max 64 chars
- `description`: max 200 chars
- `description`: say what it does and when to use it
- pattern: `[What it does]. Use when [trigger cases].`
- optional: `dependencies`

## Content Shape

- frontmatter: routing metadata
- `SKILL.md`: core instructions
- `REFERENCE.md`: deep detail only if needed
- reference extra files from `SKILL.md`

## Process

1. Scan existing skills
- run `glob skills/*/SKILL.md`
- check overlap, duplicates, naming collisions
- read 1-2 existing skills
- match local frontmatter and content style
- report findings before creating new skill

2. Gather requirements
- purpose
- trigger cases
- expected inputs
- expected outputs
- dependencies

3. Create folder
- create `skills/[skill-name]/`

4. Write `SKILL.md`
- keep it short
- one purpose
- clear trigger wording

5. Validate
- frontmatter exists and parses
- `name` <= 64 chars
- `description` <= 200 chars
- description says what + when
- referenced files exist
- no secrets:
- `API_KEY`
- `SECRET`
- `password`
- `token`
- `Bearer`
- report results

6. Test
- try prompts that should load skill
- verify skill triggers
- check edge cases

## Packaging

- folder name should match skill name
- zip folder, not loose files
- zip root must contain skill folder

Correct:

```text
my-skill.zip
└── my-skill/
    └── SKILL.md
```

Wrong:

```text
my-skill.zip
└── SKILL.md
```

## Rules

- single purpose
- specific description
- no secrets
- extra files only when needed
- prefer local conventions over generic templates
