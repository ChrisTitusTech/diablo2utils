#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== D2R Map Overlay ==="
echo ""
echo "Prerequisites:"
echo "  1. Map server + memory reader running:"
echo "       cd packages/map && ./run.sh"
echo "  2. Rust toolchain (https://rustup.rs)"
echo "  3. Tauri CLI: cargo install tauri-cli"
echo ""

# Minimal dist/ directory for Tauri's frontendDist config
mkdir -p dist
cp src/index.html dist/

# Work around WebKitGTK GBM buffer allocation failure on Linux
export WEBKIT_DISABLE_DMABUF_RENDERER=1

# Overlay opacity (0-100, default 70). Handled at the compositor level
# via _NET_WM_WINDOW_OPACITY so we avoid WebKitGTK's broken RGBA surface
# clearing (which causes smearing with transparent windows).
OVERLAY_OPACITY=${OVERLAY_OPACITY:-70}

# Background job: wait for the overlay window, then set compositor opacity
(
  # Retry up to 15 seconds — first launch compiles and takes longer
  for i in $(seq 1 30); do
    WID=$(xdotool search --name 'D2R Map Overlay' 2>/dev/null | head -1)
    if [ -n "$WID" ]; then
      # Convert percentage to 32-bit unsigned: opacity * 0xFFFFFFFF / 100
      HEX=$(printf '0x%x' $(( 0xFFFFFFFF * OVERLAY_OPACITY / 100 )))
      xprop -id "$WID" -f _NET_WM_WINDOW_OPACITY 32c -set _NET_WM_WINDOW_OPACITY "$HEX"
      echo "Set overlay opacity to ${OVERLAY_OPACITY}% (window $WID)"
      break
    fi
    sleep 0.5
  done
  if [ -z "$WID" ]; then
    echo "Warning: could not find overlay window to set opacity after 15s"
  fi
) &

echo "Launching Tauri overlay (loads map viewer from http://localhost:8899)..."
cargo tauri dev
