#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO="https://github.com/addyosmani/agent-skills.git"
SOURCE_BRANCH="main"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$script_dir/.." && pwd -P)"
TMP_DIR="$(mktemp -d)"

SYNC_MAPPINGS=(
  "skills|.agents/skills"
  "agents|agents/pi"
)

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

sparse_checkout_paths=()
for mapping in "${SYNC_MAPPINGS[@]}"; do
  sparse_checkout_paths+=("${mapping%%|*}")
done

sync_mapping() {
  source_relative_path=$1
  target_relative_path=$2

  source_path="$TMP_DIR/$source_relative_path"
  target_path="$REPO_ROOT/$target_relative_path"

  if [ ! -d "$source_path" ]; then
    rm -rf "$target_path"
    printf 'Removed missing path: %s\n' "$target_relative_path"
    return 0
  fi

  mkdir -p "$target_path"
  rsync -a --delete "$source_path/" "$target_path/"
  printf 'Synced %s -> %s\n' "$source_relative_path" "$target_relative_path"
}

echo "Cloning sparse folders: ${sparse_checkout_paths[*]}"

git clone \
  --depth 1 \
  --filter=blob:none \
  --sparse \
  --branch "$SOURCE_BRANCH" \
  "$SOURCE_REPO" \
  "$TMP_DIR"

cd "$TMP_DIR"
git sparse-checkout set "${sparse_checkout_paths[@]}"

for mapping in "${SYNC_MAPPINGS[@]}"; do
  sync_mapping "${mapping%%|*}" "${mapping#*|}"
done

echo "Done."
