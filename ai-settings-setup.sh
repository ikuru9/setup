#!/bin/sh

set -eu

script_dir="$(cd "$(dirname "$0")" && pwd -P)"

PI_AGENT_SOURCE_DIR="$script_dir/.agents/pi/agent"
PI_SKILLS_SOURCE_DIR="$script_dir/.agents/skills"
PI_USER_TARGET_ROOT=".pi/agent"
PI_PROJECT_TARGET_ROOT=".pi"

usage() {
	printf '사용법: %s [--path <프로젝트-디렉터리>]\n' "${0##*/}"
}

die() {
	printf '오류: %s\n' "$1" >&2
	usage >&2
	exit 1
}

warn() {
	printf '경고: %s\n' "$1" >&2
}

install_scope() {
	if [ "$has_explicit_project_path" = "y" ]; then
		printf '%s\n' "project"
	else
		printf '%s\n' "user"
	fi
}

scope_base_dir() {
	scope_name=$1

	case "$scope_name" in
	user)
		[ -n "${HOME:-}" ] || die "HOME이 설정되어 있지 않습니다"
		printf '%s\n' "$HOME"
		;;
	project)
		[ -n "${project_path:-}" ] || die "프로젝트 경로가 설정되어 있지 않습니다"
		printf '%s\n' "$project_path"
		;;
	*)
		die "알 수 없는 설치 scope입니다: $scope_name"
		;;
	esac
}

resolve_scoped_path() {
	user_relative_path=$1
	project_relative_path=$2

	case "$(install_scope)" in
	user)
		printf '%s/%s\n' "$(scope_base_dir user)" "$user_relative_path"
		;;
	project)
		printf '%s/%s\n' "$(scope_base_dir project)" "$project_relative_path"
		;;
	esac
}

is_project_scope() {
	[ "$(install_scope)" = "project" ]
}

list_agent_names() {
	agents_root_dir=$1

	for agent_source_path in "$agents_root_dir"/*; do
		[ -d "$agent_source_path" ] || continue

		agent_dir_name=${agent_source_path##*/}

		case "$agent_dir_name" in
		skills | docs)
			continue
			;;
		esac

		printf '%s\n' "$agent_dir_name"
	done
}

choose_agent_name() {
	available_agent_names=$1

	set -- $available_agent_names

	[ $# -gt 0 ] || return 1

	if [ $# -eq 1 ]; then
		printf '%s\n' "$1"
		return 0
	fi

	printf '사용 가능한 에이전트:\n' >&2
	for agent_name_item; do
		printf ' - %s\n' "$agent_name_item" >&2
	done

	if command -v fzf >/dev/null 2>&1; then
		selected_agent_name="$(
			printf '%s\n' "$available_agent_names" |
				fzf \
					--prompt='에이전트 선택> ' \
					--height=40% \
					--layout=reverse \
					--border \
					--no-multi \
					--select-1 \
					--exit-0
		)"

		[ -n "$selected_agent_name" ] || return 1

		printf '%s\n' "$selected_agent_name"
		return 0
	fi

	warn "fzf를 찾을 수 없어 숫자 선택 방식으로 전환합니다"

	agent_index=1
	for agent_name_item; do
		printf '%s) %s\n' "$agent_index" "$agent_name_item" >&2
		agent_index=$((agent_index + 1))
	done

	printf '에이전트 번호를 선택하세요: ' >&2
	IFS= read -r selected_agent_index || return 1

	case "$selected_agent_index" in
	'' | *[!0-9]*)
		return 1
		;;
	esac

	agent_index=1
	for agent_name_item; do
		if [ "$agent_index" -eq "$selected_agent_index" ]; then
			printf '%s\n' "$agent_name_item"
			return 0
		fi

		agent_index=$((agent_index + 1))
	done

	return 1
}

prompt_yes_no() {
	question_text=$1
	default_answer=${2:-y}

	if [ "$default_answer" = "n" ]; then
		prompt_suffix='[y/N]'
	else
		prompt_suffix='[Y/n]'
	fi

	printf '%s %s ' "$question_text" "$prompt_suffix" >&2
	IFS= read -r user_answer || user_answer=""

	case "$user_answer" in
	[Yy] | [Yy][Ee][Ss])
		return 0
		;;
	[Nn] | [Nn][Oo])
		return 1
		;;
	'')
		[ "$default_answer" = "y" ] && return 0 || return 1
		;;
	*)
		return 1
		;;
	esac
}

directory_has_files() {
	dir_path=$1

	[ -d "$dir_path" ] || return 1

	for child_source_path in \
		"$dir_path"/* \
		"$dir_path"/.[!.]* \
		"$dir_path"/..?*; do
		[ -e "$child_source_path" ] || [ -L "$child_source_path" ] || continue

		if [ -L "$child_source_path" ] || [ -f "$child_source_path" ]; then
			return 0
		fi

		if [ -d "$child_source_path" ] && directory_has_files "$child_source_path"; then
			return 0
		fi
	done

	return 1
}

copy_entry() {
	source_path=$1
	destination_path=$2

	if [ ! -e "$source_path" ] && [ ! -L "$source_path" ]; then
		return 0
	fi

	mkdir -p "$(dirname "$destination_path")"

	if [ -L "$destination_path" ]; then
		rm -f "$destination_path"
	elif [ -e "$destination_path" ]; then
		if [ -d "$source_path" ] && [ -d "$destination_path" ]; then
			cp -a "$source_path"/. "$destination_path"/
			printf '병합됨: %s -> %s\n' "$source_path" "$destination_path"
			return 0
		fi

		warn "이미 존재하는 경로라 건너뜁니다: $destination_path"
		return 0
	fi

	cp -a "$source_path" "$destination_path"
	printf '복사됨: %s -> %s\n' "$source_path" "$destination_path"
}

copy_entry_if_populated() {
	source_path=$1
	destination_path=$2

	if [ -d "$source_path" ] && ! directory_has_files "$source_path"; then
		return 0
	fi

	copy_entry "$source_path" "$destination_path"
}

get_selected_agent_source_dir() {
	case "$selected_agent_name" in
	pi)
		printf '%s\n' "$PI_AGENT_SOURCE_DIR"
		;;
	*)
		printf '%s\n' "$agents_root_dir/$selected_agent_name"
		;;
	esac
}

get_selected_agent_target_root() {
	case "$selected_agent_name" in
	pi)
		resolve_scoped_path "$PI_USER_TARGET_ROOT" "$PI_PROJECT_TARGET_ROOT"
		;;
	*)
		resolve_scoped_path ".${selected_agent_name}" ".${selected_agent_name}"
		;;
	esac
}

get_selected_agent_skills_source_dir() {
	case "$selected_agent_name" in
	pi)
		printf '%s\n' "$PI_SKILLS_SOURCE_DIR"
		;;
	*)
		return 1
		;;
	esac
}

install_selected_agent_entries() {
	[ -d "$selected_agent_source_dir" ] || return 0

	for source_entry_path in \
		"$selected_agent_source_dir"/* \
		"$selected_agent_source_dir"/.[!.]* \
		"$selected_agent_source_dir"/..?*; do
		[ -e "$source_entry_path" ] || [ -L "$source_entry_path" ] || continue

		copy_entry_if_populated \
			"$source_entry_path" \
			"$selected_agent_target_root/${source_entry_path##*/}"
	done
}

install_selected_agent_skills() {
	if ! selected_agent_skills_source_dir=$(get_selected_agent_skills_source_dir); then
		return 0
	fi

	[ -d "$selected_agent_skills_source_dir" ] || return 0
	copy_entry_if_populated \
		"$selected_agent_skills_source_dir" \
		"$selected_agent_target_root/skills"
}

install_common_docs() {
	common_docs_dir="$agents_root_dir/docs"

	if ! is_project_scope; then
		warn "--path가 지정되지 않아 docs 설치를 건너뜁니다"
		return 0
	fi

	[ -d "$common_docs_dir" ] || return 0
	copy_entry_if_populated "$common_docs_dir" "$(resolve_scoped_path "docs" "docs")"
}

install_pi_local_packages() {
	command -v pi >/dev/null 2>&1 || {
		warn "pi 명령을 찾을 수 없어 로컬 패키지 설치를 건너뜁니다"
		return 0
	}

	if [ "$selected_agent_name" != "pi" ]; then
		return 0
	fi

	if prompt_yes_no "codegraph CLI를 설치할까요?" y; then
		if command -v npm >/dev/null 2>&1; then
			npm i -g @colbymchenry/codegraph
		else
			warn "npm 명령을 찾을 수 없어 codegraph CLI 설치를 건너뜁니다"
		fi
	fi

	pi_package_list='
npm:pi-auto-theme
npm:pi-web-access
npm:pi-intercom
npm:pi-lens
npm:pi-image-tools
npm:pi-vision-proxy
npm:@ff-labs/pi-fff
npm:pi-mcp-adapter
npm:pi-sandbox
npm:pi-markdown-preview
npm:@juanibiapina/pi-powerbar
npm:@juicesharp/rpiv-ask-user-question
npm:@juicesharp/rpiv-todo
npm:@samfp/pi-memory
'

	if is_project_scope; then
		pi_package_list="${pi_package_list}
npm:@vndv/pi-codegraph
"
	fi

	(
		cd "$project_path"

		printf '%s\n' "$pi_package_list" | while IFS= read -r raw_package_name; do
			package_name=$(printf '%s' "$raw_package_name" | xargs)

			[ -n "$package_name" ] || continue

			case "$package_name" in
			\#*)
				continue
				;;
			esac

			pi install "$package_name"
		done
	)
}

project_path=""
has_explicit_project_path="n"

while [ $# -gt 0 ]; do
	case "$1" in
	--path | -p)
		[ $# -ge 2 ] || die "--path에는 값이 필요합니다"

		project_path=$2
		has_explicit_project_path="y"

		shift 2
		;;
	--help | -h)
		usage
		exit 0
		;;
	*)
		die "알 수 없는 인자입니다: $1"
		;;
	esac
done

if [ -z "$project_path" ]; then
	project_path="${HOME:-}"
	[ -n "$project_path" ] || die "HOME이 설정되어 있지 않습니다. --path를 지정하세요"
fi

[ -d "$project_path" ] || die "프로젝트 경로가 디렉터리가 아닙니다: $project_path"

project_path="$(cd "$project_path" && pwd -P)"
printf '프로젝트: %s\n' "$project_path"

agents_root_dir="$script_dir/.agents"
[ -d "$agents_root_dir" ] || die "원본 .agents 디렉터리를 찾을 수 없습니다: $agents_root_dir"

available_agent_names="$(list_agent_names "$agents_root_dir")"
selected_agent_name="$(choose_agent_name "$available_agent_names")"
[ -n "$selected_agent_name" ] || die "$agents_root_dir 안에서 에이전트 디렉터리를 찾을 수 없습니다"

selected_agent_source_dir="$(get_selected_agent_source_dir)"
selected_agent_target_root="$(get_selected_agent_target_root)"

install_selected_agent_entries
install_selected_agent_skills
install_common_docs
install_pi_local_packages

common_agents_file="$agents_root_dir/AGENTS.md"
if [ -f "$common_agents_file" ]; then
	copy_entry_if_populated "$common_agents_file" "$selected_agent_target_root/AGENTS.md"
fi

printf '완료되었습니다.\n'
