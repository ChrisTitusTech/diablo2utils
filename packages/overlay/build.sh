#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Building D2R Map Overlay ==="

# Install dependencies
echo "[1/1] Installing dependencies..."
yarn install

echo ""
echo "Build complete! Run with: ./run.sh"
