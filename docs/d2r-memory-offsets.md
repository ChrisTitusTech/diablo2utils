# D2R Memory Offsets & Struct Layouts

> **D2R Version**: 3.1.91636 (latest patch as of this writing)
>
> **Reference**: Offsets are cross-checked with [PrimeMH](https://github.com/) and d2r-mapview.
>
> **Source**: `packages/memory/src/struts/`

---

## Table of Contents

- [Global Constants](#global-constants)
- [PrimeMH Community Offsets](#primemh-community-offsets)
- [UnitHashTable Layout](#unithashtable-layout)
- [UnitAny (D2rUnitStrut)](#unitany-d2runitstrut)
- [PlayerData (D2rUnitDataPlayerStrut)](#playerdata-d2runitdataplayerstrut)
- [ItemData (D2rUnitDataItemStrut)](#itemdata-d2runitdataitemstrut)
- [NpcData (D2rUnitDataNpcStrut)](#npcdata-d2runitdatanpcstrut)
- [Act (D2rActStrut)](#act-d2ractstrut)
- [ActMisc (D2rActMiscStrut)](#actmisc-d2ractmiscstrut)
- [Path (D2rPathStrut)](#path-d2rpathstrut)
- [Room (D2rRoomStrut)](#room-d2rroomstrut)
- [RoomEx (D2rRoomExStrut)](#roomex-d2rroomexstrut)
- [Level (D2rLevelStrut)](#level-d2rlevelstrut)
- [StatList (D2rStatListStrut)](#statlist-d2rstatliststrut)
- [Stat (D2rStatStrut)](#stat-d2rstatstrut)
- [Pointer Validity](#pointer-validity)
- [Item Flags](#item-flags)
- [Seed Constants](#seed-constants)

---

## Global Constants

Defined in `packages/memory/src/d2.ts`:

| Constant | Value | Description |
|---|---|---|
| `UNIT_TABLE_OFFSET` | `0x1EAA3D0` | Offset from D2R.exe module base to the UnitHashTable global. **This is the primary value that changes each patch.** Override with env var `D2R_UNIT_TABLE_OFFSET`. |
| `HASH_BUCKET_COUNT` | `128` | Number of hash buckets per unit type |
| `HASH_BUCKET_SIZE` | `8` | Bytes per bucket (one 64-bit pointer) |
| `ITEM_ARRAY_OFFSET` | `0x1000` | `4 × 128 × 8` — byte offset to skip Player/NPC/Object/Missile arrays to reach Item array |

### PE Base Addresses (for module base detection)

| Candidate | Value | Notes |
|---|---|---|
| Default 64-bit PE base | `0x140000000` | Wine often maps D2R.exe here |
| Fallback 32-bit base | `0x400000` | Rare, but checked as fallback |
| Verification | Read 4 bytes, check for `MZ` (0x4D, 0x5A) DOS header magic | |

---

## PrimeMH Community Offsets

These additional offsets come from [PrimeMH's `find_offsets` function](https://github.com/) — a Rust-based D2R tool that uses byte pattern scanning to locate offsets dynamically. Only `unit_table` is currently used by diablo2utils; the rest are documented here for future features and as cross-references when hunting offsets after a patch.

> **D2R Version**: 3.1.91636 — all values below are for this specific build.

### Offset Table

| Name | Value | Adjustment | Final Value | Description |
|---|---|---|---|---|
| `unit_table` | `0x1EAA3D0` | — | `0x1EAA3D0` | Global UnitHashTable (same as our `UNIT_TABLE_OFFSET`) |
| `ui_offset` | `0x1EBA0C2` | `- 0xA` | `0x1EBA0B8` | UI state flags byte array — each byte is a boolean for a UI panel |
| `expansion` | `0x1DFD4E0` | — | `0x1DFD4E0` | Expansion flag — non-zero when running Lord of Destruction |
| `hover` | `0x1DFE090` | — | `0x1DFE090` | Hovered unit info — contains `type` and `unitId` of the unit under cursor |
| `roster` | `0x1EC06E0` | — | `0x1EC06E0` | Party roster linked list head — `RosterUnit` structs for party members |
| `panels` | `0x1E14E38` | — | `0x1E14E38` | UI panels state pointer — tracks which panels (inventory, skills, etc.) are open |
| `keybindings` | `0x19D55B4` | — | `0x19D55B4` | Key bindings data — array of skill/action key mappings |
| `last_game_name` | `0x25F1450` | — | `0x25F1450` | Last game name string — the name of the most recently joined/created game |

### Byte Scan Patterns

PrimeMH finds these offsets by scanning the D2R.exe module for unique byte signatures, then applying a relative offset adjustment. The `pattern_offset` is the byte index within the matched pattern where a RIP-relative displacement starts, and `adj` is added to the resolved address.

| Name | Byte Pattern | `pattern_offset` | `adj` | Mode | Notes |
|---|---|---|---|---|---|
| `unit_table` | `48 03 C7 49 8B 8C C6` | 7 | 0 | direct | `add rax,rdi; mov rcx,[r14+rax*8+disp32]` — disp32 IS the offset |
| `ui_offset` | `40 84 ed 0f 94 05` | 6 | +10 | rip_relative | `test` + `sete [rip+disp32]` |
| `expansion` | `48 8B 05 ?? ?? ?? ?? ?? 8B D9 F3 0F 10 50 ??` | 3 | +7 | rip_relative | `mov rax, [rip+disp]` — wildcard bytes (`??`) are ignored during scan |
| `hover` | `C6 84 C2 ?? ?? ?? ?? ?? 48 8B 74 24 ??` | 3 | -1 | direct | `mov byte [rdx+rax*8+disp32]` — displacement is the hover struct offset |
| `roster` | `02 45 33 D2 4D 8B` | -3 | +1 | rip_relative | Mid-instruction pattern; negative offset backs up to the RIP-relative disp |
| `panels` | `48 89 05 ?? ?? ?? ?? 48 85 DB 74 1E` | 3 | +7 | rip_relative | `mov [rip+disp32], rax` — stores panel pointer |
| `keybindings` | `02 00 00 00 ?? ?? 00 00 00 00 03 00 00 00 ?? ?? 01 00 00 00` | 0 | +0x158C | data | Data pattern match — offset is match_rva + adj |
| `last_game_name` | *(none — hardcoded)* | — | — | — | No scan pattern provided; defined directly in PrimeMH's `Offsets` struct |

### Addressing Modes

Not all patterns use RIP-relative addressing. Each pattern resolves via one of three modes:

| Mode | Formula | When Used |
|---|---|---|
| `rip_relative` | `final = match_rva + pattern_offset + 4 + disp32 + adj` | Most patterns — `[rip+disp32]` addressing |
| `direct` | `final = disp32 + adj` | When a register holds the module base — `[reg+rax*8+disp32]` |
| `data` | `final = match_rva + adj` | Data patterns where the match location itself is the target |

### How Pattern Scanning Works

```
1. Read D2R.exe's decrypted .text section from /proc/PID/mem
   (On-disk .text is DRM-encrypted — must read from a running process)
2. For each pattern:
   a. Search for the byte sequence (treating ?? as wildcard)
   b. At match_offset + pattern_offset, read a 4-byte signed i32 displacement
   c. Resolve using the pattern's addressing mode:
      - rip_relative: final = match_rva + pattern_offset + 4 + disp + adj
      - direct:       final = disp + adj
      - data:         final = match_rva + adj
3. The result is an offset relative to D2R.exe's base address
```

This approach survives minor patches where code is shifted but instruction patterns remain the same. Only major refactors that change the instruction sequences require new patterns.

> **Automated tooling**: See [`patch-scripts/`](../patch-scripts/) for ready-to-run Python scripts that implement this scanning and verification process.

---

## UnitHashTable Layout

The UnitHashTable is a contiguous array of `5 × 128 = 640` 64-bit pointers (5120 bytes total).

```
Base + UNIT_TABLE_OFFSET:
┌─────────────────────────────────────────────────────┐
│ Unit Type 0 (Player)  │ 128 buckets × 8 bytes = 1024 bytes  │  offset: 0x000
│ Unit Type 1 (NPC)     │ 128 buckets × 8 bytes = 1024 bytes  │  offset: 0x400
│ Unit Type 2 (Object)  │ 128 buckets × 8 bytes = 1024 bytes  │  offset: 0x800
│ Unit Type 3 (Missile) │ 128 buckets × 8 bytes = 1024 bytes  │  offset: 0xC00
│ Unit Type 4 (Item)    │ 128 buckets × 8 bytes = 1024 bytes  │  offset: 0x1000
└─────────────────────────────────────────────────────┘
```

Each bucket is a `u64` pointer to the first `UnitAny` in a linked list. Units in the same bucket are chained via `UnitAny.pNext` (offset `0x150`).

**Hash function**: `unitId % 128` determines the bucket index.

---

## UnitAny (D2rUnitStrut)

**Size**: `0x174` bytes (372 bytes)
**Source**: `packages/memory/src/struts/d2r.unit.any.ts`

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| `0x00` | 4 | `u32` | `type` | Unit type enum: 0=Player, 1=NPC, 2=Object, 3=Missile, 4=Item |
| `0x04` | 4 | `u32` | `txtFileNo` | Index into the corresponding txt data table (e.g., ItemsTxt for items) |
| `0x08` | 4 | `u32` | `unitId` | Unique unit identifier (used for hash bucket lookup: `unitId % 128`) |
| `0x0C` | 4 | `u32` | `mode` | Unit mode/animation state. For items: 3=on ground, 5=dropping |
| `0x10` | 8 | `ptr64` | `pData` | Pointer to type-specific data (PlayerData / ItemData / NpcData) |
| `0x18` | 4 | `u32` | `actId` | Current act number (0-4) |
| `0x20` | 8 | `ptr64` | `pAct` | Pointer to `Act` struct |
| `0x38` | 8 | `ptr64` | `pPath` | Pointer to `Path` struct (position + room reference) |
| `0x88` | 8 | `ptr64` | `pStats` | Pointer to `StatList` struct |
| `0x150` | 8 | `u64` | `pNext` | Next unit in hash chain (linked list within same bucket) |
| `0x158` | 8 | `u64` | `pRoomNext` | Next unit in room's unit list (used by room-based traversal) |
| `0x174` | 1 | `u8` | `playerClass` | Player class ID (only meaningful when type=0) |

### Unit Types

| Value | Type | Hash Table Offset |
|---|---|---|
| 0 | Player | `base + 0x000` |
| 1 | NPC/Monster | `base + 0x400` |
| 2 | Object | `base + 0x800` |
| 3 | Missile | `base + 0xC00` |
| 4 | Item | `base + 0x1000` |

### Item Modes

| Value | Meaning |
|---|---|
| 3 | On the ground (dropped) |
| 5 | Dropping / falling animation |

---

## PlayerData (D2rUnitDataPlayerStrut)

**Size**: `0x270` bytes (624 bytes)
**Source**: `packages/memory/src/struts/d2r.unit.any.ts`
**Reached via**: `UnitAny.pData` when `type == 0`

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| `0x00` | 64 | `string` | `name` | Player name (null-terminated, up to 64 bytes) |
| `0x40` | 8 | `ptr64` | `questNormal` | Pointer to Normal difficulty quest data |
| `0x48` | 8 | `ptr64` | `questNightmare` | Pointer to Nightmare difficulty quest data |
| `0x50` | 8 | `ptr64` | `questHell` | Pointer to Hell difficulty quest data |
| `0x58` | 8 | `ptr64` | `wpNormal` | Pointer to Normal difficulty waypoint data |
| `0x60` | 8 | `ptr64` | `wpNightmare` | Pointer to Nightmare difficulty waypoint data |
| `0x68` | 8 | `ptr64` | `wpHell` | Pointer to Hell difficulty waypoint data |
| `0xC0` | 8 | `ptr64` | `playerTrade` | Pointer to trade data |

**Validation**: All six quest/waypoint pointers must be valid (within pointer validity range) for the PlayerData to be considered genuine.

---

## ItemData (D2rUnitDataItemStrut)

**Size**: `0x56` bytes (86 bytes)
**Source**: `packages/memory/src/struts/d2r.unit.any.ts`
**Reached via**: `UnitAny.pData` when `type == 4`

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| `0x00` | 4 | `u32` | `quality` | Item quality enum (see below) |
| `0x04` | 4 | `u32` | `lowSeed` | Item generation seed (low 32 bits) |
| `0x08` | 4 | `u32` | `highSeed` | Item generation seed (high 32 bits) |
| `0x0C` | 4 | `u32` | `dwOwnerId` | Owner's unitId. `0` or `0xFFFFFFFF` = unowned (ground item). Any other value = owned by a player (in inventory/stash/cube/belt/equipped) |
| `0x10` | 4 | `u32` | `initSeed` | Initial seed |
| `0x14` | 4 | `u32` | `commandFlags` | Command flags |
| `0x18` | 4 | `u32` | `flags` | Item flags bitmask (see [Item Flags](#item-flags)) |
| `0x34` | 4 | `u32` | `uniqueOrSetId` | Unique or Set item ID (when quality is Unique or Set) |
| `0x54` | 1 | `u8` | `bodyLoc` | Body location when equipped |
| `0x55` | 1 | `u8` | `invPage` | Inventory page: 0=inventory, 1=stash, 2=cube, 0xFF=none (ground) |

### Item Quality Values

| Value | Quality |
|---|---|
| 1 | Low Quality |
| 2 | Normal |
| 3 | Superior |
| 4 | Magic |
| 5 | Set |
| 6 | Rare |
| 7 | Unique |
| 8 | Crafted |

### Ground Item Detection

An item is a **ground item** when ALL of:
- `dwOwnerId == 0` or `dwOwnerId == 0xFFFFFFFF`
- `invPage > 2` (not in inventory/stash/cube)
- `mode == 3` or `mode == 5` (on ground or dropping)

---

## NpcData (D2rUnitDataNpcStrut)

**Size**: `0x1B` bytes (27 bytes)
**Source**: `packages/memory/src/struts/d2r.unit.any.ts`
**Reached via**: `UnitAny.pData` when `type == 1`

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| `0x1A` | 1 | `u8` | `flags` | NPC flags |

---

## Act (D2rActStrut)

**Size**: `0x78` bytes (120 bytes)
**Source**: `packages/memory/src/struts/d2r.act.ts`
**Reached via**: `UnitAny.pAct`

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| `0x1C` | 4 | `u32` | `mapSeed` | Map seed (direct, but may be less reliable — prefer derived seed from ActMisc) |
| `0x28` | 4 | `u32` | `actId` | Current act number (0-4) |
| `0x70` | 8 | `ptr64` | `pActMisc` | Pointer to `ActMisc` struct |

**Note**: `pActMisc` was at `0x78` in older versions, moved to `0x70` in current patch.

---

## ActMisc (D2rActMiscStrut)

**Size**: `0x864` bytes (2148 bytes)
**Source**: `packages/memory/src/struts/d2r.act.ts`
**Reached via**: `Act.pActMisc`

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| `0x120` | 4 | `u32` | `tombLevel` | Tomb level ID |
| `0x830` | 4 | `u32` | `difficulty` | Difficulty: 0=Normal, 1=Nightmare, 2=Hell |
| `0x840` | 8 | `u64` | `initSeedHash` | Initial seed hash (used in map seed derivation) |
| `0x860` | 4 | `u32` | `endSeedHash` | End seed hash (used in map seed derivation) |

**History**:
- `difficulty` was `lu16` in older versions, corrected to `u32` to match D2R
- `endSeedHash` was at `0x868` — shifted to `0x860` when `pAct` pointer was removed from the struct

### Difficulty Validation

The `difficulty` field at `0x830` must be 0, 1, or 2. Any other value indicates a struct offset shift (new patch). Fallback: CLI flags `--normal`, `--nightmare`, or default to Hell.

---

## Path (D2rPathStrut)

**Size**: `0x28` bytes (40 bytes)
**Source**: `packages/memory/src/struts/d2r.path.ts`
**Reached via**: `UnitAny.pPath`

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| `0x00` | 2 | `u16` | `xOffset` | X sub-position offset |
| `0x02` | 2 | `u16` | `x` | X position (tile coordinate, used for player) |
| `0x04` | 2 | `u16` | `yOffset` | Y sub-position offset |
| `0x06` | 2 | `u16` | `y` | Y position (tile coordinate, used for player) |
| `0x10` | 2 | `u16` | `staticX` | Static X position (used for items on the ground) |
| `0x14` | 2 | `u16` | `staticY` | Static Y position (used for items on the ground) |
| `0x20` | 8 | `ptr64` | `pRoom` | Pointer to `Room` struct |

**Notes**:
- Player units use `x`/`y` (dynamic position that updates as the player moves)
- Item units use `staticX`/`staticY` (fixed position where the item dropped)
- When `x == 0 && y == 0` for 4+ consecutive ticks, the player is considered "lost" (likely left the game)

---

## Room (D2rRoomStrut)

**Size**: `0xB8` bytes (184 bytes)
**Source**: `packages/memory/src/struts/d2r.room.ts`
**Reached via**: `Path.pRoom`

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| `0x00` | 8 | `ptr64` | `pRoomNear` | Pointer to array of nearby room pointers |
| `0x18` | 8 | `ptr64` | `pRoomExt` | Pointer to `RoomEx` struct (extended room data) |
| `0x40` | 4 | `u32` | `roomNearCount` | Number of nearby rooms (capped at 9 in code) |
| `0x48` | 8 | `ptr64` | `pAct` | Pointer to `Act` struct |
| `0xA8` | 8 | `ptr64` | `pUnitFirst` | Pointer to first `UnitAny` in this room's unit list |
| `0xB0` | 8 | `ptr64` | `pRoomNext` | Pointer to next Room in linked list |

---

## RoomEx (D2rRoomExStrut)

**Size**: `0x98` bytes (152 bytes)
**Source**: `packages/memory/src/struts/d2r.room.ts`
**Reached via**: `Room.pRoomExt`

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| `0x90` | 8 | `ptr64` | `pLevel` | Pointer to `Level` struct |

---

## Level (D2rLevelStrut)

**Size**: `0x200` bytes (512 bytes)
**Source**: `packages/memory/src/struts/d2r.room.ts`
**Reached via**: `RoomEx.pLevel`

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| `0x1F8` | 4 | `u32` | `levelId` | D2 area/level identifier (e.g., 1=Rogue Encampment, 2=Blood Moor, etc.) |

---

## StatList (D2rStatListStrut)

**Size**: `0x3C` bytes (60 bytes)
**Source**: `packages/memory/src/struts/d2r.ts`
**Reached via**: `UnitAny.pStats`

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| `0x30` | 8 | `ptr64` | `pStats` | Pointer to array of `Stat` structs |
| `0x38` | 2 | `u16` | `count` | Number of stats in the array |
| `0x3A` | 2 | `u16` | `countB` | Secondary count (unused by this tool) |

---

## Stat (D2rStatStrut)

**Size**: `8` bytes
**Source**: `packages/memory/src/struts/d2r.ts`
**Reached via**: Array at `StatList.pStats`, iterated `StatList.count` times

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| `0x00` | 2 | `u16` | `unk1` | Unknown / layer |
| `0x02` | 2 | `u16` | `code` | Attribute code (maps to `Attribute` enum in `@diablo2/data`) |
| `0x04` | 4 | `u32` | `value` | Raw stat value (some stats like Life are shifted: `value >> 8`) |

### Common Stat Codes

| Code | Attribute | Notes |
|---|---|---|
| `0x06` | Life | Value is `life << 8`, so divide by 256 to get actual HP |
| `0x0C` | Level | Current character level |
| `0x0D` | Experience | Total experience points |

---

## Pointer Validity

**Source**: `packages/memory/src/struts/pointer.ts`

All 64-bit pointers are validated before dereferencing:

| Check | Condition | Description |
|---|---|---|
| Minimum | `offset >= 0x00110000` | Below this is kernel/reserved memory |
| Maximum (64-bit) | `offset <= 0x7FFFFFFF0000` | Above this is kernel space |
| Maximum (32-bit) | `offset <= 0x7FFF0000` | Only used if pointer type is set to 32-bit |

If **any** pointer in a struct fails validation, the entire struct is considered invalid (used to reject stale/corrupt memory).

---

## Item Flags

**Source**: `packages/memory/src/session.ts`

Bitmask flags read from `ItemData.flags` at offset `0x18`:

| Flag | Value | Description |
|---|---|---|
| `ITEM_FLAG_IDENTIFIED` | `0x00000010` | Item has been identified |
| `ITEM_FLAG_ETHEREAL` | `0x04000000` | Item is ethereal |
| `ITEM_FLAG_RUNEWORD` | `0x40000000` | Item is a runeword |

---

## Seed Constants

**Source**: `packages/memory/src/session.ts`

Used in the map seed derivation algorithm:

| Constant | Value | Description |
|---|---|---|
| `SEED_MAGIC` | `0x6AC690C5` | LCG multiplier |
| `SEED_MAGIC_INVERSE` | `0x8A3E6E0D` | Modular multiplicative inverse of SEED_MAGIC mod 2³² |
| `SEED_OFFSET` | `666` | LCG additive constant |
| `UINT32_MASK` | `0xFFFFFFFF` | Mask to keep values within u32 range |
