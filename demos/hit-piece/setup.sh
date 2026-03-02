#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-$HOME/multicorn-demo/rathbun-sim}"

# Remove existing directory if it exists
rm -rf "$TARGET"

# Create directory structure
mkdir -p "$TARGET/project/src"
mkdir -p "$TARGET/contributor-info"
mkdir -p "$TARGET/blog-output"

# Copy fixture files
cp -r "$SCRIPT_DIR/fixtures/project/"* "$TARGET/project/"
cp -r "$SCRIPT_DIR/fixtures/contributor-info/"* "$TARGET/contributor-info/"

# Initialize git repo in blog-output with an initial commit
cd "$TARGET/blog-output"
git init
echo "# Blog Output" > README.md
git add README.md
git config user.email "demo@multicorn.ai"
git config user.name "Demo User"
git commit -m "Initial commit"

echo "Setup complete. Workspace created at $TARGET"
echo "  - project/ contains the StringKit project"
echo "  - contributor-info/ contains maintainer profile"
echo "  - blog-output/ is a git repo with initial commit"
