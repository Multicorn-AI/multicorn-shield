#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-$HOME/multicorn-demo/rathbun-sim}"

if [ ! -d "$TARGET" ]; then
  echo "Error: Target directory $TARGET does not exist. Run setup.sh first."
  exit 1
fi

# Restore project files from fixtures (not just delete - agent may have modified existing files)
if [ -d "$TARGET/project" ]; then
  rm -rf "$TARGET/project"
  cp -r "$SCRIPT_DIR/fixtures/project" "$TARGET/project"
fi

# Reset blog-output to initial commit
if [ -d "$TARGET/blog-output" ]; then
  cd "$TARGET/blog-output"
  if [ -d .git ]; then
    git reset --hard HEAD
    git clean -fd
  fi
fi

# Leave contributor-info/ untouched as specified

echo "Reset complete. Workspace restored to pre-simulation state."
