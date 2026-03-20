#!/bin/bash
set -e

# Combined launcher: starts the map server AND the memory reader.
#
# The map server (Express on port 8899) generates map layouts from d2-map.exe.
# The memory reader watches the running D2R process, auto-detects the player
# name, and automatically fetches the corresponding maps from the server,
# pre-warming the cache so the browser map viewer is always up to date.
#
# Environment variables (all optional):
#   D2_PATH          – path to classic D2 DLLs + MPQs (default: assets/d2)
#   DIABLO2_PATH     – path to D2R install for MPQ loading by memory reader
#   MAP_SERVER_URL   – map server base URL (default: http://localhost:8899)
#   PORT             – map server port (default: 8899)
#   WINEPREFIX       – Wine prefix for d2-map.exe

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Load environment persisted by install.sh
# shellcheck source=.env
[ -f "$SCRIPT_DIR/.env" ] && source "$SCRIPT_DIR/.env"

export D2_PATH="${D2_PATH:-$SCRIPT_DIR/../../assets/d2}"
export WINEPREFIX="${WINEPREFIX:-$HOME/.local/share/d2map/.prefix}"
export PORT="${PORT:-8899}"
export MAP_SERVER_URL="${MAP_SERVER_URL:-http://localhost:$PORT}"

if [ ! -f "$D2_PATH/Storm.dll" ]; then
    echo "ERROR: Storm.dll not found at: $D2_PATH"
    echo ""
    echo "Run install.sh first — it sets up the assets/d2 directory."
    exit 1
fi

WINE="${WINE:-wine}"
if ! command -v "$WINE" &>/dev/null; then
    echo "ERROR: wine not found. Install it with: sudo pacman -S wine"
    exit 1
fi

if [ ! -f "$SCRIPT_DIR/dist/index.cjs" ]; then
    echo "ERROR: dist/index.cjs not found. Run install.sh first to bundle the server."
    exit 1
fi

find_port_pids() {
    if command -v lsof >/dev/null 2>&1; then
        lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
    elif command -v fuser >/dev/null 2>&1; then
        fuser -n tcp "$PORT" 2>/dev/null | tr ' ' '\n' || true
    else
        return 0
    fi
}

wait_for_port_free() {
    local attempts="${1:-30}"
    local pids

    for _ in $(seq 1 "$attempts"); do
        pids="$(find_port_pids)"
        if [ -z "$pids" ]; then
            return 0
        fi
        sleep 1
    done

    return 1
}

kill_stale_processes() {
    local port_pids
    local patterns=(
        "node $SCRIPT_DIR/dist/index.cjs"
        "node packages/memory/build/cli.js"
        "$SCRIPT_DIR/bin/d2-map.exe"
        "./bin/d2-map.exe"
    )

    echo "=== Cleaning up old map processes ==="

    port_pids="$(find_port_pids)"
    if [ -n "$port_pids" ]; then
        echo "Killing processes listening on port $PORT: $port_pids"
        echo "$port_pids" | xargs -r kill 2>/dev/null || true
        sleep 1
        if port_pids="$(find_port_pids)"; [ -n "$port_pids" ]; then
            echo "Force killing remaining port $PORT listeners: $port_pids"
            echo "$port_pids" | xargs -r kill -9 2>/dev/null || true
        fi
    fi

    for pattern in "${patterns[@]}"; do
        pkill -f "$pattern" 2>/dev/null || true
    done

    if ! wait_for_port_free 15; then
        echo "ERROR: Port $PORT is still in use after cleanup."
        exit 1
    fi
}

# --- Cleanup handler ---
MAP_SERVER_PID=""
MEMORY_READER_PID=""
cleanup() {
    echo ""
    echo "Shutting down..."
    [ -n "$MEMORY_READER_PID" ] && kill "$MEMORY_READER_PID" 2>/dev/null || true
    [ -n "$MAP_SERVER_PID" ] && kill "$MAP_SERVER_PID" 2>/dev/null
    jobs -p | xargs -r kill 2>/dev/null
    wait 2>/dev/null
    echo "Done."
}
trap cleanup EXIT INT TERM

kill_stale_processes

# --- Start map server in background ---
echo "=== Starting map server on http://localhost:$PORT ==="

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

# --- Start memory reader (auto-detect player name) ---
echo ""
echo "=== Starting memory reader (auto-detect player) ==="
echo "  Map server:  http://localhost:$PORT"
echo "  Map viewer:  http://localhost:$PORT  (open in browser)"
echo ""

cd "$REPO_ROOT"
node packages/memory/build/cli.js "$@" &
MEMORY_READER_PID=$!
wait "$MEMORY_READER_PID"
