#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-$HOME/multicorn-demo/inbox}"
COUNT="${2:-200}"

rm -rf "$TARGET"
npx ts-node "$SCRIPT_DIR/generate-inbox.ts" "$TARGET" "$COUNT"
echo "Generated $COUNT emails in $TARGET"
