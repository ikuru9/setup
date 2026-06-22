#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO="https://github.com/addyosmani/agent-skills.git"
SOURCE_BRANCH="main"
SOURCE_PATH="skills"
TARGET_PATH=".agents/skills"

TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "Cloning sparse folder: $SOURCE_PATH"

git clone \
  --depth 1 \
  --filter=blob:none \
  --sparse \
  --branch "$SOURCE_BRANCH" \
  "$SOURCE_REPO" \
  "$TMP_DIR"

cd "$TMP_DIR"
git sparse-checkout set "$SOURCE_PATH"
cd -

mkdir -p "$TARGET_PATH"

rsync -a --delete \
  "$TMP_DIR/$SOURCE_PATH/" \
  "$TARGET_PATH/"

echo "Synced $SOURCE_REPO/$SOURCE_PATH -> $TARGET_PATH"
