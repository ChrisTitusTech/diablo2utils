# Pointer Chains

This document describes every pointer chain traversed to read game state from D2R's process memory.

All chains start from the D2R.exe module base address + `UNIT_TABLE_OFFSET` (`0x1EAA3D0`).

---

## Table of Contents

- [Finding the Player](#finding-the-player)
- [Player Position](#player-position)
- [Current Level ID](#current-level-id)
- [Map Seed](#map-seed)
- [Difficulty](#difficulty)
- [Player Stats](#player-stats)
- [Ground Items](#ground-items)
- [Item Level Filtering](#item-level-filtering)

---

## Finding the Player

**Source**: `packages/memory/src/d2.ts` → `scanForPlayer()`, `scanForPlayerInHashTable()`

Three strategies are tried in order:

### Strategy 1: Cached Offset (Fastest)

```
lastOffset.player → read UnitAny → validate all pointers
```

If the cached player offset is still valid (all pointers pass validation), reuse it immediately. This is the common case during normal gameplay.

### Strategy 2: Hash Table Scan (Fast — milliseconds)

```
D2R.exe base + UNIT_TABLE_OFFSET + 0x000  (Player type = 0)
  → 128 hash buckets (each a u64 pointer)
  → for each non-null bucket:
      → read UnitAny at bucket pointer
      → check: type == 0 (Player)
      → read PlayerData at UnitAny.pData (0x10)
      → read name at PlayerData+0x00 (64-byte string)
      → if name matches (or auto-detect mode): FOUND
      → else: follow UnitAny.pNext (0x150) to next unit in chain
```

**Auto-detect mode**: When no player name is specified, the first valid player unit is accepted. This allows the tool to work without knowing the character name in advance.

### Strategy 3: Full Memory Scan (Slow — last resort, initial startup only)

```
1. Scan all rw memory regions for player name string (0x40-aligned)
2. For each match, validate surrounding PlayerData struct
   - All 6 quest/waypoint pointers must be valid
3. Then scan memory near that offset for a pointer TO the PlayerData address
   - The pointer at (found_address - 0x10) should be within a UnitAny struct
4. Validate the UnitAny has all valid pointers
```

This is only used on first startup if the hash table scan fails. Subsequent re-acquisitions use hash table scan only (with `skipSlowScan=true`).

---

## Player Position

**Chain**: `UnitAny → Path → (x, y)`

```
UnitAny (at cached player offset)
  └─ pPath @ 0x38 → Path struct
       ├─ x     @ 0x02  (u16) ← player tile X
       └─ y     @ 0x06  (u16) ← player tile Y
```

| Path Field | Offset | Used For |
|---|---|---|
| `x` | `0x02` | Player dynamic X position |
| `y` | `0x06` | Player dynamic Y position |
| `staticX` | `0x10` | Item static X position |
| `staticY` | `0x14` | Item static Y position |

**Position loss detection**: If `x == 0 && y == 0` for 4 consecutive ticks (≈1 second at 250ms tick rate), the player is marked as "lost" — likely quit to menu while the stale UnitAny pointer still resolves.

---

## Current Level ID

**Chain**: `UnitAny → Path → Room → RoomEx → Level → levelId`

```
UnitAny
  └─ pPath @ 0x38 → Path
       └─ pRoom @ 0x20 → Room
            └─ pRoomExt @ 0x18 → RoomEx
                 └─ pLevel @ 0x90 → Level
                      └─ levelId @ 0x1F8  (u32)
```

**Total pointer dereferences**: 4 (pPath → pRoom → pRoomExt → pLevel)

Each pointer is validated before dereferencing. If any pointer is invalid, levelId falls back to 0 and the current act is used as a fallback via `ActUtil.fromLevel()`.

---

## Map Seed

**Chain**: `UnitAny → Act → ActMisc → (initSeedHash, endSeedHash) → derivation`

```
UnitAny
  └─ pAct @ 0x20 → Act
       ├─ mapSeed   @ 0x1C  (u32) ← direct seed (fallback)
       └─ pActMisc  @ 0x70 → ActMisc
            ├─ initSeedHash @ 0x840  (u64)
            └─ endSeedHash  @ 0x860  (u32)
```

**Preferred method**: Derive the seed from `initSeedHash` and `endSeedHash` using the LCG inverse (see [algorithms.md](algorithms.md#map-seed-derivation)).

**Fallback**: Use `Act.mapSeed` at offset `0x1C` directly (less reliable, may be stale).

**Mismatch handling**: If both the derived seed and `Act.mapSeed` are non-zero and differ, a warning is logged. The derived seed is preferred.

---

## Difficulty

**Chain**: `UnitAny → Act → ActMisc → difficulty`

```
UnitAny
  └─ pAct @ 0x20 → Act
       └─ pActMisc @ 0x70 → ActMisc
            └─ difficulty @ 0x830  (u32)
```

**Validation**: Must be 0 (Normal), 1 (Nightmare), or 2 (Hell). Any other value indicates struct offset shift.

**Fallback cascade**:
1. Read from ActMisc.difficulty
2. If invalid, check CLI flags (`--normal`, `--nightmare`)
3. Default to Hell (Difficulty.Hell = 2)

---

## Player Stats

**Chain**: `UnitAny → StatList → Stat[]`

```
UnitAny
  └─ pStats @ 0x88 → StatList
       ├─ pStats @ 0x30 → Stat[count]
       └─ count  @ 0x38  (u16)
```

Reading stats:
```
1. Read StatList at UnitAny.pStats.offset
2. Read count from StatList + 0x38
3. Read (count × 8) bytes from StatList.pStats.offset
4. Parse each 8-byte Stat: code (u16 @ 0x02), value (u32 @ 0x04)
```

**Stat value adjustments**:
- Life: `raw_value >> 8` (shifted by 8 bits)
- Experience: raw value (no shift)
- Level: raw value (no shift)

---

## Ground Items

**Chain**: Hash table → UnitAny chain → ItemData

```
D2R.exe base + UNIT_TABLE_OFFSET + 0x1000  (Item type = 4)
  → 128 hash buckets
  → for each bucket:
      → follow linked list via UnitAny.pNext (0x150)
      → filter: type == 4, mode == 3 or 5
      → read ItemData at UnitAny.pData (0x10):
           ├─ dwOwnerId @ 0x0C  → must be 0 or 0xFFFFFFFF
           ├─ invPage    @ 0x55  → must be > 2
           ├─ quality    @ 0x00
           ├─ flags      @ 0x18
           └─ uniqueOrSetId @ 0x34
      → read item position from UnitAny.pPath → Path.staticX/staticY
```

**Item identification**:
```
UnitAny.txtFileNo → D2RItemTable.byIndex → { code, nameId }
                     (runtime scan)
                     
    fallback → Diablo2Mpq.items.byIndex[txtFileNo]
               (classic MPQ data)
```

**Filtering order**:
1. Type must be 4 (Item)
2. Mode must be 3 (ground) or 5 (dropping)
3. `dwOwnerId` must be 0 or 0xFFFFFFFF (not in any player's inventory)
4. `invPage` must be > 2 (not in inventory/stash/cube)
5. Item code must not be a body part (`hrt`, `brz`, `jaw`, etc.)
6. Item must have a localized name
7. Act must match the player's current act
8. Level must match (or be unresolvable — allowed through)

---

## Item Level Filtering

**Chain**: `UnitAny → Path → Room → RoomEx → Level → levelId`

Same chain as [Current Level ID](#current-level-id), but applied to each ground item's UnitAny.

```
Item UnitAny
  └─ pPath @ 0x38 → Path (StaticPath for items)
       └─ pRoom @ 0x20 → Room
            └─ pRoomExt @ 0x18 → RoomEx
                 └─ pLevel @ 0x90 → Level
                      └─ levelId @ 0x1F8
```

**Important**: Item paths use a `StaticPath` layout where `pRoom` at offset `0x20` may not be populated or may point to a stale/unloaded room. Because of this, items are only **excluded** when the chain resolves successfully AND the levelId differs from the player's current level. If the chain breaks at any point, the item is allowed through (the act-based filter already eliminates most cross-area phantoms).
