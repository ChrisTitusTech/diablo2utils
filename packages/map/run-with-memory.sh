#!/bin/bash
set -e

# Combined launcher: starts the map server AND the memory reader.
#
# The map server (Express on port 8899) generates map layouts from d2-map.exe.
# The memory reader watches the running D2R process, detects seed/difficulty/act
# changes, and automatically fetches the corresponding maps from the server,
# pre-warming the cache so the browser map viewer is always up to date.
#
# Usage:
#   ./run-with-memory.sh <playerName>
#
# Environment variables (all optional):
#   D2_PATH          – path to classic D2 DLLs + MPQs (default: assets/d2)
#   DIABLO2_PATH     – path to D2R install for MPQ loading by memory reader
#   MAP_SERVER_URL   – map server base URL (default: http://localhost:8899)
#   PORT             – map server port (default: 8899)
#   WINEPREFIX       – Wine prefix for d2-map.exe

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ $# -lt 1 ]; then
    echo "Usage: $0 <playerName>"
    echo ""
    echo "Starts the map server and the memory reader together."
    echo "The memory reader watches D2R for seed changes and pre-fetches maps."
    exit 1
fi

PLAYER_NAME="$1"
shift

# Load environment persisted by install.sh
# shellcheck source=.env
[ -f "$SCRIPT_DIR/.env" ] && source "$SCRIPT_DIR/.env"

export D2_PATH="${D2_PATH:-$SCRIPT_DIR/../../assets/d2}"
export WINEPREFIX="${WINEPREFIX:-$HOME/.local/share/d2map/.prefix}"
export PORT="${PORT:-8899}"
export MAP_SERVER_URL="${MAP_SERVER_URL:-http://localhost:$PORT}"

# --- Start map server in background ---
echo "=== Starting map server on http://localhost:$PORT ==="

MAP_SERVER_PID=""
cleanup() {
    echo ""
    echo "Shutting down..."
    [ -n "$MAP_SERVER_PID" ] && kill "$MAP_SERVER_PID" 2>/dev/null
    # Kill any leftover child processes
    jobs -p | xargs -r kill 2>/dev/null
    wait 2>/dev/null
    echo "Done."
}
trap cleanup EXIT INT TERM

# The map server needs to run from dist/ with /app/game symlink
(
    cd "$SCRIPT_DIR/dist"

    # Symlink bin/ so the server can find d2-map.exe
    [ ! -e bin ] && ln -s "$SCRIPT_DIR/bin" bin

    # /app/game and /app/d2.install.reg symlinks
    if [ ! -e /app/game ]; then
        echo "Creating /app/game -> $D2_PATH (requires sudo)"
        sudo mkdir -p /app
        sudo ln -sfn "$D2_PATH" /app/game
    fi
    if [ ! -e /app/d2.install.reg ]; then
        echo "Creating /app/d2.install.reg -> $SCRIPT_DIR/d2.install.reg"
        sudo ln -sfn "$SCRIPT_DIR/d2.install.reg" /app/d2.install.reg
    fi

    exec node index.cjs
) &
MAP_SERVER_PID=$!

# Wait for the map server to come up
echo "Waiting for map server..."
for i in $(seq 1 30); do
    if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
        echo "Map server is ready."
        break
    fi
    if ! kill -0 "$MAP_SERVER_PID" 2>/dev/null; then
        echo "ERROR: Map server exited unexpectedly."
        exit 1
    fi
    sleep 1
done

if ! curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
    echo "ERROR: Map server did not become ready within 30 seconds."
    exit 1
fi

echo ""
echo "=== Starting memory reader for player '$PLAYER_NAME' ==="
echo "  Map server:  http://localhost:$PORT"
echo "  Map viewer:  http://localhost:$PORT  (open in browser)"
echo ""

# Run the memory reader in the foreground
cd "$REPO_ROOT"
exec node packages/memory/build/cli.js "$PLAYER_NAME"
