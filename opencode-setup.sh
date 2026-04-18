#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$SCRIPT_DIR/opencode"
DEST_ROOT="$HOME/.config/opencode"

if [ ! -d "$TARGET_DIR" ]; then
  echo "오류: $TARGET_DIR 디렉터리가 없습니다."
  exit 1
fi

if [ -e "$DEST_ROOT" ] && [ ! -d "$DEST_ROOT" ]; then
  echo "오류: $DEST_ROOT 가 디렉터리가 아닙니다."
  ls -ld "$DEST_ROOT"
  exit 1
fi

mkdir -p "$DEST_ROOT"

find "$TARGET_DIR" -mindepth 1 -maxdepth 1 | while read -r src; do
  name="$(basename "$src")"
  dest_path="$DEST_ROOT/$name"

  rm -rf "$dest_path"
  ln -s "$src" "$dest_path"
done
