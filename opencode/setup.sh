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

rm -rf "$DEST_ROOT"
mkdir -p "$DEST_ROOT"

cp -a "$TARGET_DIR"/. "$DEST_ROOT"/
