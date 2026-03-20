# Patch Scripts

Automated tools for finding and verifying D2R memory offsets after a game
patch.  These scripts read from a **running** D2R process via
`/proc/PID/mem` — they do not modify the game in any way.

> **Why read from memory?**  D2R's `.text` section is DRM-encrypted on disk.
> The byte patterns only exist in decrypted form at runtime, so these scripts
> must attach to a live process.

## Quick Start

```bash
# 1. Start D2R and enter a game

# 2. Scan for all offsets (auto-detects PID)
python3 patch-scripts/scan-offsets.py

# 3. Verify the unit_table offset looks like a real hash table
python3 patch-scripts/verify-offset.py --offset 0x1EAA3D0

# 4. Deep-verify struct layouts by walking pointer chains
python3 patch-scripts/verify-structs.py --offset 0x1EAA3D0
```

## Scripts

### `scan-offsets.py` — Byte Pattern Scanner

The main offset-discovery tool.  Reads the decrypted `.text` section from
process memory and scans for the 7 byte patterns documented in
[d2r-memory-offsets.md](../docs/d2r-memory-offsets.md#byte-scan-patterns).

Uses a compiled C helper (via `gcc` + `ctypes`) for speed — scanning the
full ~22 MB `.text` section takes under a second.

```
Usage:
  ./scan-offsets.py                         # auto-detect PID
  ./scan-offsets.py --pid 12345             # explicit PID
  ./scan-offsets.py -v                      # verbose per-match detail
  ./scan-offsets.py --expected unit_table=0x1EAA3D0,hover=0x1DFE090
```

**How it works:**

1. Locates D2R.exe via `/proc` and reads PE headers to find `.text`
2. Reads the full `.text` section from `/proc/PID/mem` (decrypted at runtime)
3. For each pattern, scans for the byte sequence (with `??` wildcards)
4. Resolves the match to a final offset using one of three modes:
   - **RIP-relative**: `offset = match_rva + pattern_offset + 4 + disp32 + adj`
   - **Direct displacement**: `offset = disp32 + adj` (register holds module base)
   - **Data pattern**: `offset = match_rva + adj` (the match itself is the data)
5. Runs a supplementary scan counting RIP-relative and direct references to
   each resolved target, confirming the values are actually used by code

### `verify-offset.py` — Hash Table Structural Check

Validates that a candidate offset actually points to a unit hash table by
checking the data shape: 6 unit types × 128 buckets of 8-byte pointers,
mostly NULL with a few valid heap addresses.

```
Usage:
  ./verify-offset.py --offset 0x1EAA3D0
  ./verify-offset.py --offset 0x1EAA3D0 0x1EA98A8    # compare candidates
  ./verify-offset.py --offset 0x1EAA3D0 --range 0x1000  # scan nearby
```

Scoring heuristic (out of 8):
- **+3** — >70% of buckets are NULL
- **+2** — non-null count is in a reasonable range
- **+3** — non-null pointers look like heap addresses

### `verify-structs.py` — Deep Struct Verifier

Walks the actual pointer chains starting from the unit hash table to verify
that struct field offsets haven't shifted:

```
Player UnitAny
  → PlayerData.name (should be the character name)
  → Path.x / Path.y (should match in-game position)
  → Act → ActMisc.difficulty (should be 0/1/2)
```

This catches struct layout changes that `verify-offset.py` would miss.

```
Usage:
  ./verify-structs.py --offset 0x1EAA3D0
```

## Typical Workflow After a D2R Patch

```
1.  Start D2R, create or join a game

2.  Run the scanner:
      python3 patch-scripts/scan-offsets.py -v

3.  Check the RESULTS table:
      ✓ = pattern matched and resolved to an offset
      ✗ = pattern not found (may have changed in this build)

4.  Verify unit_table structurally:
      python3 patch-scripts/verify-offset.py --offset <NEW_VALUE>

5.  Deep-verify struct layouts:
      python3 patch-scripts/verify-structs.py --offset <NEW_VALUE>

6.  Apply the new offset:
      export D2R_UNIT_TABLE_OFFSET=0xNEW_VALUE
    or update the default in packages/memory/src/d2.ts

7.  If struct checks fail, see docs/patching-guide.md Step 2 for
    instructions on finding shifted struct field offsets.
```

## Prerequisites

- **Linux** with `/proc` filesystem (native or WSL2)
- **Python 3.8+**
- **gcc** (for compiling the C scanner used by `scan-offsets.py`)
- **D2R running** via Wine, Proton, or natively (the process must be accessible)
- Same user or root permissions (to read `/proc/PID/mem`)
