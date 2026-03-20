# @diablo2/overlay

Transparent minimap overlay for Diablo 2 Resurrected using [Tauri v2](https://v2.tauri.app/).

Renders the collision map, exits, waypoints, and player position as a small always-on-top transparent window that sits on top of D2R.

## Architecture

```
┌─────────────────┐       WebSocket        ┌──────────────┐
│  D2R.exe        │                         │  Map Server  │
│  (game running) │◄── memory reader ──────►│  :8899       │
└─────────────────┘   POST /v1/state        └──────┬───────┘
                                                   │ ws:// + http://
       ┌───────────────────────────────────────────►│
       │                                           │
┌──────┴──────────┐                                │
│  Overlay (Tauri)│◄───────────────────────────────┘
│  transparent    │   game state + map JSON
│  always-on-top  │
│  click-through  │
└─────────────────┘
```

The overlay is a **consumer** of the existing map server infrastructure. It connects via WebSocket to receive real-time game state updates (player position, seed, difficulty, act) and fetches map data via HTTP.

## Prerequisites

1. **Rust toolchain** — install via [rustup](https://rustup.rs)
2. **Tauri CLI** — `cargo install tauri-cli --version "^2"`
3. **Map server + memory reader** running:
   ```bash
   cd packages/map && ./run.sh
   ```
   This starts both the map server (`:8899`) and the memory reader in one process. The player name is auto-detected from D2R.

## Usage

### Development

```bash
# 1. Start the map server + memory reader (runs on port 8899)
cd packages/map && ./run.sh &

# 2. Run the overlay in dev mode
cd packages/overlay && ./run.sh
```

`run.sh` sets compositor-level window opacity (default 70%) via `_NET_WM_WINDOW_OPACITY`,
which picom uses to blend the overlay with what's behind it. Adjust with:

```bash
OVERLAY_OPACITY=80 ./run.sh   # 80% opacity (less see-through)
OVERLAY_OPACITY=50 ./run.sh   # 50% opacity (more see-through)
```

### Production Build

```bash
cd packages/overlay && ./build.sh

# Run the compiled binary directly
./src-tauri/target/release/diablo2-overlay
```

### Configuration

Pass the map server address via query parameter (controls which map server
the overlay connects to for game state + map data):

```
?server=localhost:8899    (default — map server port)
?server=192.168.1.100:8899
```

### Controls

- **Alt (hold)** — Make the overlay interactive for dragging/resizing
- **Alt (release)** — Return to click-through mode

### Minimap Settings

The minimap renderer supports configuration through the `OverlayApp` constructor:

| Option | Default | Description |
|--------|---------|-------------|
| `viewRadius` | `120` | Viewport radius in game units around the player |
| `bgColor` | `rgba(0,0,0,0.45)` | Background color/opacity |
| `mapColor` | `rgba(200,200,200,0.65)` | Walkable area fill color |
| `exitColor` | `#e74c3c` | Exit marker color |
| `waypointColor` | `#3498db` | Waypoint marker color |
| `playerColor` | `#2ecc71` | Player marker color |
| `markerSize` | `6` | Exit/waypoint marker size (px) |
| `playerSize` | `4` | Player dot radius (px) |
| `circular` | `true` | Circular mask vs rectangular |

## Features

- **Transparent overlay** — See the game through the overlay
- **Always-on-top** — Stays above D2R window
- **Click-through** — Mouse events pass to the game; hold Alt to interact
- **Auto-reconnect** — Reconnects to map server if connection drops
- **Minimap mode** — Compact view centered on player position
- **Real-time updates** — Player position updates via WebSocket (~250ms)

## Window Manager Configuration

### DWM

The overlay window must be set to floating in DWM so it isn't tiled.
Add a rule in your `config.h`:

```c
static const Rule rules[] = {
    /* class                instance  title  tags mask  isfloating  monitor */
    { "Diablo2-overlay",    NULL,     NULL,  0,         1,          -1 },
};
```

- Set `monitor` to pin it to a specific screen (0-based index), or `-1` to follow focus
- Set `tags mask` to `~0` to make it visible on all tags (sticky)

Verify the WM_CLASS with: `xprop WM_CLASS` (then click the overlay window).

## Tech Stack

- **Tauri v2** — Lightweight native window shell (~10MB vs ~100MB for Electron)
- **MapLibre GL** — Embeds the existing map viewer from `:8899`
- **picom / compositor** — Window-level opacity via `_NET_WM_WINDOW_OPACITY`

## Transparency Notes

Transparency is handled at the **compositor level** (whole-window opacity) rather
than per-pixel alpha. WebKitGTK's software renderer does not properly clear RGBA
surface buffers between frames, causing smearing artifacts with `transparent: true`.

The approach used here (inspired by how PrimeMH handles overlays):
1. Window is **opaque** with a black background
2. `run.sh` sets `_NET_WM_WINDOW_OPACITY` so picom blends the entire window
3. Black areas become semi-transparent, map content shows through at the configured opacity

If you use a compositor other than picom, ensure it respects the `_NET_WM_WINDOW_OPACITY`
atom (most EWMH-compliant compositors do).

You can also set opacity permanently in your picom config:
```
opacity-rule = ["70:class_g = 'Diablo2-overlay'"];
```
