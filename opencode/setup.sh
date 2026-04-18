#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$SCRIPT_DIR"

DEST_ROOT="$HOME/.config/opencode"

if [ -e "$DEST_ROOT" ] && [ ! -d "$DEST_ROOT" ]; then
  echo "오류: $DEST_ROOT 가 디렉터리가 아닙니다."
  ls -ld "$DEST_ROOT"
  exit 1
fi

mkdir -p "$DEST_ROOT"

find "$TARGET_DIR" -type f \( \
  -iname "*.md" -o \
  -iname "*.json" -o \
  -iname "*.toml" -o \
  -iname "*.yaml" -o \
  -iname "*.yml" -o \
  -iname "*.ts" -o \
  -iname "*.txt" \
\) | while read -r f; do
  rel_path="${f#"$TARGET_DIR"/}"
  dest_dir="$DEST_ROOT/$(dirname "$rel_path")"
  dest_path="$DEST_ROOT/$rel_path"

  mkdir -p "$dest_dir"
  ln -sf "$f" "$dest_path"
done
