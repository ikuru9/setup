#!/bin/sh

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"

usage() {
	printf 'Usage: %s --path <project-dir>\n' "${0##*/}"
}

die() {
	printf 'Error: %s\n' "$1" >&2
	usage >&2
	exit 1
}

warn() {
	printf 'Warning: %s\n' "$1" >&2
}

list_agents() {
	agents_root=$1

	for source in "$agents_root"/*; do
		[ -d "$source" ] || continue
		name=${source##*/}
		[ "$name" = "skills" ] && continue
		printf '%s\n' "$name"
	done
}

choose_agent() {
	agents=$1
	set -- $agents

	[ $# -gt 0 ] || return 1
	[ $# -eq 1 ] && {
		printf '%s\n' "$1"
		return 0
	}

	printf 'Available agents:\n' >&2
	for agent; do
		printf ' - %s\n' "$agent" >&2
	done

	if command -v fzf >/dev/null 2>&1; then
		choice="$(printf '%s\n' "$agents" | fzf --prompt='Select agent> ' --height=40% --layout=reverse --border --no-multi --select-1 --exit-0)"
		[ -n "$choice" ] || return 1
		printf '%s\n' "$choice"
		return 0
	fi

	warn "fzf not found; falling back to numeric selection"
	i=1
	for agent; do
		printf '%s) %s\n' "$i" "$agent" >&2
		i=$((i + 1))
	done

	printf 'Select agent number: ' >&2
	IFS= read -r choice || return 1

	case $choice in
	'' | *[!0-9]*) return 1 ;;
	esac

	i=1
	for agent; do
		if [ "$i" -eq "$choice" ]; then
			printf '%s\n' "$agent"
			return 0
		fi
		i=$((i + 1))
	done

	return 1
}

link_entry() {
	src=$1
	dst=$2

	if [ ! -e "$src" ]; then
		return 0
	fi

	mkdir -p "$(dirname "$dst")"

	if [ -e "$dst" ] || [ -L "$dst" ]; then
		if [ -L "$dst" ]; then
			rm -f "$dst"
		else
			warn "skip existing path: $dst"
			return 0
		fi
	fi

	ln -s "$src" "$dst"
	printf 'Linked %s -> %s\n' "$dst" "$src"
}

copy_entry() {
	src=$1
	dst=$2

	if [ ! -e "$src" ]; then
		return 0
	fi

	mkdir -p "$(dirname "$dst")"

	if [ -e "$dst" ] || [ -L "$dst" ]; then
		if [ -L "$dst" ]; then
			rm -f "$dst"
		else
			warn "skip existing path: $dst"
			return 0
		fi
	fi

	cp -a "$src" "$dst"
	printf 'Copied %s -> %s\n' "$dst" "$src"
}

prompt_yes_no() {
	question=$1
	default=${2:-y}

	if [ "$default" = "n" ]; then
		suffix='[y/N]'
	else
		suffix='[Y/n]'
	fi

	printf '%s %s ' "$question" "$suffix" >&2
	IFS= read -r answer || answer=""

	case $answer in
	[Yy] | [Yy][Ee][Ss]) return 0 ;;
	[Nn] | [Nn][Oo]) return 1 ;;
	'') [ "$default" = "y" ] && return 0 || return 1 ;;
	*) return 1 ;;
	esac
}

install_pi_local_packages() {
	command -v pi >/dev/null 2>&1 || {
		warn "pi command not found; skipping local package install"
		return 0
	}

	if [ "$agent_name" != "pi" ]; then
		return 0
	fi

	if prompt_yes_no "Install pi-gitnexus?" y; then
		if command -v npm >/dev/null 2>&1; then
			npm i -g gitnexus
		else
			warn "npm command not found; skipping gitnexus install"
		fi
	fi

	pi_packages='
# git:github.com/tmdgusya/roach-pi
npm:@tintinweb/pi-subagents
npm:pi-mcp-adapter
npm:pi-markdown-preview
npm:pi-auto-theme
npm:pi-sandbox
npm:@ff-labs/pi-fff
npm:pi-lens
npm:pi-powerline-footer
npm:@samfp/pi-memory
npm:@juicesharp/rpiv-web-tools
'

	(
		cd "$project_path"

		printf '%s\n' "$pi_packages" | while IFS= read -r package; do
			# 앞뒤 공백 제거 (trim)
			package=$(echo "$package" | xargs)

			# 빈 줄이거나 #으로 시작하는 주석 라인은 패스
			[ -n "$package" ] || continue
			[[ "$package" =~ ^# ]] && continue

			pi install "$package"
		done
	)
}

project_path=""

while [ $# -gt 0 ]; do
	case "$1" in
	--path | -p)
		[ $# -ge 2 ] || die "--path requires a value"
		project_path="$2"
		shift 2
		;;
	--help | -h)
		usage
		exit 0
		;;
	*)
		die "unknown argument: $1"
		;;
	esac
done

[ -n "$project_path" ] || die "--path is required"
[ -d "$project_path" ] || die "project path is not a directory: $project_path"

project_path="$(cd "$project_path" && pwd -P)"
printf 'Project: %s\n' "$project_path"

agents_dir="$SCRIPT_DIR/.agents"
[ -d "$agents_dir" ] || die "missing source .agents directory: $agents_dir"

agents="$(list_agents "$agents_dir")"
agent_name="$(choose_agent "$agents")"
[ -n "$agent_name" ] || die "no agent directories found in $agents_dir"

source="$agents_dir/$agent_name"
target="$project_path/.${agent_name}"
mkdir -p "$target"

for entry in "$source"/* "$source"/.[!.]* "$source"/..?*; do
	[ -e "$entry" ] || continue
	base=${entry##*/}
	copy_entry "$entry" "$target/$base"
done

if [ -f "$agents_dir/AGENTS.md" ]; then
	copy_entry "$agents_dir/AGENTS.md" "$target/AGENTS.md"
fi

if [ -d "$agents_dir/skills" ]; then
	link_entry "$agents_dir/skills" "$target/skills"
fi

install_pi_local_packages

printf 'Done.\n'
