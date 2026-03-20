#!/usr/bin/env python3
"""
D2R Unit Struct Deep Verifier
==============================

Walks the unit hash table at the given offset and reads actual UnitAny
structs to verify the pointer chains are valid: Player → PlayerData
(name), Path (position), Act → ActMisc (difficulty, seeds).

This provides confidence that the offset is correct AND that struct
field offsets haven't shifted after a patch.

Usage
-----
  # Verify structs with the documented offset:
  ./verify-structs.py --pid 12345 --offset 0x1EAA3D0

  # Auto-detect PID:
  ./verify-structs.py --offset 0x1EAA3D0
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

HASH_BUCKET_COUNT = 128
PTR_SIZE = 8
UNIT_TYPES = ["Player", "NPC", "Object", "Missile", "Item", "Tile"]

# ── UnitAny struct field offsets (D2R 64-bit) ────────────────────────────
F_TYPE = 0x00
F_TXTFILENO = 0x04
F_UNITID = 0x08
F_MODE = 0x0C
F_PDATA = 0x10
F_ACTID = 0x18
F_PACT = 0x20
F_PPATH = 0x38
F_PSTATS = 0x88
F_PNEXT = 0x150
F_PLAYERCLASS = 0x174

# Path struct
F_PATH_X = 0x02
F_PATH_Y = 0x06
F_PATH_PROOM = 0x20

# Act struct
F_ACT_MAPSEED = 0x1C
F_ACT_ACTID = 0x28
F_ACT_PACTMISC = 0x70

# ActMisc struct
F_ACTMISC_DIFFICULTY = 0x830

# RoomEx
F_ROOMEX_PLEVEL = 0x88

DIFFICULTY_NAMES = {0: "Normal", 1: "Nightmare", 2: "Hell"}


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


def u32(data: bytes, off: int) -> int:
    return struct.unpack_from("<I", data, off)[0]


def u16(data: bytes, off: int) -> int:
    return struct.unpack_from("<H", data, off)[0]


def ptr(data: bytes, off: int) -> int:
    return struct.unpack_from("<Q", data, off)[0]


def is_valid_ptr(p: int) -> bool:
    """Check if a pointer looks like a valid heap/data address.
    Wine/Proton may map allocations in either the 32-bit or 64-bit range."""
    return 0x10000 < p < 0x7FFFFFFFFFFF


def verify_player(pid: int, bucket: int, unit_ptr: int) -> bool:
    """Read a UnitAny and verify it looks like a Player.  Returns True on success."""
    try:
        unit = read_mem(pid, unit_ptr, 0x178)
    except Exception as e:
        print(f"    ERROR reading UnitAny at {unit_ptr:#x}: {e}")
        return False

    unit_type = u32(unit, F_TYPE)
    txt_no = u32(unit, F_TXTFILENO)
    unit_id = u32(unit, F_UNITID)
    mode = u32(unit, F_MODE)
    p_data = ptr(unit, F_PDATA)
    p_act = ptr(unit, F_PACT)
    p_path = ptr(unit, F_PPATH)

    print(f"\n  Bucket[{bucket}]  ptr={unit_ptr:#018x}")
    print(f"    unitType   = {unit_type} ({'Player' if unit_type == 0 else 'NOT Player!'})")
    print(f"    txtFileNo  = {txt_no}")
    print(f"    unitId     = {unit_id:#x}")
    print(f"    mode       = {mode}")
    print(f"    pData      = {p_data:#018x}")
    print(f"    pAct       = {p_act:#018x}")
    print(f"    pPath      = {p_path:#018x}")

    ok = True

    if unit_type != 0:
        print("    ✗ unitType != 0 — NOT a Player!")
        ok = False

    # ── PlayerData → name ─────────────────────────────────────────────
    if is_valid_ptr(p_data):
        try:
            pd = read_mem(pid, p_data, 0x50)
            name = pd[:16].split(b"\x00")[0].decode("ascii", errors="replace")
            print(f"    ✓ PlayerName: '{name}'")
        except Exception:
            print("    ? Could not read PlayerData")
    else:
        print("    ✗ pData is not a valid pointer")
        ok = False

    # ── Path → position ──────────────────────────────────────────────
    if is_valid_ptr(p_path):
        try:
            pd = read_mem(pid, p_path, 0x30)
            x = u16(pd, F_PATH_X)
            y = u16(pd, F_PATH_Y)
            print(f"    ✓ Position: x={x}, y={y}")
        except Exception:
            print("    ? Could not read Path")
    else:
        print("    ✗ pPath is not a valid pointer")
        ok = False

    # ── Act → ActMisc → difficulty/seeds ──────────────────────────────
    if is_valid_ptr(p_act):
        try:
            act = read_mem(pid, p_act, 0x80)
            map_seed = u32(act, F_ACT_MAPSEED)
            act_id = u32(act, F_ACT_ACTID)
            p_misc = ptr(act, F_ACT_PACTMISC)
            print(f"    ✓ mapSeed={map_seed:#010x}  actId={act_id}")

            if is_valid_ptr(p_misc):
                misc = read_mem(pid, p_misc, 0x840)
                diff = u32(misc, F_ACTMISC_DIFFICULTY)
                print(f"    ✓ Difficulty: {diff} ({DIFFICULTY_NAMES.get(diff, '?')})")
            else:
                print("    ✗ pActMisc is not a valid pointer")
                ok = False
        except Exception as e:
            print(f"    ? Act chain error: {e}")
            ok = False
    else:
        print("    ✗ pAct is not a valid pointer")
        ok = False

    return ok


def verify_items(pid: int, module_base: int, offset: int) -> None:
    """Quick check of Item buckets (unit type 4)."""
    item_base = module_base + offset + 4 * HASH_BUCKET_COUNT * PTR_SIZE
    try:
        data = read_mem(pid, item_base, HASH_BUCKET_COUNT * PTR_SIZE)
    except Exception as e:
        print(f"  ERROR reading Item hash table: {e}")
        return

    count = 0
    samples: list[str] = []
    for b in range(HASH_BUCKET_COUNT):
        p = struct.unpack_from("<Q", data, b * PTR_SIZE)[0]
        if p != 0:
            count += 1
            if len(samples) < 3:
                try:
                    u = read_mem(pid, p, 0x20)
                    ut = u32(u, 0)
                    txt = u32(u, 4)
                    uid = u32(u, 8)
                    samples.append(f"    Bucket[{b}] type={ut} txt={txt} id={uid:#x}")
                except Exception:
                    pass

    print(f"\n  Item Hash Table: {count}/{HASH_BUCKET_COUNT} non-null buckets")
    for s in samples:
        print(s)


def main() -> None:
    parser = argparse.ArgumentParser(description="Deep-verify D2R unit hash table and struct layout.")
    parser.add_argument("--pid", type=int, help="D2R.exe PID (auto-detected)")
    parser.add_argument("--base", type=lambda x: int(x, 0), help="Module base (auto-detected)")
    parser.add_argument("--offset", type=lambda x: int(x, 0), required=True, help="UNIT_TABLE_OFFSET to verify")
    args = parser.parse_args()

    pid = args.pid or find_d2r_pid()
    module_base = args.base or find_module_base(pid)
    print(f"PID         : {pid}")
    print(f"Module base : {module_base:#x}")
    print(f"Offset      : {args.offset:#x}")
    print(f"VA          : {module_base + args.offset:#x}")

    # Read Player bucket table
    player_va = module_base + args.offset
    try:
        table = read_mem(pid, player_va, HASH_BUCKET_COUNT * PTR_SIZE)
    except Exception as e:
        print(f"ERROR reading hash table: {e}")
        sys.exit(1)

    player_ptrs = []
    for b in range(HASH_BUCKET_COUNT):
        p = struct.unpack_from("<Q", table, b * PTR_SIZE)[0]
        if p != 0:
            player_ptrs.append((b, p))

    print(f"\nPlayer buckets: {len(player_ptrs)} non-null of {HASH_BUCKET_COUNT}")

    if not player_ptrs:
        print("⚠  No player found — are you in a game?")
        sys.exit(0)

    any_full_pass = False
    any_name_found = False
    for bucket, p in player_ptrs:
        ok = verify_player(pid, bucket, p)
        if ok:
            any_full_pass = True

    # Check if at least player names were readable (partial struct validity)
    # Re-scan quickly for name readability
    for bucket, p in player_ptrs:
        try:
            unit = read_mem(pid, p, 0x178)
            p_data = ptr(unit, F_PDATA)
            if is_valid_ptr(p_data):
                pd = read_mem(pid, p_data, 0x20)
                name = pd[:16].split(b"\x00")[0]
                if len(name) > 0 and name.isascii():
                    any_name_found = True
                    break
        except Exception:
            pass

    verify_items(pid, module_base, args.offset)

    print()
    if any_full_pass:
        print("═" * 50)
        print("  ✓  Active player fully verified!")
        print("═" * 50)
    elif any_name_found:
        print("═" * 50)
        print("  ~  Player names readable but no fully active player found.")
        print("     (Are you in a game? Lobby players have NULL pAct.)")
        print("═" * 50)
    else:
        print("═" * 50)
        print("  ✗  Struct checks failed — offsets may have shifted")
        print("═" * 50)
        sys.exit(1)


if __name__ == "__main__":
    main()
