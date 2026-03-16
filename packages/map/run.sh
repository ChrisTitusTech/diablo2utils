#!/bin/bash
set -e

# Start the Diablo 2 map web viewer (Express server on port 8899).
# The bundled server (dist/index.cjs) spawns d2-map.exe via Wine
# and serves a map viewer at http://localhost:$PORT.
#
# For CLI-only JSON output, use run-clionly.sh instead.

# Load environment persisted by install.sh (D2_PATH, WINEPREFIX, etc.)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.env
[ -f "$SCRIPT_DIR/.env" ] && source "$SCRIPT_DIR/.env"

D2_PATH="${D2_PATH:-$SCRIPT_DIR/../../assets/d2}"

if [ ! -f "$D2_PATH/Storm.dll" ]; then
    echo "ERROR: Storm.dll not found at: $D2_PATH"
    echo ""
    echo "Run install.sh first — it sets up the assets/d2 directory."
    exit 1
fi

# Use a dedicated Wine prefix for the map generator.
export WINEPREFIX="${WINEPREFIX:-$HOME/.local/share/d2map/.prefix}"

# Wine must be available for d2-map.exe (spawned by the Node server).
WINE="${WINE:-wine}"
if ! command -v "$WINE" &>/dev/null; then
    echo "ERROR: wine not found. Install it with: sudo pacman -S wine"
    exit 1
fi

# Check that the bundled server exists.
if [ ! -f "$SCRIPT_DIR/dist/index.cjs" ]; then
    echo "ERROR: dist/index.cjs not found. Run install.sh first to bundle the server."
    exit 1
fi

# The Node server looks for www/ relative to cwd, and bin/d2-map.exe
# relative to cwd.  It also hardcodes /app/game and /app/d2.install.reg.
cd "$SCRIPT_DIR/dist"

# Symlink bin/ so the server can find d2-map.exe at ./bin/d2-map.exe
if [ ! -e bin ]; then
    ln -s "$SCRIPT_DIR/bin" bin
fi

# The bundled server expects the game files at /app/game and the
# registry file at /app/d2.install.reg.  Create symlinks if they
# don't exist yet (requires sudo the first time).
if [ ! -e /app/game ]; then
    echo "Creating /app/game -> $D2_PATH (requires sudo)"
    sudo mkdir -p /app
    sudo ln -sfn "$D2_PATH" /app/game
fi
if [ ! -e /app/d2.install.reg ]; then
    echo "Creating /app/d2.install.reg -> $SCRIPT_DIR/d2.install.reg"
    sudo ln -sfn "$SCRIPT_DIR/d2.install.reg" /app/d2.install.reg
fi

PORT="${PORT:-8899}"
export PORT

echo "Starting map server on http://localhost:$PORT"
echo "  D2_PATH:    $D2_PATH"
echo "  WINEPREFIX: $WINEPREFIX"
echo ""
echo "Open http://localhost:$PORT in your browser."
echo "Press Ctrl+C to stop."
echo ""

exec node index.cjs "$@"
