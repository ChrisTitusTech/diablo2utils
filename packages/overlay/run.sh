#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== D2R Map Overlay ==="
echo ""
echo "Prerequisites:"
echo "  1. Map server + memory reader running:"
echo "       cd packages/map && ./run.sh"
echo "  2. Node.js + npm/yarn"
echo ""

# Install electron if not present
if [ ! -d node_modules/electron ]; then
  echo "Installing Electron..."
  yarn install
fi

echo "Launching Electron overlay (loads map viewer from http://localhost:8899)..."
npx electron electron/main.mjs
