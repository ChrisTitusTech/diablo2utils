#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Building D2R Map Overlay ==="

# Build the frontend bundle
echo "[1/2] Building frontend..."
mkdir -p dist
npx esbuild src/main.ts --bundle --outfile=dist/index.js --platform=browser --target=es2020
cp src/index.html dist/
cp src/style.css dist/

echo "[2/2] Building Tauri binary..."
cd src-tauri
cargo tauri build

echo ""
echo "Build complete! Binary is in src-tauri/target/release/"
