# Patching Guide

Step-by-step guide for updating offsets after a D2R patch breaks memory reading.

---

## Symptoms of Broken Offsets

After a D2R patch, you may see any combination of:

| Symptom | Likely Cause |
|---|---|
| `D2R.exe module not found` | PID detection or module base detection failed |
| `Player:NotFound` in logs | `UNIT_TABLE_OFFSET` changed |
| Player found but position is always (0,0) | `Path` struct offsets shifted |
| Map seed is always 0 | `Act` or `ActMisc` offsets shifted |
| Wrong difficulty (always Hell) | `ActMisc.difficulty` offset shifted |
| Items showing wrong names | ItemsTxt stride changed or `txtFileNo` mapping shifted |
| Items not appearing | `ItemData` offsets shifted (dwOwnerId, invPage filtering broken) |
| Crash/hang when reading stats | `StatList` or `Stat` offsets shifted |

---

## Step 1: Find the New UNIT_TABLE_OFFSET

This is the most common change and the first thing to check.

### Method A: From Community Tools

Check these sources for updated offsets:
- **PrimeMH** (D2R map hack) — their source code or release notes usually list the new offset
- **d2r-mapview** — another open-source tool that uses the same offsets
- **MapAssist** (.NET) — popular tool with regularly updated offsets

Look for a value labeled `UnitTable`, `UnitHashTable`, or `pUnitTable` relative to D2R.exe's base address.

### Method B: Byte Pattern Scanning (PrimeMH Approach)

PrimeMH's `find_offsets` function locates offsets by scanning D2R.exe's code section for unique byte patterns that survive minor patches. This is the most reliable automated method.

**How it works**: Each offset is associated with a known instruction sequence. The scanner finds that sequence in memory, reads a RIP-relative displacement from within it, and resolves the absolute address.

#### UNIT_TABLE_OFFSET Pattern

```
Pattern:  48 03 C7 49 8B 8C C6
Offset:   7 bytes into the match (the RIP-relative disp starts at byte 7)
Adj:      0

Steps:
  1. Scan D2R.exe code for  48 03 C7 49 8B 8C C6
  2. At match_addr + 7, read a 4-byte signed i32 displacement
  3. resolved = match_addr + 7 + 4 + displacement
  4. UNIT_TABLE_OFFSET = resolved - module_base
```

This corresponds to the instruction that indexes into the UnitHashTable — it uses `add rax, rdi` then `mov rcx, [r14+rax*8+disp]` to look up a hash bucket.

#### All Known Scan Patterns

See [d2r-memory-offsets.md — Byte Scan Patterns](d2r-memory-offsets.md#byte-scan-patterns) for the complete table of 7 scan patterns covering `unit_table`, `ui_offset`, `expansion`, `hover`, `roster`, `panels`, and `keybindings`.

#### Implementing a Pattern Scanner

```python
# Pseudocode for RIP-relative pattern scanning
import struct

def scan_pattern(code_bytes, base_addr, pattern, pattern_offset, adj):
    """Scan code_bytes for pattern, resolve RIP-relative address."""
    for match_pos in find_all_matches(code_bytes, pattern):
        disp_pos = match_pos + pattern_offset
        disp = struct.unpack_from('<i', code_bytes, disp_pos)[0]  # signed i32
        resolved = base_addr + disp_pos + 4 + disp  # RIP-relative: next_instr + disp
        return resolved + adj - base_addr  # return as offset from module base
    return None
```

**Wildcard bytes** (`??` in patterns like `48 8B 05 ?? ?? ?? ??`) match any value — they represent variable instruction operands that change between builds.

### Method C: IDA Pro / Ghidra Disassembly

1. Open the new `D2R.exe` in IDA Pro or Ghidra
2. Search for references to `128` (hash bucket count) near array indexing patterns
3. Look for code that:
   - Takes a unit ID, computes `id % 128`
   - Indexes into an array of 8-byte pointers
   - The array base address (relative to image base) is `UNIT_TABLE_OFFSET`

### Method D: Memory Scanning

1. Start D2R, create a game with a known character
2. Scan process memory for the character name string
3. Back-reference: find what points to this PlayerData struct
4. The pointer should be at `UnitAny + 0x10`
5. Back-reference again: find what points to this UnitAny
6. The pointer should be in a hash bucket at `moduleBase + UNIT_TABLE_OFFSET + bucket * 8`

### Applying the New Offset

Set the `D2R_UNIT_TABLE_OFFSET` environment variable:
```bash
D2R_UNIT_TABLE_OFFSET=0x1EXXXXX node dist/index.cjs
```

Or update the default in `packages/memory/src/d2.ts`:
```typescript
const UNIT_TABLE_OFFSET = Number(process.env['D2R_UNIT_TABLE_OFFSET'] || 0xNEW_VALUE);
```

---

## Step 2: Verify Struct Field Offsets

If the player is found but data is wrong, struct offsets have likely shifted.

### UnitAny Fields to Verify

| Field | Current Offset | How to Verify |
|---|---|---|
| `type` | `0x00` | Should be 0 for player, 4 for item |
| `txtFileNo` | `0x04` | For player: should be a small number (class ID) |
| `unitId` | `0x08` | Should be a reasonable non-zero value |
| `mode` | `0x0C` | Player modes: 0-17 |
| `pData` | `0x10` | Pointer validity + contains player name at offset 0x00 |
| `actId` | `0x18` | Should be 0-4 |
| `pAct` | `0x20` | Pointer validity |
| `pPath` | `0x38` | Pointer validity + position data |
| `pStats` | `0x88` | Pointer validity + readable stat array |
| `pNext` | `0x150` | Used for hash chain traversal |
| `playerClass` | `0x174` | Should be 0-6 |

### Debugging Method

Use the hex dump functionality to inspect raw memory around a known UnitAny:

```bash
# Add debug logging to dump the raw UnitAny bytes
# Look for patterns: valid pointers are identifiable by their range
# (typically 0x0001XXXX_XXXXXXXX for 64-bit Wine pointers)
```

Key pointer patterns to look for in hex dumps:
- Valid 64-bit pointers under Wine are typically in range `0x000110000` – `0x7FFFFFFF0000`
- Pointers usually start with bytes like `00 00 XX XX XX XX 00 00` in little-endian

### Act/ActMisc Fields to Verify

| Field | Current Offset | How to Verify |
|---|---|---|
| `Act.mapSeed` | `0x1C` | Should be a non-zero u32 (the map seed) |
| `Act.actId` | `0x28` | Must match 0-4 |
| `Act.pActMisc` | `0x70` | Pointer validity → must lead to valid ActMisc |
| `ActMisc.difficulty` | `0x830` | Must be 0, 1, or 2 |
| `ActMisc.initSeedHash` | `0x840` | Non-zero u64 when in game |
| `ActMisc.endSeedHash` | `0x860` | Non-zero u32 when in game |

### Path Fields to Verify

| Field | Current Offset | How to Verify |
|---|---|---|
| `Path.x` | `0x02` | Player X coordinate (should match in-game position) |
| `Path.y` | `0x06` | Player Y coordinate |
| `Path.pRoom` | `0x20` | Pointer validity → must chain to a valid Level |

---

## Step 3: Verify ItemsTxt Scanning

If item names are wrong but the player/map seed works:

1. Check the runtime scan log: `D2R:ItemsScan:Found` and `D2R:ItemsScan:Loaded`
2. If the scan succeeds, check `count` and `stride` values
3. If the scan fails (`D2R:ItemsScan:NotFound`):
   - The item code format in memory may have changed
   - The record stride may be outside the scanned range
   - Extend the stride range in `d2r.items.ts`

### Verifying the Stride

The stride is the number of bytes per ItemsTxt record. To find it manually:

1. Search D2R's memory for `"hax\0"` (the first weapon code)
2. Search nearby for `"axe\0"` (the second weapon code)
3. The distance between them is the stride

Current stride range scanned: `0x200` to `0x400` (step 4).

---

## Step 4: Test the Changes

```bash
# Build
npx tsc -b

# Bundle
cd packages/map && yarn run bundle

# Test with environment variable override
D2R_UNIT_TABLE_OFFSET=0xNEW_VALUE node dist/index.cjs

# Check logs for:
# - "D2R:ModuleBase" — module base found
# - "Player:HashTable:Found" — player found via hash table
# - "MapSeed:Changed" — map seed detected
# - "D2R:ItemsScan:Loaded" — items table found
```

---

## Step 5: Commit and Document

1. Update `UNIT_TABLE_OFFSET` default in `packages/memory/src/d2.ts`
2. Update any struct offsets that changed in `packages/memory/src/struts/`
3. Update the offset tables in `docs/d2r-memory-offsets.md`
4. Note the D2R version in the commit message

---

## Reference: Historical Offset Changes

| Field | Old Value | New Value | Patch Notes |
|---|---|---|---|
| `Act.pActMisc` | `0x78` | `0x70` | Moved when D2R reordered Act struct |
| `ActMisc.difficulty` | `lu16` | `lu32` | Type corrected to match D2R actual layout |
| `ActMisc.endSeedHash` | `0x868` | `0x860` | Shifted when pAct pointer was removed from ActMisc |

---

## Offset Discovery Tips

### Reading /proc/PID/maps

```bash
# Find D2R process
PID=$(pgrep -f D2R.exe)

# Show all memory maps
cat /proc/$PID/maps

# Find D2R.exe module base
grep -i "D2R.exe" /proc/$PID/maps | head -1

# Show only rw regions (writable data = where structs live)
grep "^.*rw" /proc/$PID/maps
```

### Quick Hex Dump from Process Memory

```bash
# Read 256 bytes at a specific offset (requires same-user or root)
dd if=/proc/$PID/mem bs=1 count=256 skip=$((0x140000000 + 0x1EAA3D0)) 2>/dev/null | xxd
```

### Pointer Validation Heuristic

When looking at raw memory, valid D2R pointers typically:
- Are 8 bytes (u64) in little-endian
- Fall in range `0x00110000` – `0x7FFFFFFF0000`
- Often have their upper 2 bytes as `0x0000` (so they look like `XX XX XX XX XX XX 00 00` in LE)
- Null/invalid pointers are `0x0000000000000000`
