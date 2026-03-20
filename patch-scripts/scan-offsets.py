#!/usr/bin/env python3
"""
D2R In-Memory Byte Pattern Scanner
===================================

Scans the decrypted .text section of a running D2R process for the byte
patterns documented in d2r-memory-offsets.md.  Uses a compiled C helper
for speed (~22 MB scanned in <1 s).

IMPORTANT: D2R's .text section is DRM-encrypted on disk.  This script
reads from /proc/PID/mem where it has already been decrypted at runtime.

Prerequisites
-------------
* D2R running (via Wine / Proton)
* gcc (for compiling the C scanner)
* Python 3.8+

Usage
-----
  # Auto-detect PID:
  ./scan-offsets.py

  # Explicit PID:
  ./scan-offsets.py --pid 12345

  # Custom module base:
  ./scan-offsets.py --pid 12345 --base 0x140000000

  # Show verbose per-match detail:
  ./scan-offsets.py -v
"""

from __future__ import annotations

import argparse
import ctypes
import os
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

# ── PE helpers ────────────────────────────────────────────────────────────

def find_d2r_pid() -> int:
    """Find D2R.exe PID by scanning /proc."""
    for pid_dir in Path("/proc").iterdir():
        if not pid_dir.name.isdigit():
            continue
        try:
            cmdline = (pid_dir / "cmdline").read_bytes()
            if b"D2R.exe" in cmdline:
                return int(pid_dir.name)
        except (PermissionError, FileNotFoundError):
            continue
    raise RuntimeError("D2R.exe process not found — is it running?")


def find_module_base(pid: int) -> int:
    """Find D2R.exe module base from /proc/PID/maps."""
    maps = Path(f"/proc/{pid}/maps").read_text()
    for line in maps.splitlines():
        if "D2R.exe" in line or "d2r.exe" in line.lower():
            base = int(line.split("-")[0], 16)
            return base
    # Fallback: try common PE base addresses
    for candidate in (0x140000000, 0x400000):
        try:
            with open(f"/proc/{pid}/mem", "rb") as f:
                f.seek(candidate)
                if f.read(2) == b"MZ":
                    return candidate
        except Exception:
            continue
    raise RuntimeError("Could not find D2R.exe module base")


def read_pe_text_section(pid: int, module_base: int) -> tuple[int, int]:
    """Read PE headers to find .text section VA and virtual size."""
    with open(f"/proc/{pid}/mem", "rb") as f:
        f.seek(module_base)
        dos_header = f.read(0x40)
        if dos_header[:2] != b"MZ":
            raise RuntimeError(f"Bad DOS header at {module_base:#x}")

        pe_offset = struct.unpack_from("<I", dos_header, 0x3C)[0]
        f.seek(module_base + pe_offset)
        pe_sig = f.read(4)
        if pe_sig != b"PE\x00\x00":
            raise RuntimeError("Bad PE signature")

        coff_header = f.read(20)
        num_sections = struct.unpack_from("<H", coff_header, 2)[0]
        opt_header_size = struct.unpack_from("<H", coff_header, 16)[0]

        # Skip optional header
        f.seek(module_base + pe_offset + 4 + 20 + opt_header_size)

        for _ in range(num_sections):
            section = f.read(40)
            name = section[:8].rstrip(b"\x00").decode("ascii", errors="replace")
            if name == ".text":
                vsize = struct.unpack_from("<I", section, 8)[0]
                va = struct.unpack_from("<I", section, 12)[0]
                return va, vsize

    raise RuntimeError(".text section not found in PE")


def read_text_from_memory(pid: int, module_base: int, text_va: int, text_vsize: int) -> bytes:
    """Read the .text section from process memory (decrypted)."""
    data = bytearray()
    chunk_size = 0x100000
    with open(f"/proc/{pid}/mem", "rb") as f:
        for off in range(0, text_vsize, chunk_size):
            try:
                f.seek(module_base + text_va + off)
                chunk = f.read(min(chunk_size, text_vsize - off))
                data.extend(chunk)
            except Exception:
                data.extend(b"\x00" * min(chunk_size, text_vsize - off))
    return bytes(data)


# ── C scanner ─────────────────────────────────────────────────────────────

C_SOURCE = r"""
#include <stdint.h>
#include <string.h>

/* Pattern scan with wildcard support.
 * pattern: byte values, mask: 1=match, 0=wildcard */
int scan_pattern(const uint8_t *data, int data_len,
                 const uint8_t *pattern, const uint8_t *mask, int pat_len,
                 int *out, int max_hits) {
    int count = 0;
    for (int i = 0; i <= data_len - pat_len && count < max_hits; i++) {
        int match = 1;
        for (int j = 0; j < pat_len; j++) {
            if (mask[j] && data[i+j] != pattern[j]) {
                match = 0;
                break;
            }
        }
        if (match) out[count++] = i;
    }
    return count;
}

/* RIP-relative displacement scan: find all places that reference a
 * given target RVA via rip+disp32. */
int scan_rip(const uint8_t *data, int data_len, int text_va,
             int target_rva, int *out, int max_hits) {
    int count = 0;
    int C = target_rva - text_va - 4;
    for (int i = 0; i < data_len - 4 && count < max_hits; i++) {
        int actual;
        memcpy(&actual, data + i, 4);
        if (actual == C - i) out[count++] = i;
    }
    return count;
}

/* Direct 4-byte value scan. */
int scan_direct(const uint8_t *data, int data_len, int target,
                int *out, int max_hits) {
    int count = 0;
    for (int i = 0; i < data_len - 4 && count < max_hits; i++) {
        int actual;
        memcpy(&actual, data + i, 4);
        if (actual == target) out[count++] = i;
    }
    return count;
}
"""


def compile_scanner() -> ctypes.CDLL:
    """Compile the C scanner to a shared library and load it."""
    tmpdir = tempfile.gettempdir()
    c_path = os.path.join(tmpdir, "d2r_scan.c")
    so_path = os.path.join(tmpdir, "d2r_scan.so")

    with open(c_path, "w") as f:
        f.write(C_SOURCE)

    result = subprocess.run(
        ["gcc", "-O2", "-shared", "-fPIC", "-o", so_path, c_path],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"gcc failed: {result.stderr}")

    lib = ctypes.CDLL(so_path)
    lib.scan_pattern.argtypes = [
        ctypes.c_char_p, ctypes.c_int,
        ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int,
        ctypes.POINTER(ctypes.c_int), ctypes.c_int,
    ]
    lib.scan_pattern.restype = ctypes.c_int
    lib.scan_rip.argtypes = [
        ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        ctypes.POINTER(ctypes.c_int), ctypes.c_int,
    ]
    lib.scan_rip.restype = ctypes.c_int
    lib.scan_direct.argtypes = [
        ctypes.c_char_p, ctypes.c_int, ctypes.c_int,
        ctypes.POINTER(ctypes.c_int), ctypes.c_int,
    ]
    lib.scan_direct.restype = ctypes.c_int
    return lib


# ── Pattern definitions ──────────────────────────────────────────────────

def parse_hex_pattern(hex_str: str) -> tuple[bytes, bytes]:
    """Parse a hex pattern string (with ?? wildcards) into (bytes, mask)."""
    pattern = []
    mask = []
    for token in hex_str.strip().split():
        if token == "??":
            pattern.append(0)
            mask.append(0)
        else:
            pattern.append(int(token, 16))
            mask.append(1)
    return bytes(pattern), bytes(mask)


# How each offset is resolved after a pattern match:
#   rip_relative : resolved = match_rva + pattern_offset + 4 + disp32 + adj
#   direct       : resolved = disp32 + adj       (register holds module_base)
#   data         : resolved = match_rva + adj     (match IS the data)
PATTERNS = [
    {
        "name": "unit_table",
        "hex": "48 03 C7 49 8B 8C C6",
        "pattern_offset": 7,
        "adj": 0,
        "mode": "direct",
        "notes": "add rax,rdi; mov rcx,[r14+rax*8+disp32]",
    },
    {
        "name": "ui_offset",
        "hex": "40 84 ed 0f 94 05",
        "pattern_offset": 6,
        "adj": 10,
        "mode": "rip_relative",
        "notes": "test + sete [rip+disp32]",
    },
    {
        "name": "expansion",
        "hex": "48 8B 05 ?? ?? ?? ?? ?? 8B D9 F3 0F 10 50 ??",
        "pattern_offset": 3,
        "adj": 7,
        "mode": "rip_relative",
        "notes": "mov rax,[rip+disp32] — wildcard pattern",
    },
    {
        "name": "hover",
        "hex": "C6 84 C2 ?? ?? ?? ?? ?? 48 8B 74 24 ??",
        "pattern_offset": 3,
        "adj": -1,
        "mode": "direct",
        "notes": "mov byte [rdx+rax*8+disp32] — hover struct offset",
    },
    {
        "name": "roster",
        "hex": "02 45 33 D2 4D 8B",
        "pattern_offset": -3,
        "adj": 1,
        "mode": "rip_relative",
        "notes": "mid-instruction pattern; negative offset backs up to RIP-rel disp",
    },
    {
        "name": "panels",
        "hex": "48 89 05 ?? ?? ?? ?? 48 85 DB 74 1E",
        "pattern_offset": 3,
        "adj": 7,
        "mode": "rip_relative",
        "notes": "mov [rip+disp32],rax — panel pointer store",
    },
    {
        "name": "keybindings",
        "hex": "02 00 00 00 ?? ?? 00 00 00 00 03 00 00 00 ?? ?? 01 00 00 00",
        "pattern_offset": 0,
        "adj": 0x158C,
        "mode": "data",
        "notes": "data pattern match — offset is match_rva + adj",
    },
]


# ── Scan logic ────────────────────────────────────────────────────────────

def resolve_match(
    text_data: bytes,
    text_va: int,
    match_file_offset: int,
    p: dict,
) -> int | None:
    """Resolve a pattern match to a final RVA offset."""
    disp_pos = match_file_offset + p["pattern_offset"]
    if disp_pos < 0 or disp_pos + 4 > len(text_data):
        return None

    disp = struct.unpack_from("<i", text_data, disp_pos)[0]
    rva = text_va + match_file_offset

    mode = p["mode"]
    adj = p["adj"]

    if mode == "direct":
        return disp + adj
    elif mode == "rip_relative":
        resolved_rva = rva + p["pattern_offset"] + 4 + disp
        return resolved_rva + adj
    elif mode == "data":
        return rva + adj
    return None


def run_pattern_scan(
    lib: ctypes.CDLL,
    text_data: bytes,
    text_va: int,
    verbose: bool = False,
) -> dict[str, int | None]:
    """Run all pattern scans and return {name: resolved_offset}."""
    max_hits = 100
    out = (ctypes.c_int * max_hits)()
    results: dict[str, int | None] = {}

    for p in PATTERNS:
        pat, mask = parse_hex_pattern(p["hex"])
        n = lib.scan_pattern(text_data, len(text_data), pat, mask, len(pat), out, max_hits)

        best: int | None = None

        if verbose or n > 0:
            print(f"\n{'─'*60}")
            print(f"  {p['name']}")
            print(f"  Pattern : {p['hex']}")
            print(f"  Mode    : {p['mode']}, pattern_offset={p['pattern_offset']}, adj={p['adj']}")
            print(f"  Matches : {n}")

        for j in range(n):
            resolved = resolve_match(text_data, text_va, out[j], p)
            rva = text_va + out[j]

            if verbose:
                disp_pos = out[j] + p["pattern_offset"]
                disp = struct.unpack_from("<i", text_data, disp_pos)[0] if 0 <= disp_pos < len(text_data) - 3 else 0
                print(f"  [{j}] match RVA={rva:#010x}  disp32={disp:#010x}  → {resolved:#010x}" if resolved else f"  [{j}] out of bounds")

            if resolved is not None and best is None:
                best = resolved

        results[p["name"]] = best

    return results


def run_supplementary_scan(
    lib: ctypes.CDLL,
    text_data: bytes,
    text_va: int,
    targets: dict[str, int],
    verbose: bool = False,
) -> None:
    """For each target, count RIP-relative and direct references in .text."""
    max_hits = 200
    out = (ctypes.c_int * max_hits)()

    print(f"\n{'═'*60}")
    print("  SUPPLEMENTARY: Reference counts for each target RVA")
    print(f"{'═'*60}")

    for name, target in targets.items():
        n_rip = lib.scan_rip(text_data, len(text_data), text_va, target, out, max_hits)
        n_direct = lib.scan_direct(text_data, len(text_data), target, out, max_hits)
        indicator = "✓" if n_rip > 0 or n_direct > 0 else "✗"
        print(f"  {indicator} {name:15s} RVA={target:#010x}  rip_refs={n_rip}  direct_refs={n_direct}")


# ── Main ──────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scan D2R process memory for byte patterns to derive offsets.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--pid", type=int, help="D2R.exe PID (auto-detected if omitted)")
    parser.add_argument("--base", type=lambda x: int(x, 0), help="Module base address (auto-detected)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Show per-match detail")
    parser.add_argument(
        "--expected",
        type=str,
        default=None,
        help="Comma-separated name=0xVALUE pairs to check against, e.g. unit_table=0x1EAA3D0,hover=0x1DFE090",
    )
    args = parser.parse_args()

    # ── Locate process ────────────────────────────────────────────────
    pid = args.pid or find_d2r_pid()
    module_base = args.base or find_module_base(pid)
    print(f"PID          : {pid}")
    print(f"Module base  : {module_base:#x}")

    # ── Read PE .text ─────────────────────────────────────────────────
    text_va, text_vsize = read_pe_text_section(pid, module_base)
    print(f".text section: VA={text_va:#x}  size={text_vsize:#x} ({text_vsize:,} bytes)")

    print("Reading .text from process memory …")
    text_data = read_text_from_memory(pid, module_base, text_va, text_vsize)
    print(f"  {len(text_data):,} bytes read")

    # ── Compile C scanner ─────────────────────────────────────────────
    print("Compiling C scanner …")
    lib = compile_scanner()

    # ── Run pattern scans ─────────────────────────────────────────────
    print(f"\n{'═'*60}")
    print("  D2R BYTE PATTERN SCAN — IN-MEMORY .text")
    print(f"{'═'*60}")
    results = run_pattern_scan(lib, text_data, text_va, verbose=args.verbose)

    # ── Parse expected values ─────────────────────────────────────────
    expected: dict[str, int] = {}
    if args.expected:
        for pair in args.expected.split(","):
            k, v = pair.split("=")
            expected[k.strip()] = int(v.strip(), 0)

    # ── Summary ───────────────────────────────────────────────────────
    print(f"\n{'═'*60}")
    print("  RESULTS")
    print(f"{'═'*60}")
    for name, value in results.items():
        exp = expected.get(name)
        if value is None:
            print(f"  ✗ {name:15s}  NOT FOUND")
        elif exp is not None and value == exp:
            print(f"  ✓ {name:15s}  {value:#010x}  (matches expected)")
        elif exp is not None:
            print(f"  ~ {name:15s}  {value:#010x}  (expected {exp:#010x})")
        else:
            print(f"  ? {name:15s}  {value:#010x}")

    # ── Supplementary scan ────────────────────────────────────────────
    targets = {name: val for name, val in results.items() if val is not None}
    if targets:
        run_supplementary_scan(lib, text_data, text_va, targets, verbose=args.verbose)

    # ── Export for verify scripts ─────────────────────────────────────
    ut = results.get("unit_table")
    if ut is not None:
        print(f"\nTo verify the unit_table offset:")
        print(f"  ./verify-offset.py --pid {pid} --offset {ut:#x}")
        print(f"  ./verify-structs.py --pid {pid} --offset {ut:#x}")


if __name__ == "__main__":
    main()
