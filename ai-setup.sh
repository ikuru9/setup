#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  printf 'Usage: %s --path <project-dir> [--agent opencode|codex|pi]\n' "${0##*/}"
}

die() {
  printf 'Error: %s\n' "$1" >&2
  usage >&2
  exit 1
}

warn() {
  printf 'Warning: %s\n' "$1" >&2
}

link_entry() {
  local src="$1"
  local dst="$2"

  if [[ ! -e "$src" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "$dst")"

  if [[ -e "$dst" || -L "$dst" ]]; then
    if [[ -L "$dst" ]]; then
      rm -f "$dst"
    else
      warn "skip existing path: $dst"
      return 0
    fi
  fi

  ln -s "$src" "$dst"
  printf 'Linked %s -> %s\n' "$dst" "$src"
}

sync_dir_contents() {
  local src_dir="$1"
  local dst_dir="$2"

  if [[ ! -d "$src_dir" ]]; then
    return 0
  fi

  mkdir -p "$dst_dir"

  shopt -s nullglob dotglob
  local entry base dst
  for entry in "$src_dir"/*; do
    base="${entry##*/}"
    dst="$dst_dir/$base"

    if [[ -d "$entry" && ! -L "$entry" ]]; then
      if [[ -e "$dst" && -d "$dst" && ! -L "$dst" ]]; then
        sync_dir_contents "$entry" "$dst"
      else
        link_entry "$entry" "$dst"
      fi
    else
      link_entry "$entry" "$dst"
    fi
  done
  shopt -u nullglob dotglob
}

choose_agent() {
  local agents=(opencode codex pi)
  local choice

  if command -v fzf >/dev/null 2>&1; then
    choice="$(printf '%s\n' "${agents[@]}" | fzf --prompt='Select agent> ' --height=40% --layout=reverse --border --no-multi --select-1 --exit-0)"
    [[ -n "$choice" ]] || return 1
    printf '%s\n' "$choice"
    return 0
  fi

  warn "fzf not found; falling back to numeric selection"
  PS3='Select agent: '
  select choice in "${agents[@]}"; do
    case "$choice" in
      opencode|codex|pi)
        printf '%s\n' "$choice"
        return 0
        ;;
      *)
        printf 'Invalid choice\n' >&2
        ;;
    esac
  done
}

first_existing_dir() {
  local candidate
  for candidate in "$@"; do
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

project_path=""
agent=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path|-p)
      [[ $# -ge 2 ]] || die "--path requires a value"
      project_path="$2"
      shift 2
      ;;
    --agent|-a)
      [[ $# -ge 2 ]] || die "--agent requires a value"
      agent="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$project_path" ]] || die "--path is required"
[[ -d "$project_path" ]] || die "project path is not a directory: $project_path"

project_path="$(cd "$project_path" && pwd -P)"

if [[ -n "$agent" ]]; then
  case "$agent" in
    opencode|codex|pi) ;;
    *) die "unsupported agent: $agent" ;;
  esac
elif [[ -t 0 ]]; then
  agent="$(choose_agent)"
else
  die "--agent is required when stdin is not interactive"
fi

printf 'Project: %s\n' "$project_path"
printf 'Agent: %s\n' "$agent"

# Common resources shared by every agent.
sync_dir_contents "$SCRIPT_DIR/.agents" "$project_path/.agents"
link_entry "$SCRIPT_DIR/AGENTS.md" "$project_path/AGENTS.md"

if [[ -d "$project_path/.agents/skills" ]]; then
  link_entry "$project_path/.agents/skills" "$project_path/skills"
fi

if [[ -d "$project_path/.agents/rules" ]]; then
  link_entry "$project_path/.agents/rules" "$project_path/rules"
fi

case "$agent" in
  opencode)
    if opencode_src="$(first_existing_dir "$SCRIPT_DIR/.agents/opencode" "$SCRIPT_DIR/opencode")"; then
      sync_dir_contents "$opencode_src" "$project_path/.opencode"
    else
      warn "no opencode source directory found"
    fi
    ;;
  codex)
    if codex_src="$(first_existing_dir "$SCRIPT_DIR/.agents/codex" "$SCRIPT_DIR/codex")"; then
      sync_dir_contents "$codex_src" "$project_path/.codex"
    else
      warn "no codex source directory found"
    fi
    ;;
  pi)
    if pi_src="$(first_existing_dir "$SCRIPT_DIR/.agents/pi" "$SCRIPT_DIR/pi")"; then
      sync_dir_contents "$pi_src" "$project_path/.pi"
    else
      warn "no pi source directory found"
    fi
    ;;
esac

printf 'Done.\n'
