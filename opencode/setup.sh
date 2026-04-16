#!/usr/bin/env bash
set -euo pipefail

find . -type f \( -name "*.md" -o -name "*.json" \) | while read f; do
  mkdir -p ~/.config/opencode/$(dirname "$f")
  ln -sf "$(pwd)/$f" ~/.config/opencode/"$f"
done
