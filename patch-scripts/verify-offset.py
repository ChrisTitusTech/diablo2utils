#!/usr/bin/env python3
"""
D2R Unit Hash Table Offset Verifier
====================================

Validates a candidate UNIT_TABLE_OFFSET by reading process memory at
module_base + offset and checking whether it looks like a plausible
unit hash table (6 unit-types × 128 buckets of 8-byte pointers).

A valid hash table has mostly-NULL buckets with a few heap-like
pointers sprinkled in — this is a strong structural fingerprint.

Usage
-----
  # Verify the documented offset:
  ./verify-offset.py --pid 12345 --offset 0x1EAA3D0

  # Auto-detect PID, scan a range around the offset:
  ./verify-offset.py --offset 0x1EAA3D0 --range 0x1000

  # Try multiple candidates:
  ./verify-offset.py --offset 0x1EAA3D0 0x1EA98A8 0x1D52DA0
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

HASH_BUCKET_COUNT = 128
PTR_SIZE = 8
UNIT_TYPES = ["Player", "NPC", "Object", "Missile", "Item", "Tile"]


def find_d2r_pid() -> int:
    for pid_dir in Path("/proc").iterdir():
        if not pid_dir.name.isdigit():
            continue
        try:
            if b"D2R.exe" in (pid_dir / "cmdline").read_bytes():
                return int(pid_dir.name)
        except (PermissionError, FileNotFoundError):
            continue
    raise RuntimeError("D2R.exe process not found")


def find_module_base(pid: int) -> int:
    maps = Path(f"/proc/{pid}/maps").read_text()
    for line in maps.splitlines():
        if "D2R.exe" in line or "d2r.exe" in line.lower():
            return int(line.split("-")[0], 16)
    for candidate in (0x140000000, 0x400000):
        try:
            with open(f"/proc/{pid}/mem", "rb") as f:
                f.seek(candidate)
                if f.read(2) == b"MZ":
                    return candidate
        except Exception:
            continue
    raise RuntimeError("Module base not found")


def read_mem(pid: int, addr: int, size: int) -> bytes:
    with open(f"/proc/{pid}/mem", "rb") as f:
        f.seek(addr)
        return f.read(size)


def check_hash_table(pid: int, module_base: int, offset: int) -> int:
    """Score a candidate offset.  Returns 0-8; higher = more likely valid."""
    va = module_base + offset
    try:
        data = read_mem(pid, va, 6 * HASH_BUCKET_COUNT * PTR_SIZE)
    except Exception as e:
        print(f"  ERROR reading {va:#x}: {e}")
        return -1

    total_null = 0
    total_valid = 0
    heap_like = 0
    type_report: list[str] = []

    for ut in range(6):
        base = ut * HASH_BUCKET_COUNT * PTR_SIZE
        nulls = valids = 0
        for b in range(HASH_BUCKET_COUNT):
            ptr = struct.unpack_from("<Q", data, base + b * PTR_SIZE)[0]
            if ptr == 0:
                nulls += 1
            else:
                valids += 1
                if 0x10000 < ptr < 0x7FFFFFFFFFFF:
                    heap_like += 1
        name = UNIT_TYPES[ut] if ut < len(UNIT_TYPES) else f"Type{ut}"
        type_report.append(f"    {name:8s}: {nulls:3d} null, {valids:3d} non-null")
        total_null += nulls
        total_valid += valids

    total = HASH_BUCKET_COUNT * 6
    pct_null = total_null / total * 100

    print(f"\n  Offset {offset:#010x}  (VA {va:#x})")
    for line in type_report:
        print(line)

    score = 0
    if pct_null > 70:
        score += 3
        print(f"    ✓ Mostly NULL ({total_null}/{total} = {pct_null:.0f}%)")
    else:
        print(f"    ✗ Not mostly NULL ({pct_null:.0f}%)")
    if 0 < total_valid < total * 0.3:
        score += 2
        print(f"    ✓ Reasonable non-null count ({total_valid})")
    if heap_like > 0:
        score += 3
        print(f"    ✓ {heap_like} heap-like pointers")
    print(f"    SCORE: {score}/8")
    return score


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify D2R UNIT_TABLE_OFFSET candidates.")
    parser.add_argument("--pid", type=int, help="D2R.exe PID (auto-detected)")
    parser.add_argument("--base", type=lambda x: int(x, 0), help="Module base (auto-detected)")
    parser.add_argument(
        "--offset", nargs="+", type=lambda x: int(x, 0), required=True,
        help="One or more candidate offsets to test (hex or decimal)",
    )
    parser.add_argument(
        "--range", type=lambda x: int(x, 0), default=0,
        help="Also scan ±RANGE bytes around each candidate (step 0x10)",
    )
    args = parser.parse_args()

    pid = args.pid or find_d2r_pid()
    module_base = args.base or find_module_base(pid)
    print(f"PID         : {pid}")
    print(f"Module base : {module_base:#x}")

    # Verify MZ header
    header = read_mem(pid, module_base, 4)
    if header[:2] != b"MZ":
        print("ERROR: no MZ header at module base!")
        sys.exit(1)
    print("MZ header   : OK")

    best_score = -1
    best_offset = None

    for offset in args.offset:
        score = check_hash_table(pid, module_base, offset)
        if score > best_score:
            best_score = score
            best_offset = offset

    if args.range:
        for base_offset in args.offset:
            print(f"\n{'─'*50}")
            print(f"  Range scan ±{args.range:#x} around {base_offset:#x}")
            print(f"{'─'*50}")
            range_hits: list[tuple[int, int, int]] = []
            for off in range(base_offset - args.range, base_offset + args.range, 0x10):
                try:
                    va = module_base + off
                    data = read_mem(pid, va, HASH_BUCKET_COUNT * PTR_SIZE)
                    nulls = valids = 0
                    for b in range(HASH_BUCKET_COUNT):
                        ptr = struct.unpack_from("<Q", data, b * PTR_SIZE)[0]
                        if ptr == 0:
                            nulls += 1
                        elif 0x10000 < ptr < 0x7FFFFFFFFFFF:
                            valids += 1
                    if nulls > 110 and 0 < valids < 20:
                        range_hits.append((off, nulls, valids))
                except Exception:
                    pass
            if range_hits:
                print(f"  Found {len(range_hits)} candidate(s):")
                for off, n, v in sorted(range_hits, key=lambda x: -x[2])[:10]:
                    marker = " ◀ documented" if off == base_offset else ""
                    print(f"    {off:#010x}  nulls={n}  valid={v}{marker}")
            else:
                print("  No candidates in range.")

    if best_offset is not None:
        print(f"\nBEST CANDIDATE: {best_offset:#010x}  (score {best_score}/8)")
        print(f"\nTo apply:  export D2R_UNIT_TABLE_OFFSET={best_offset:#x}")


if __name__ == "__main__":
    main()
