#!/bin/bash
# D2R Launcher — start the GUI process manager for map server, memory reader, and overlay.
# Run from any directory: ./launch.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER_MAIN="$REPO_ROOT/packages/launcher/electron/main.mjs"
ELECTRON="$REPO_ROOT/node_modules/electron/dist/electron"

# Install root workspace deps if electron hasn't been downloaded yet
if [ ! -f "$ELECTRON" ]; then
  echo "Installing dependencies (first run)..."
  cd "$REPO_ROOT"
  yarn install
fi

# Ensure an X display is available (needed when launched from a bare terminal/TTY)
if [ -z "$DISPLAY" ]; then
  # Try common defaults — :0 is DWM/startx, :1 is common for secondary seats
  for d in :0 :1; do
    if xdpyinfo -display "$d" &>/dev/null 2>&1; then
      export DISPLAY="$d"
      break
    fi
  done
fi

if [ -z "$DISPLAY" ]; then
  echo "ERROR: No X display found. Set DISPLAY before launching (e.g. DISPLAY=:0 ./launch.sh)." >&2
  exit 1
fi

echo "Starting D2R Launcher... (DISPLAY=$DISPLAY)"
exec "$ELECTRON" "$LAUNCHER_MAIN" "$@"
