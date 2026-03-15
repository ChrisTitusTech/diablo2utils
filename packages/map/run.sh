#!/bin/bash
set -e

# Load environment persisted by install.sh (D2_PATH, WINEPREFIX, etc.)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.env
[ -f "$SCRIPT_DIR/.env" ] && source "$SCRIPT_DIR/.env"

# Default to Steam install path for Diablo II Resurrected on Linux.
# Override by setting D2_PATH in your environment before running this script.
D2_PATH="${D2_PATH:-$HOME/.steam/steam/steamapps/common/Diablo II Resurrected}"

if [ ! -d "$D2_PATH" ]; then
    echo "ERROR: Diablo II Resurrected not found at: $D2_PATH"
    echo "Set the D2_PATH environment variable to your installation directory."
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