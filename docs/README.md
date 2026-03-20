# D2R Memory Offset Documentation

This directory documents the memory structures and offsets used to read Diablo II Resurrected (D2R) process memory on Linux via `/proc/PID/mem`.

When D2R patches change offsets, these docs make it possible to locate and update them.

## Contents

| Document | Description |
|---|---|
| [d2r-memory-offsets.md](d2r-memory-offsets.md) | Complete struct layouts, hex offsets, and field types |
| [pointer-chains.md](pointer-chains.md) | How pointer chains are traversed to reach each piece of data |
| [algorithms.md](algorithms.md) | Map seed derivation, ItemsTxt scanning, process discovery |
| [patching-guide.md](patching-guide.md) | Step-by-step guide for updating offsets after a D2R patch |

## Quick Reference — What Changes Between Patches

Almost every D2R patch can shift struct field offsets. The items most likely to change:

1. **`UNIT_TABLE_OFFSET`** — the offset from D2R.exe's module base to the global `UnitHashTable`. This changes with almost every patch.
2. **Struct field offsets** — any field inside `UnitAny`, `Act`, `ActMisc`, `Path`, `Room`, `RoomEx`, `Level`, `ItemData`, `PlayerData`, or `StatList` can shift.
3. **ItemsTxt record stride** — the size of each item record in D2R's internal table. New item fields or re-ordering shifts this.

### PrimeMH Byte Pattern Scanning

The fastest way to find the new `UNIT_TABLE_OFFSET` after a patch is PrimeMH's byte pattern scanning approach — search D2R.exe's code section for known instruction sequences and resolve RIP-relative displacements. See [d2r-memory-offsets.md — Byte Scan Patterns](d2r-memory-offsets.md#byte-scan-patterns) and [patching-guide.md — Method B](patching-guide.md#method-b-byte-pattern-scanning-primemh-approach) for details.

PrimeMH also provides 7 additional global offsets (UI state, expansion flag, hover info, roster, panels, keybindings, last game name) that diablo2utils does not currently use but are documented for future reference.

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
