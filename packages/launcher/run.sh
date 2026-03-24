#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ELECTRON="$REPO_ROOT/node_modules/electron/dist/electron"

# Kill any already-running launcher Electron process
kill_old_launcher() {
  local pids
  pids="$(pgrep -f 'electron.*launcher/electron/main' 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "Killing old launcher processes: $pids"
    echo "$pids" | xargs -r kill 2>/dev/null || true
    sleep 1
    pids="$(pgrep -f 'electron.*launcher/electron/main' 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      echo "Force killing remaining launcher processes: $pids"
      echo "$pids" | xargs -r kill -9 2>/dev/null || true
    fi
  fi
}
kill_old_launcher

echo "=== D2R Launcher ==="
echo ""

if [ ! -f "$ELECTRON" ]; then
  echo "Installing dependencies..."
  cd "$REPO_ROOT"
  yarn install
fi

echo "Launching D2R Launcher GUI..."
exec "$ELECTRON" "$SCRIPT_DIR/electron/main.mjs" "$@"
