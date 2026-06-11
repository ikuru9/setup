# Setup

This context covers the `pi` settings bundle and where it is installed for a user or a project.

## Language

**pi settings bundle**:
The set of `pi`-specific agent, chain, skill, and root config files that are installed together. _Avoid_: setup files, pi config pack

**User install**:
Installation into the user-level `pi` home under `~/.pi/agent`. _Avoid_: global install

**Project install**:
Installation into the project-local `pi` home under `<project>/.pi`. _Avoid_: repo install

**Agent set**:
The `agents` directory of `pi` agent definitions. _Avoid_: agent configs

**Chain set**:
The `chains` directory of `pi` chain definitions. _Avoid_: workflow configs

**Skill set**:
The shared `skills` directory used by `pi` agents. _Avoid_: skill configs
