#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Kill any already-running overlay Electron process
kill_old_overlay() {
  local pids
  pids="$(pgrep -f 'electron electron/main.mjs' 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "Killing old overlay processes: $pids"
    echo "$pids" | xargs -r kill 2>/dev/null || true
    sleep 2
    # Force-kill anything still alive
    pids="$(pgrep -f 'electron electron/main.mjs' 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      echo "Force killing remaining overlay processes: $pids"
      echo "$pids" | xargs -r kill -9 2>/dev/null || true
    fi
  fi
}
kill_old_overlay

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
