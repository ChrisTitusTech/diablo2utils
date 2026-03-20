# Patching Guide

How to find and update D2R memory offsets when a game patch breaks this tool. This guide covers every method from start to finish, with enough background that someone new to reverse engineering can follow along.

---

## Table of Contents

- [Overview: What Are We Looking For?](#overview-what-are-we-looking-for)
- [Background Concepts](#background-concepts)
  - [Process Memory on Linux](#process-memory-on-linux)
  - [PE Format (Portable Executable)](#pe-format-portable-executable)
  - [x86-64 Addressing Modes](#x86-64-addressing-modes)
  - [DRM and Why We Must Scan Live Memory](#drm-and-why-we-must-scan-live-memory)
  - [What Is a Hash Table?](#what-is-a-hash-table)
- [Symptoms of Broken Offsets](#symptoms-of-broken-offsets)
- [Method A: Community Tools](#method-a-community-tools)
- [Method B: Byte Pattern Scanning (Automated)](#method-b-byte-pattern-scanning-automated)
- [Method C: Disassembly (IDA Pro / Ghidra)](#method-c-disassembly-ida-pro--ghidra)
- [Method D: Memory Scanning (Name Search → Back-Reference)](#method-d-memory-scanning-name-search--back-reference)
- [Verification Workflow](#verification-workflow)
- [Applying and Testing the New Offset](#applying-and-testing-the-new-offset)
- [Reference](#reference)

---

## Overview: What Are We Looking For?

D2R keeps all game entities (players, monsters, items, objects, missiles) in a global data structure called the **UnitHashTable**. It lives at a fixed offset from the D2R.exe module base address in memory:

```
Module Base (e.g. 0x140000000) + UNIT_TABLE_OFFSET (e.g. 0x1EAA3D0)
                                      ↓
                          ┌──── UnitHashTable ────┐
                          │ Player buckets [128]   │  type 0
                          │ NPC buckets    [128]   │  type 1
                          │ Object buckets [128]   │  type 2
                          │ Missile buckets [128]  │  type 3
                          │ Item buckets   [128]   │  type 4
                          └────────────────────────┘
```

Each bucket is an 8-byte pointer to a linked list of `UnitAny` structs. From any `UnitAny`, we can reach player names, positions, items, the map seed, difficulty — everything we need.

**When D2R patches**, the compiler may rearrange code and data, which shifts `UNIT_TABLE_OFFSET`. Our job is to find the new value. That's what every method in this guide does.

For the full struct layouts (field offsets, sizes, types), see [d2r-memory-offsets.md](d2r-memory-offsets.md). For the pointer chains from the hash table to each piece of game data, see [pointer-chains.md](pointer-chains.md).

---

## Background Concepts

If you're already comfortable with process memory, PE files, and x86-64 assembly, skip to [Symptoms of Broken Offsets](#symptoms-of-broken-offsets).

### Process Memory on Linux

Every running program gets its own virtual address space. On Linux, you can inspect and read any process's memory through the `/proc` filesystem:

| Path | Purpose |
|---|---|
| `/proc/PID/maps` | Lists all memory regions (address ranges, permissions, mapped files) |
| `/proc/PID/mem` | Raw access to the process's virtual memory (requires same-user or root) |
| `/proc/PID/status` | Process name, state, UID, etc. |
| `/proc/PID/cmdline` | Full command line (null-separated) |

**Reading memory** is done with `pread()` — you open `/proc/PID/mem` and read at any virtual address as a file offset:

```bash
# Find the D2R process
PID=$(pgrep -f D2R.exe)

# Read 256 bytes from a specific address
dd if=/proc/$PID/mem bs=1 count=256 skip=$((0x140000000 + 0x1EAA3D0)) 2>/dev/null | xxd
```

**Memory regions** in `/proc/PID/maps` look like this:

```
140000000-1415ca000 r-xp 00000000 /path/to/D2R.exe    ← .text (code)
1415ca000-142800000 rw-p 015ca000 /path/to/D2R.exe    ← .data (globals)
7f8c00000-7f8c40000 rw-p 00000000 [heap]               ← heap allocations
```

The `r-xp` region is executable code (where byte patterns live). The `rw-p` regions are writable data (where structs and hash tables live). When we say "module base", we mean the start address of the first region mapped from D2R.exe — typically `0x140000000`.

### PE Format (Portable Executable)

D2R.exe is a Windows PE64 executable. Even though we run it under Wine/Proton, it keeps the PE format in memory. Key concepts:

**Module Base**: The address where D2R.exe is loaded. Wine usually maps it at `0x140000000` (the default 64-bit PE base). We detect this by finding the region mapped from D2R.exe in `/proc/PID/maps`, or by checking known addresses for the `MZ` DOS header magic bytes (`0x4D 0x5A`).

**RVA (Relative Virtual Address)**: An offset relative to the module base. When we say `UNIT_TABLE_OFFSET = 0x1EAA3D0`, that's an RVA. The absolute address in memory is `module_base + RVA`.

**Sections**: The PE is divided into sections. The important ones:

| Section | Contains | Permissions |
|---|---|---|
| `.text` | Compiled machine code (instructions) | Read + Execute |
| `.data` / `.rdata` | Global variables, constants, read-only data | Read (+ Write for .data) |

When we scan for byte patterns, we're searching through the decrypted `.text` section. When we read struct data (the hash table, unit structs, etc.), we're reading from writable data regions.

### x86-64 Addressing Modes

Understanding three addressing modes is essential for pattern scanning. Each mode determines how the CPU references a memory location, and therefore how we extract an offset from a matched instruction sequence.

#### RIP-Relative Addressing

The most common mode in x86-64 code. The address is computed relative to the instruction pointer (RIP = address of the _next_ instruction):

```asm
mov rax, [rip + 0x1234]      ; encoded as:  48 8B 05  34 12 00 00
;                                            ↑opcode   ↑displacement (i32, little-endian)
```

The CPU computes: `target = RIP + displacement = (address_of_next_instruction) + disp32`.

From a pattern scanner's perspective, if we find this instruction at file offset `match_offset` within the `.text` section:
- The displacement starts at `match_offset + 3` (after the 3-byte opcode)
- The next instruction is at `match_offset + 3 + 4` (opcode + displacement)
- The target RVA is: `match_rva + pattern_offset + 4 + disp32`

Where `pattern_offset` is the byte index within the matched pattern where the displacement begins, and `match_rva` is the RVA of the start of the pattern match.

#### Direct Displacement (Register + Offset)

Used when a register already holds a base address (like the module base):

```asm
mov rcx, [r14 + rax*8 + 0x1EAA3D0]   ; the displacement IS the offset we want
```

Here `r14` holds the module base, `rax*8` is a scaled index, and the displacement `0x1EAA3D0` is literally `UNIT_TABLE_OFFSET`. No arithmetic needed — the 4-byte displacement extracted from the instruction IS the answer.

#### Data Pattern

Instead of matching an instruction, we match raw data in the code section. The location of the match itself (its RVA) gives us the answer, possibly with a fixed adjustment.

### DRM and Why We Must Scan Live Memory

D2R's `.text` section is **DRM-encrypted on disk**. If you open `D2R.exe` directly, the code bytes are scrambled — none of our byte patterns will match.

The DRM decrypts the code into memory at launch time. So we must scan from the **running process** (via `/proc/PID/mem`), not from the file on disk. This is why all our scripts require D2R to be running.

### What Is a Hash Table?

D2R's UnitHashTable is a simple fixed-size hash table:

1. There are 5 unit types, each with **128 buckets** (slots).
2. Each bucket holds a pointer (8 bytes) to the first unit in a linked list.
3. To find a unit with ID `N`, compute `bucket = N % 128`, then walk the linked list in that bucket.

```
Bucket 0:  [ptr] → UnitAny → UnitAny → NULL
Bucket 1:  [NULL]                              (empty)
Bucket 2:  [ptr] → UnitAny → NULL
...
Bucket 127: [ptr] → UnitAny → UnitAny → UnitAny → NULL
```

A valid hash table has a characteristic "shape": most buckets are NULL (empty), and the non-null ones contain valid heap pointers. This shape is what `verify-offset.py` checks.

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

The most common breakage is `UNIT_TABLE_OFFSET` changing. Start there.

---

## Method A: Community Tools

**Difficulty**: Easy | **Speed**: Immediate (if someone else has already updated) | **When to use**: First thing to try after a patch.

### What This Method Does

Other open-source D2R tools maintain their own offset databases. If they've already updated for the new patch, you can copy their value.

### Step by Step

1. **Check PrimeMH** — a Rust-based D2R memory tool. Look in their source code for a value called `unit_table` or `UNIT_TABLE`. Their `find_offsets` function contains byte patterns with expected results.

2. **Check d2r-mapview** — another open-source map tool. Search for `UnitHashTable`, `UnitTable`, or `pUnitTable`.

3. **Check MapAssist** (.NET) — a popular tool with frequently updated offsets. Look for similar labels in their offset configuration.

4. **Apply the value**: The offset is relative to D2R.exe's module base. For example, if PrimeMH lists `unit_table = 0x1EAA3D0`, that means `module_base + 0x1EAA3D0` is where the hash table begins.

### Limitations

- You're dependent on someone else updating first.
- You can't verify that their offset is correct for your exact D2R version without also running a verification step (see [Verification Workflow](#verification-workflow)).

---

## Method B: Byte Pattern Scanning (Automated)

**Difficulty**: Easy to run, moderate to understand | **Speed**: Seconds | **When to use**: Recommended default method.

This is the primary method. The `patch-scripts/` directory contains ready-to-run Python scripts that automate the entire process.

### What This Method Does

When the D2R compiler generates code that accesses the UnitHashTable, it produces specific sequences of machine instructions. These instruction sequences are mostly stable across patches — only the displacement (the offset value embedded in the instruction) changes. We search for the stable instruction bytes and read the new displacement from the match.

### Prerequisites

- Linux with `/proc` filesystem
- Python 3.8+
- `gcc` (for compiling the C scanner helper)
- D2R running (via Wine, Proton, or native) and **in a game** (not at the menu)
- Same user or root permissions (to read `/proc/PID/mem`)

### Step-by-Step Walkthrough

#### Step 1: Start D2R and Enter a Game

The UnitHashTable is only populated when you're in a game. Launch D2R, create or join a game with any character. The character must be fully loaded (you should see your character on screen).

#### Step 2: Run the Pattern Scanner

```bash
python3 patch-scripts/scan-offsets.py
```

This does the following automatically:

1. **Finds the D2R process** — scans `/proc/` for a process matching `D2R.exe`. Uses a scoring system to pick the right one when Wine/Proton creates multiple processes (the actual game process scores highest).

2. **Locates the module base** — parses `/proc/PID/maps` for the region mapped from `D2R.exe` and reads the first 2 bytes to verify the `MZ` PE header.

3. **Reads the PE headers** — parses the PE optional header to find the `.text` section: its virtual address (RVA), virtual size, and file offset.

4. **Reads the decrypted .text section** — reads the full `.text` section (~22 MB) from `/proc/PID/mem`. This is the DRM-decrypted code.

5. **Compiles and loads a C scanner** — for speed, the script writes a small C function, compiles it with `gcc`, and loads it via Python's `ctypes`. The C function performs the byte-level search.

6. **Scans for all 7 patterns** — for each known byte pattern, finds all matches in the `.text` section.

7. **Resolves offsets** — for each match, reads the 4-byte displacement and applies the addressing mode formula to produce a final RVA.

8. **Cross-references results** — runs a supplementary scan counting how many other instructions reference each resolved address, as a confidence check.

The output looks like:

```
╔═══════════════╦══════════════╦═══════╦═════════════════════╗
║ Name          ║ Offset       ║ Refs  ║ Status              ║
╠═══════════════╬══════════════╬═══════╬═════════════════════╣
║ unit_table    ║ 0x01EAA3D0   ║ 12    ║ ✓                   ║
║ ui_offset     ║ 0x01EBA0D6   ║ 8     ║ ✓                   ║
║ hover         ║ 0x01DFE090   ║ 5     ║ ✓                   ║
║ panels        ║ 0x01E14E38   ║ 3     ║ ✓                   ║
║ expansion     ║ 0x01DFD4E0   ║ 4     ║ ✓                   ║
╚═══════════════╩══════════════╩═══════╩═════════════════════╝
```

For verbose per-match detail, use `-v`:

```bash
python3 patch-scripts/scan-offsets.py -v
```

#### Step 3: Verify the Offset

Take the `unit_table` value from the scanner output and verify it:

```bash
# Structural check — does this look like a hash table?
python3 patch-scripts/verify-offset.py --offset 0x1EAA3D0

# Deep struct walk — can we read player name, position, difficulty?
python3 patch-scripts/verify-structs.py --offset 0x1EAA3D0
```

See the [Verification Workflow](#verification-workflow) section for how to interpret the results.

### How Pattern Scanning Works (In Depth)

This section explains the internals. You don't need to understand this to use the scripts, but it's essential if you need to update or add patterns.

#### The Core Idea

Consider this x86-64 instruction that accesses the UnitHashTable:

```asm
; "Given a unit ID in rax, look up its hash bucket"
add  rax, rdi              ; 48 03 C7
mov  rcx, [r14+rax*8+disp] ; 49 8B 8C C6 [D0 A3 EA 01]
;                                         ↑ displacement = 0x01EAA3D0
```

The bytes `48 03 C7 49 8B 8C C6` are the instruction opcodes — they don't change between patches because the compiler generates the same instruction sequence. The last 4 bytes (`D0 A3 EA 01`) are the displacement — this is `UNIT_TABLE_OFFSET` in little-endian and it **does** change with each patch.

The scanner:
1. Finds `48 03 C7 49 8B 8C C6` in memory
2. Reads the next 4 bytes as a little-endian signed 32-bit integer
3. That integer is the new `UNIT_TABLE_OFFSET`

#### The Three Addressing Modes

Different instructions encode addresses differently. Each pattern uses one of three modes:

**RIP-Relative** (`rip_relative`): The displacement is relative to the _next_ instruction. Used by most patterns (`ui_offset`, `panels`, `roster`, `expansion`).

```
Formula: final_rva = match_rva + pattern_offset + 4 + disp32 + adj

Example (ui_offset pattern):
  Pattern found at .text offset 0x5A3B10 → match_rva = 0x5A4B10 (.text VA offset = 0x1000)
  pattern_offset = 6, adj = +10
  disp32 read at match+6 = 0x01915B96
  final_rva = 0x5A4B10 + 6 + 4 + 0x01915B96 + 10 = 0x1EBA0D6
```

**Direct Displacement** (`direct`): A register holds the module base, and the displacement IS the offset. Used by `unit_table` and `hover`.

```
Formula: final_rva = disp32 + adj

Example (unit_table pattern):
  disp32 read at match+7 = 0x01EAA3D0
  adj = 0
  final_rva = 0x01EAA3D0
```

**Data Pattern** (`data`): The match location itself is meaningful — no displacement to read. Used by `keybindings`.

```
Formula: final_rva = match_rva + adj
```

#### Wildcard Bytes

Some patterns contain `??` which matches any byte. For example:

```
48 8B 05 ?? ?? ?? ??
```

This means: match `48 8B 05` followed by any 4 bytes. The `??` bytes are the displacement we want to read — they'll be different in each build, which is exactly why we treat them as wildcards during the search and then read their actual values after finding the match.

#### Resolution Code

The core logic for each mode in Python:

```python
import struct

def resolve_match(match_rva, code_bytes, match_offset, pattern_offset, adj, mode):
    """
    match_rva:       RVA of the start of the match (match_offset + section_va)
    code_bytes:      the raw .text section buffer
    match_offset:    byte offset within code_bytes where the pattern matched
    pattern_offset:  which byte in the pattern holds the displacement
    adj:             fixed adjustment added to the result
    mode:            'rip_relative', 'direct', or 'data'
    """
    disp = struct.unpack_from('<i', code_bytes, match_offset + pattern_offset)[0]
    if mode == 'rip_relative':
        return match_rva + pattern_offset + 4 + disp + adj
    elif mode == 'direct':
        return disp + adj
    elif mode == 'data':
        return match_rva + adj
```

#### All 7 Known Patterns

See [d2r-memory-offsets.md — Byte Scan Patterns](d2r-memory-offsets.md#byte-scan-patterns) for the complete table with byte sequences, offsets, adjustments, and modes.

For the full working scanner implementation, see [`patch-scripts/scan-offsets.py`](../patch-scripts/scan-offsets.py).

---

## Method C: Disassembly (IDA Pro / Ghidra)

**Difficulty**: Hard (requires reverse engineering experience) | **Speed**: Minutes to hours | **When to use**: When byte patterns stop matching after a major refactor.

### What This Method Does

Open the D2R executable in a disassembler, find the code that accesses the UnitHashTable by recognizing its algorithmic patterns (modulo 128, array indexing), and read the offset directly from the disassembly.

### Prerequisites

- IDA Pro or Ghidra (free) installed
- A **memory dump** of the running D2R process (because the on-disk binary is DRM-encrypted)

### Step 1: Dump Decrypted Memory

Since D2R's code is encrypted on disk, you need to dump the decrypted `.text` section from a running process first:

```bash
PID=$(pgrep -f D2R.exe)

# Find the .text section bounds from PE headers, or use the region from /proc/PID/maps:
# Look for the r-xp region mapped from D2R.exe
grep -i "D2R.exe" /proc/$PID/maps | head -1
# Example output: 140000000-15615ca00 r-xp 00000000 ... D2R.exe

# Dump the code section (adjust addresses from your maps output):
TEXT_START=0x140001000   # .text usually starts at RVA 0x1000
TEXT_SIZE=$((0x15C98C0))  # size from PE header, or estimate from maps

dd if=/proc/$PID/mem bs=1 count=$TEXT_SIZE skip=$((TEXT_START)) 2>/dev/null > /tmp/d2r_text.bin
```

### Step 2: Load into Disassembler

1. Open the dump in IDA Pro or Ghidra.
2. Set the base address to match the original mapping (e.g., `0x140001000` for the `.text` section).
3. Let the disassembler auto-analyze the code.

### Step 3: Find the Hash Table Access Pattern

Search for code that implements the hash table lookup algorithm:

```
bucket_index = unit_id % 128;
unit_ptr = hash_table[unit_type * 128 + bucket_index];
```

**What to look for in assembly:**

1. **The modulo operation**: `AND reg, 0x7F` (since 128 is a power of 2, `% 128` compiles to `& 0x7F`).

2. **The array indexing**: A multiply or shift by 8 (pointer size), then an add with a large displacement. The displacement is `UNIT_TABLE_OFFSET`.

3. **The constant 128 (0x80)**: Search for immediate values of `0x80` or `0x7F` near array indexing patterns.

**Example disassembly pattern:**

```asm
and  eax, 7Fh            ; bucket = unitId % 128
add  rax, rdi             ; add unit_type * 128
mov  rcx, [r14+rax*8+1EAA3D0h]  ; load bucket pointer
                          ;       ↑ this is UNIT_TABLE_OFFSET
```

### Step 4: Extract the Offset

Once you find the instruction, read the displacement operand. The disassembler will show it as a hex value in the instruction. That value is the new `UNIT_TABLE_OFFSET`.

### Tips

- Search for cross-references to the old offset value — even if the offset shifted, the code structure around it is usually the same.
- Look for functions that take `unit_type` and `unit_id` as parameters.
- The hash table access function is called frequently — it will have many cross-references.

---

## Method D: Memory Scanning (Name Search → Back-Reference)

**Difficulty**: Moderate | **Speed**: Minutes | **When to use**: When you can find the player but need to locate the hash table that points to them.

### What This Method Does

Instead of finding the hash table first, this method works backwards: find the player's name in memory, then follow pointers back to discover which hash table bucket points to the player's `UnitAny` struct.

### Prerequisites

- D2R running and in a game
- You know your character's name
- A hex editor with memory search capability, or the command line tools below

### Step 1: Find the Player Name in Memory

Search all writable memory regions for your character's name as a null-terminated string:

```bash
PID=$(pgrep -f D2R.exe)

# Method 1: Use grep on process memory (finds offsets of matches)
grep -boa "YourCharName" /proc/$PID/mem 2>/dev/null

# Method 2: Scan rw regions from maps
# Parse /proc/$PID/maps for rw-p regions and search each one
```

You'll likely get multiple matches. The correct one is inside a `PlayerData` struct, which starts with the player name at offset `0x00` and has 6 valid quest/waypoint pointers at offsets `0x40`–`0x68`.

### Step 2: Validate the PlayerData Struct

For each name match, check the surrounding bytes:

```bash
# Read 112 bytes starting from the name match (covers name + quest/wp pointers)
MATCH_ADDR=0x????????  # address where name was found
dd if=/proc/$PID/mem bs=1 count=112 skip=$((MATCH_ADDR)) 2>/dev/null | xxd
```

Look at offsets `0x40` through `0x68` — these should be six 8-byte pointers, all in the valid range (`0x00110000` – `0x7FFFFFFF0000`). If they look like valid pointers, this is a genuine `PlayerData` struct.

### Step 3: Find the UnitAny That Points Here

The `PlayerData` address appears as a pointer at `UnitAny + 0x10` (`pData` field). Search memory for an 8-byte little-endian representation of the `PlayerData` address:

```bash
# Convert the PlayerData address to little-endian bytes
# Example: 0x00007F8C12345678 → 78 56 34 12 8C 7F 00 00
# Search for these 8 bytes in memory to find UnitAny.pData
```

When you find a match, check if it looks like a `UnitAny` struct:
- Offset `-0x10` from the match (= `UnitAny + 0x00`): should be `type = 0` (Player) as a u32
- Offset `-0x0C` (= `UnitAny + 0x04`): small number (class ID, 0-6)
- Offset `-0x08` (= `UnitAny + 0x08`): non-zero unit ID

### Step 4: Find the Hash Table Bucket

The `UnitAny` address appears in the Player portion of the hash table. The bucket index is `unitId % 128`. The bucket address is:

```
bucket_addr = module_base + UNIT_TABLE_OFFSET + (unitId % 128) * 8
```

Search the hash table region for the `UnitAny` address. Since we know the module base (from `/proc/PID/maps`) and the unit type is 0 (Player), the hash table is in the first 1024 bytes (128 × 8) after `module_base + UNIT_TABLE_OFFSET`:

```bash
# Read the first 1024 bytes of candidate hash table locations
# and search for the UnitAny pointer value
MODULE_BASE=0x140000000
UNIT_ANY_ADDR=0x????????

# Try scanning a range of candidate offsets
for OFFSET in $(seq $((0x1EA0000)) 4096 $((0x1EB0000))); do
    ADDR=$((MODULE_BASE + OFFSET))
    BUCKET_DATA=$(dd if=/proc/$PID/mem bs=1 count=1024 skip=$ADDR 2>/dev/null | xxd -p)
    # Check if UNIT_ANY_ADDR appears in this data
done
```

When you find the bucket containing your `UnitAny` pointer, compute: `UNIT_TABLE_OFFSET = bucket_addr - module_base - (unitId % 128) * 8`

### Implementation Note

This method is implemented in the codebase as `scanForPlayer()` Strategy 3 (see `packages/memory/src/d2.ts`). The code scans for the player name, validates the `PlayerData` struct, then searches for pointer back-references to locate the `UnitAny`. However, the code doesn't need to find the hash table because it uses the known `UNIT_TABLE_OFFSET` — this manual back-reference approach is for when you need to _discover_ that offset.

---

## Verification Workflow

After finding a candidate offset using any method above, verify it with these two scripts.

### Step 1: Structural Verification

```bash
python3 patch-scripts/verify-offset.py --offset 0x<CANDIDATE>
```

This reads the candidate offset from process memory and scores it on a scale of 0-8:

| Points | Check |
|---|---|
| +3 | >70% of buckets are NULL (sparse, as expected for a hash table) |
| +2 | Non-null pointer count is in a reasonable range (not too many, not zero) |
| +3 | Non-null pointers look like valid heap addresses (within expected range) |

**Score 7-8**: Almost certainly correct. **Score 4-6**: Possibly correct but suspicious. **Score 0-3**: Wrong offset.

You can also compare multiple candidates or scan a range:

```bash
# Compare two candidates side by side
python3 patch-scripts/verify-offset.py --offset 0x1EAA3D0 0x1EA98A8

# Scan a range around a candidate (check every 16 bytes within ±0x1000)
python3 patch-scripts/verify-offset.py --offset 0x1EAA3D0 --range 0x1000
```

### Step 2: Deep Struct Verification

```bash
python3 patch-scripts/verify-structs.py --offset 0x<CANDIDATE>
```

This walks the actual pointer chains starting from the hash table:

```
Player UnitAny
  → PlayerData.name (reads your character's name)
  → Path.x / Path.y (reads position coordinates)
  → Act → ActMisc.difficulty (reads difficulty: 0/1/2)
```

If it prints your character's name and a valid difficulty, the offset is correct AND all the struct field offsets are still valid.

**If struct verification fails** (offset found but data is garbage), the struct layouts have shifted — see [Verifying Struct Field Offsets](#verifying-struct-field-offsets) below.

### Verifying Struct Field Offsets

If the hash table offset is correct but struct data is wrong, individual field offsets within structs have shifted. Hex-dump a known `UnitAny` and look for recognizable patterns:

```bash
PID=$(pgrep -f D2R.exe)
MODULE_BASE=0x140000000

# First, find a valid UnitAny pointer from a non-null bucket
HASH_TABLE=$((MODULE_BASE + 0x1EAA3D0))
dd if=/proc/$PID/mem bs=1 count=1024 skip=$HASH_TABLE 2>/dev/null | xxd | head -20

# Then dump the UnitAny struct (first 384 bytes)
UNIT_PTR=0x????????   # from the bucket pointer above
dd if=/proc/$PID/mem bs=1 count=384 skip=$((UNIT_PTR)) 2>/dev/null | xxd
```

**What to look for in the hex dump:**

| Expected Pattern | What It Means |
|---|---|
| `00 00 00 00` at the start | `type = 0` (Player) |
| A small number (0-6) at offset +4 | `txtFileNo` (class ID) |
| A non-zero u32 at offset +8 | `unitId` |
| An 8-byte valid pointer at offset +0x10 | `pData` → PlayerData |
| Valid pointers have upper bytes ~`00 00` | Appears as `XX XX XX XX XX XX 00 00` in LE |

For full field offset tables, see:
- [UnitAny fields](d2r-memory-offsets.md#unitany-d2runitstrut)
- [Act/ActMisc fields](d2r-memory-offsets.md#act-d2ractstrut)
- [Path fields](d2r-memory-offsets.md#path-d2rpathstrut)

### Verifying ItemsTxt Scanning

If item names are wrong but player/map seed works, the ItemsTxt stride may have changed:

1. Check the runtime log for `D2R:ItemsScan:Found` and `D2R:ItemsScan:Loaded`
2. If the scan fails, find the stride manually:
   - Search D2R's memory for `"hax\0"` (Hand Axe — always the first weapon)
   - Search nearby for `"axe\0"` (Axe — always the second weapon)
   - The distance between them is the stride
3. Current scanned stride range: `0x200` to `0x400` (step 4)
4. If the stride is outside this range, extend it in `packages/memory/src/d2r.items.ts`

For full details on the ItemsTxt scan algorithm, see [algorithms.md — ItemsTxt Memory Scan](algorithms.md#itemstxt-memory-scan).

---

## Applying and Testing the New Offset

### Quick Test with Environment Variable

```bash
D2R_UNIT_TABLE_OFFSET=0xNEW_VALUE node dist/index.cjs
```

### Check Logs For

| Log Message | Meaning |
|---|---|
| `D2R:ModuleBase` | Module base address found |
| `Player:HashTable:Found` | Player found via hash table scan |
| `MapSeed:Changed` | Map seed detected |
| `D2R:ItemsScan:Loaded` | Items table found and loaded |

### Full Build and Test

```bash
# Build
npx tsc -b

# Bundle
cd packages/map && yarn run bundle

# Test
D2R_UNIT_TABLE_OFFSET=0xNEW_VALUE node dist/index.cjs
```

### Commit and Document

1. Update `UNIT_TABLE_OFFSET` default in `packages/memory/src/d2.ts`
2. Update any struct offsets that changed in `packages/memory/src/struts/`
3. Update the offset tables in `docs/d2r-memory-offsets.md`
4. Note the D2R version in the commit message

---

## Reference

### Historical Offset Changes

| Field | Old Value | New Value | Patch Notes |
|---|---|---|---|
| `Act.pActMisc` | `0x78` | `0x70` | Moved when D2R reordered Act struct |
| `ActMisc.difficulty` | `lu16` | `lu32` | Type corrected to match D2R actual layout |
| `ActMisc.endSeedHash` | `0x868` | `0x860` | Shifted when pAct pointer was removed from ActMisc |

### Quick Reference: Reading Process Memory

```bash
# Find D2R process
PID=$(pgrep -f D2R.exe)

# Show all memory maps
cat /proc/$PID/maps

# Find D2R.exe module base
grep -i "D2R.exe" /proc/$PID/maps | head -1

# Show only rw regions (where game data structs live)
grep "^.*rw" /proc/$PID/maps

# Hex dump 256 bytes at a specific address
dd if=/proc/$PID/mem bs=1 count=256 skip=$((0x140000000 + 0x1EAA3D0)) 2>/dev/null | xxd
```

### Pointer Validation Heuristic

When examining raw memory, valid D2R pointers typically:
- Are 8 bytes (u64) in little-endian
- Fall in range `0x00110000` – `0x7FFFFFFF0000`
- Upper 2 bytes are often `0x0000` (appear as `XX XX XX XX XX XX 00 00` in LE)
- `0x0000000000000000` = null/invalid
