# D2R Memory Reading — Documentation

This directory documents how diablo2utils reads Diablo II Resurrected (D2R) process memory on Linux via `/proc/PID/mem` to extract game state (player position, map seed, items, etc.) without modifying the game.

## New User Start Here

If you're new to this project, read the documents in this order:

1. **[Patching Guide](patching-guide.md)** — Start here. Explains the core concepts (process memory, PE format, addressing modes, DRM) and walks through every method for finding memory offsets. Includes step-by-step instructions for the automated scanning scripts.

2. **[D2R Memory Offsets](d2r-memory-offsets.md)** — Reference for all struct layouts, field offsets, sizes, and types. Look here when you need to know "what's at offset 0x38 in a UnitAny?"

3. **[Pointer Chains](pointer-chains.md)** — How the code traverses from the UnitHashTable to each piece of game data (player position, map seed, difficulty, items). Read this to understand the chain of memory reads.

4. **[Algorithms](algorithms.md)** — The math and logic behind data processing: map seed derivation (LCG inverse), ItemsTxt scanning, process discovery, module base detection.

## Quick Reference — What Changes Between Patches

Almost every D2R patch can shift struct field offsets. The items most likely to change:

1. **`UNIT_TABLE_OFFSET`** — the offset from D2R.exe's module base to the global `UnitHashTable`. This changes with almost every patch.
2. **Struct field offsets** — any field inside `UnitAny`, `Act`, `ActMisc`, `Path`, `Room`, `RoomEx`, `Level`, `ItemData`, `PlayerData`, or `StatList` can shift.
3. **ItemsTxt record stride** — the size of each item record in D2R's internal table. New item fields or re-ordering shifts this.

## Automated Offset Recovery

Ready-to-run scripts for finding and verifying offsets after a patch:

```bash
# Scan for all known offsets (requires D2R running in a game)
python3 patch-scripts/scan-offsets.py

# Verify a candidate offset structurally (hash table shape check)
python3 patch-scripts/verify-offset.py --offset 0x1EAA3D0

# Deep-verify struct layouts (walks pointer chains to read player data)
python3 patch-scripts/verify-structs.py --offset 0x1EAA3D0
```

See [`patch-scripts/README.md`](../patch-scripts/README.md) for full usage and the [Patching Guide — Method B](patching-guide.md#method-b-byte-pattern-scanning-automated) for how it all works.

## Source Files

All memory-reading code lives in `packages/memory/src/`:

| File | Purpose |
|---|---|
| `d2.ts` | `Diablo2Process` class — hash table walking, module base detection |
| `d2.player.ts` | `Diablo2Player` — reads player state, stats, act, path, level |
| `session.ts` | `Diablo2GameSessionMemory` — game loop, seed derivation, item tracking |
| `process.ts` | `Process` — `/proc/PID/mem` reading, memory map parsing, PID discovery |
| `d2r.items.ts` | Runtime ItemsTxt scanner — builds txtFileNo→code mapping from D2R memory |
| `struts/d2r.unit.any.ts` | `UnitAny`, `PlayerData`, `ItemData`, `NpcData` struct definitions |
| `struts/d2r.act.ts` | `Act`, `ActMisc` struct definitions |
| `struts/d2r.path.ts` | `Path` struct definition |
| `struts/d2r.room.ts` | `Room`, `RoomEx`, `Level` struct definitions |
| `struts/d2r.ts` | `StatList`, `Stat` struct definitions |
| `struts/pointer.ts` | `Pointer` class — 64-bit pointer reading with validity checks |
