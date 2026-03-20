# Algorithms

This document explains the key algorithms used to extract and transform game data from D2R's process memory. Where the [Pointer Chains](pointer-chains.md) document shows _where_ to read data, this document explains _how_ that data is interpreted and processed.

Each algorithm is presented with its mathematical foundation, step-by-step logic, and the corresponding TypeScript implementation.

---

## Table of Contents

- [Map Seed Derivation](#map-seed-derivation)
- [ItemsTxt Memory Scan](#itemstxt-memory-scan)
- [Process Discovery](#process-discovery)
- [Module Base Detection](#module-base-detection)
- [Player Re-acquisition Loop](#player-re-acquisition-loop)

---

## Map Seed Derivation

**Source**: `packages/memory/src/session.ts` → `deriveMapSeed()`, `resolveMapSeed()`

D2R doesn't store the game's map seed directly in an easily accessible field. Instead, it stores two values derived from the seed using a Linear Congruential Generator (LCG). We reverse the LCG to recover the original seed.

### Background: What Is an LCG?

A Linear Congruential Generator is a simple pseudorandom number formula:

$$\text{next} = (a \times \text{current} + c) \mod m$$

Where $a$ is the multiplier, $c$ is the increment, and $m$ is the modulus. Crucially, this is reversible if you know $a$'s modular multiplicative inverse — a value $a^{-1}$ such that $a \times a^{-1} \equiv 1 \pmod{m}$.

### The LCG Relationship

D2R computes:
```
endSeedHash = (recoveredSeed * SEED_MAGIC + SEED_OFFSET) mod 2³²
```

Where:
- `recoveredSeed = initSeedHash32 XOR gameSeed`
- `initSeedHash32 = initSeedHash & 0xFFFFFFFF` (lower 32 bits of the u64)
- `SEED_MAGIC = 0x6AC690C5`
- `SEED_OFFSET = 666`

### Recovery Algorithm

To recover `gameSeed` from the stored values:

```
Given:
  initSeedHash  (u64, from ActMisc @ 0x840)
  endSeedHash   (u32, from ActMisc @ 0x860)

Step 1: Truncate initSeedHash to 32 bits
  initSeedHash32 = initSeedHash & 0xFFFFFFFF

Step 2: Reverse the LCG to recover recoveredSeed
  recoveredSeed = ((endSeedHash - 666) * 0x8A3E6E0D) & 0xFFFFFFFF

  where 0x8A3E6E0D is the modular multiplicative inverse of
  0x6AC690C5 mod 2³²  (i.e., 0x6AC690C5 * 0x8A3E6E0D ≡ 1 mod 2³²)

Step 3: XOR to get the game seed
  gameSeed = (initSeedHash32 XOR recoveredSeed) >>> 0

Step 4: Verify (round-trip check)
  verifiedSeed = initSeedHash32 XOR gameSeed
  verifiedEndSeed = (verifiedSeed * 0x6AC690C5 + 666) & 0xFFFFFFFF

  If verifiedEndSeed != endSeedHash, the derivation failed → return null
```

### TypeScript Implementation

```typescript
const SEED_MAGIC         = 0x6AC690C5n;
const SEED_MAGIC_INVERSE = 0x8A3E6E0Dn;
const SEED_OFFSET        = 666n;
const UINT32_MASK        = 0xFFFF_FFFFn;

function deriveMapSeed(initSeedHash: bigint, endSeedHash: number): number | null {
  if (endSeedHash === 0) return null;

  const initSeedHash32 = Number(initSeedHash & UINT32_MASK) >>> 0;
  const recoveredSeed = Number(
    (normalize(BigInt(endSeedHash) - SEED_OFFSET) * SEED_MAGIC_INVERSE) & UINT32_MASK
  );
  const gameSeed = (initSeedHash32 ^ recoveredSeed) >>> 0;

  // Verify round-trip
  const verified = (initSeedHash32 ^ gameSeed) >>> 0;
  const check = (Math.imul(verified, Number(SEED_MAGIC)) + Number(SEED_OFFSET)) >>> 0;
  if (check !== (endSeedHash >>> 0)) return null;

  return gameSeed;
}
```

### Fallback

If `deriveMapSeed()` returns null (e.g., `endSeedHash == 0`), fall back to `Act.mapSeed` at offset `0x1C`.

---

## ItemsTxt Memory Scan

**Source**: `packages/memory/src/d2r.items.ts` → `scanD2RItemsTable()`

D2R loads WeaponsTxt, ArmorTxt, and MiscTxt into a single contiguous array in memory. The tool scans for this array to build a correct `txtFileNo → item code` mapping, because D2R's indices differ from the classic 1.13c MPQ data.

### Why This Is Needed

D2R patches (starting with Ladder Season 1) added new items:
- Sunder Charms (6 items)
- Mosaic runeword base items

These additions shift `txtFileNo` values for all subsequent items. The classic MPQ files in `assets/d2/` don't include these, so a Greater Mana Potion (`txtFileNo` 587 in D2R) would incorrectly map to Eld Rune in the MPQ data.

### Scan Algorithm

```
1. Iterate all rw memory regions via /proc/PID/maps
   - Skip regions smaller than 200KB (table is ~400KB+)

2. Search each region for the needle: "hax\0" (4 bytes)
   - "hax" is the code for Hand Axe — always the FIRST weapon in every D2/D2R version

3. For each "hax\0" hit, try candidate record strides:
   - Primary range:  0x280..0x320 (step 4)
   - Extended range: 0x200..0x27C and 0x324..0x400 (step 4)

4. At each candidate stride, check if (hit_offset + stride) contains "axe\0"
   - "axe" is the code for Axe — always the SECOND weapon

5. If "axe\0" matches, verify items 3 and 4:
   - Item 3 at (hit_offset + stride*2) should be "2ax" (Double Axe)
   - Item 4 at (hit_offset + stride*3) should be "mpi" (Military Pick)

6. If all 4 match: table found. Read up to 1200 item codes at stride intervals.
   - Read 4 bytes at each stride offset
   - Stop at null/empty code (end of table)
   - For each code, look up Diablo2Mpq.items.byCode to get nameId

7. Return D2RItemTable: { byIndex: Map<txtFileNo, Diablo2Item>, count, stride, baseAddress }
```

### Record Layout

Each ItemsTxt record starts with the 4-byte item code:

```
┌─────────────────────────────────────────────────┐
│ Offset 0x00: Item code ("hax\0", "axe\0", ...) │  4 bytes
│ Offset 0x04..stride: Other item properties      │  (stride - 4) bytes
│ ...next record at offset stride...              │
└─────────────────────────────────────────────────┘
```

The stride varies by D2R version (typically 0x298–0x2E0, or 664–736 bytes).

### Error Handling

- If the scan finds no table, `d2rItems` stays null and the classic MPQ fallback is used.
- The scan should be called once after the process is found and MPQ data is loaded.
- Multiple calls are harmless (just re-scans).

---

## Process Discovery

**Source**: `packages/memory/src/process.ts` → `Process.findPidByName()`

Before we can read any memory, we need to find D2R's process ID (PID). Under Wine/Proton, a single game launch creates multiple processes (the Wine server, launcher wrappers, gamescope compositor, etc.). The scoring system below picks the right one.

For background on process memory layout, see [patching-guide.md — Process Memory on Linux](patching-guide.md#process-memory-on-linux).

### PID Discovery

```
1. Enumerate /proc/ directory entries
2. For each numeric entry (potential PID):
   a. Read /proc/PID/status → extract process name from first line
   b. Fast check: if status name contains "D2R.exe" → return PID
   c. Read /proc/PID/cmdline → split on \0
   d. If cmdline contains "D2R.exe" → add to candidates with score

3. Score candidates (higher = better):
   +100  argv[0] basename matches "D2R.exe" (case-insensitive)
    +50  status name is "Main" (Wine child process)
    +25  argv[0] matches Z:\...\D2R.exe (Wine path format)
    +10  cmdline contains "Diablo II Resurrected"
    -25  cmdline contains "proton waitforexitandrun" (launcher wrapper)
    -50  cmdline contains "gamescope" (compositor wrapper)

4. Return highest-scoring PID
```

### Memory Reading

Reading is done via `/proc/PID/mem` with `pread()`:

```typescript
const fh = await fs.open(`/proc/${pid}/mem`, 'r');
const buf = Buffer.alloc(count);
await fh.read(buf, 0, count, offset);
```

### Memory Map Loading

```
1. Read /proc/PID/maps
2. Parse each line: start-end permissions offset ... path
3. Filter:
   - Keep only "rw" (readable + writable) regions
   - Exclude /dev/nvidia* (GPU memory)
4. Cache for 10 seconds (MemoizeExpiring decorator)
```

---

## Module Base Detection

**Source**: `packages/memory/src/d2.ts` → `getD2RBase()`

Once we have the PID, we need the module base address — the virtual address where D2R.exe is loaded in memory. All offsets (like `UNIT_TABLE_OFFSET`) are relative to this base. Wine typically maps PE executables at `0x140000000` (the default 64-bit PE base address), but this isn't guaranteed.

For background on PE format and module bases, see [patching-guide.md — PE Format](patching-guide.md#pe-format-portable-executable).

Three strategies are tried, from most specific to most generic:

### Strategy 1: Named Module Search

```
Read /proc/PID/maps
Search for any line containing "D2R.exe" (case-insensitive)
  → If found, take the lowest start address from that line
If not found, try searching for "d2r" (lowercase)
```

### Strategy 2: .exe Module at Offset 0

```
Read /proc/PID/maps
Search for any line where:
  - File offset is 0 (or 00000000)
  - Path ends with ".exe"
  → Take the start address
```

### Strategy 3: Default PE Base Check

```
Try reading 4 bytes at 0x140000000 (default 64-bit PE base)
  → Check for MZ magic bytes (0x4D, 0x5A)
  → If found, this is the module base

If not, try 0x400000 (32-bit fallback)
  → Same MZ check
```

### Caching

The module base is cached after first detection. It is cleared when:
- `markPlayerLost()` is called (player connection lost)
- The cached base explicitly returns invalid data

This allows re-detection if the game process was restarted.

---

## Player Re-acquisition Loop

**Source**: `packages/memory/src/session.ts` → `waitForPlayer()`

When the player quits a game and creates/joins a new one, the old `UnitAny` pointer becomes invalid. The re-acquisition loop detects this and polls for the new player, using an exponential backoff to avoid hammering the process with reads.

```
1. Validate current player pointer (if cached)
   - Read UnitAny at cached offset
   - Check all pointers are valid
   - If valid → return immediately

2. Enter polling loop with backoff:
   - Wait: min(backOff * 500ms, 5000ms)
   - Attempt hash table scan (fast, skipSlowScan=true)
   - If found → return player
   - Increment backoff counter
   - Repeat

3. On player loss:
   - Clear all state (position, map seed, items, kills, units)
   - Reset cached memory offsets
   - Reset module base cache
   - Fire state dirty event (updates UI)
```

The key insight is that `skipSlowScan=true` prevents the expensive full-memory scan during re-acquisition. The hash table scan is fast (milliseconds) and will find the player once D2R has populated the unit table in a new game.
