#!/bin/bash
set -e

# Load environment persisted by install.sh (D2_PATH, WINEPREFIX, etc.)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.env
[ -f "$SCRIPT_DIR/.env" ] && source "$SCRIPT_DIR/.env"

# Classic Diablo II v1.13c DLLs are bundled in assets/d2/ inside this repo.
# Override D2_PATH in .env or your environment if needed.
# MPQ game data files must also be present (symlinked by install.sh).
D2_PATH="${D2_PATH:-$SCRIPT_DIR/../../assets/d2}"

if [ ! -f "$D2_PATH/Game.exe" ]; then
    echo "ERROR: Game.exe not found at: $D2_PATH"
    echo ""
    echo "Run install.sh first — it sets up the assets/d2 directory."
    exit 1
fi

# Use a dedicated Wine prefix for the map generator.
export WINEPREFIX="${WINEPREFIX:-$HOME/.local/share/d2map/.prefix}"

# Use system wine. Install on Arch with: sudo pacman -S wine
WINE="${WINE:-wine}"

if ! command -v "$WINE" &>/dev/null; then
    echo "ERROR: wine not found. Install it with: sudo pacman -S wine"
    exit 1
fi

"$WINE" bin/d2-map.exe "$D2_PATH" "$@"