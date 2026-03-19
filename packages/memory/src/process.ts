import { toHex } from '@diablo2/data';
import { promises as fs } from 'fs';
import { FileHandle } from 'fs/promises';
import { MemoizeExpiring } from 'typescript-memoize';

export interface ProcessMemoryMap {
  start: number;
  end: number;
  permissions: string;
  path?: string;
  line: string;
}

export type FilterFunc = (f: ProcessMemoryMap) => boolean;

export class Process {
  pid: number;
  fh: Promise<FileHandle> | null;

  constructor(pid: number) {
    this.pid = pid;
  }

  /** Find a pid from a process name */
  static async findPidByName(name: string): Promise<number | null> {
    const files = await fs.readdir('/proc');
    const cmdlineCandidates: { pid: number; score: number }[] = [];

    for (const file of files) {
      const pid = Number(file);
      if (isNaN(pid)) continue;

      try {
        const [status, cmdline] = await Promise.all([
          fs.readFile(`/proc/${file}/status`),
          fs.readFile(`/proc/${file}/cmdline`).catch(() => null),
        ]);

        const statusStr = status.toString();
        const statusName = statusStr.split('\n')[0]?.split('\t')[1] ?? '';

        // Fast path: exact status name match
        if (statusName.includes(name)) return pid;

        // Fallback: check cmdline for the process name.
        // Under Wine/Proton the process comm name may differ from the executable
        // (e.g. D2R.exe shows as "Main"), so we check the full command line.
        if (cmdline == null) continue;
        const argv = cmdline.toString().split('\0').filter(Boolean);
        if (argv.length === 0) continue;

        const joined = argv.join(' ');
        if (!joined.includes(name)) continue;

        // Prefer the actual Wine/Proton child process over wrappers like
        // gamescope, pressure-vessel, or the proton launcher itself.
        const argv0 = argv[0];
        const score =
          (/([^\\/]+)$/.exec(argv0)?.[1]?.toLowerCase() === name.toLowerCase() ? 100 : 0) +
          (statusName === 'Main' ? 50 : 0) +
          (/^Z:\\.*D2R\.exe$/i.test(argv0) ? 25 : 0) +
          (joined.includes('Diablo II Resurrected') ? 10 : 0) -
          (joined.includes('proton waitforexitandrun') ? 25 : 0) -
          (joined.includes('gamescope') ? 50 : 0);

        cmdlineCandidates.push({ pid, score });
      } catch (e) {
        // noop
      }
    }

    cmdlineCandidates.sort((a, b) => b.score - a.score || a.pid - b.pid);
    if (cmdlineCandidates.length > 0) return cmdlineCandidates[0].pid;
    return null;
  }

  /** Load the memory map */
  @MemoizeExpiring(10_000)
  async loadMap(): Promise<ProcessMemoryMap[]> {
    const data = await fs.readFile(`/proc/${this.pid}/maps`);

    const memLines = data.toString().trim().split('\n');

    const memMaps: ProcessMemoryMap[] = [];
    for (const line of memLines) {
      const parts = line.split(' ');
      const [start, end] = parts[0].split('-').map((c) => parseInt(c, 16));

      const obj = {
        start,
        end,
        permissions: parts[1],
        path: parts.length > 7 ? parts[parts.length - 1] : undefined,
        line,
      };

      // If the process cant write to it, then its not useful to us
      if (!obj.permissions.startsWith('rw')) continue;
      // Ignore graphic card data
      if (obj.path?.includes('/dev/nvidia')) continue;

      memMaps.push(obj);
    }

    return memMaps;
  }

  /** Close the file handle for this process */
  async close(): Promise<void> {
    if (this.fh != null) {
      const fh = await this.fh;
      await fh.close();
      this.fh = null;
    }
  }

  /** Read a section of memory from this process */
  async read(offset: number, count: number): Promise<Buffer> {
    try {
      if (this.fh == null) this.fh = fs.open(`/proc/${this.pid}/mem`, 'r');
      const fh = await this.fh;
      const buf = Buffer.alloc(count);

      const ret = await fh?.read(buf, 0, buf.length, offset);
      if (ret == null || ret.bytesRead === 0) throw new Error('Failed to read memory at: ' + toHex(offset));

      return buf;
    } catch (e) {
      // console.trace(`Failed to read, ${offset}, ${count}`);
      throw new Error('Failed to read memory at: ' + toHex(offset) + ' - ' + e);
    }
  }

  async isValidMemoryMap(offset: number): Promise<boolean> {
    const maps = await this.loadMap();

    for (const map of maps) {
      if (map.start < offset && map.end > offset) return true;
    }
    return false;
  }

  async *scan(f?: FilterFunc): AsyncGenerator<{ buffer: Buffer; offset: number; map: ProcessMemoryMap }> {
    const maps = await this.loadMap();

    for (const map of maps) {
      if (f != null && f(map) === false) continue;

      try {
        const buffer = await this.read(map.start, map.end - map.start);
        yield { buffer, offset: map.start, map: map };
      } catch (err) {
        continue;
      }
    }
  }

  /** Scan memory near a point */
  async *scanDistance(
    offset: number,
    f?: FilterFunc,
  ): AsyncGenerator<{ buffer: Buffer; offset: number; map: ProcessMemoryMap }> {
    const maps = await this.loadMap();
    const sorted = [...maps].sort((a, b) => {
      const aStart = Math.abs(a.start - offset);
      const bStart = Math.abs(b.start - offset);
      return aStart - bStart;
    });

    for (const map of sorted) {
      if (f != null && f(map) === false) continue;

      try {
        const buffer = await this.read(map.start, map.end - map.start);
        yield { buffer, offset: map.start, map: map };
      } catch (err) {
        continue;
      }
    }
  }

  /**
   * Find the base (lowest) address of a named PE module loaded via Wine/Proton.
   * Reads /proc/PID/maps without filtering so both r-x and rw sections are visible.
   */
  async findModuleBase(moduleName: string): Promise<number | null> {
    const data = await fs.readFile(`/proc/${this.pid}/maps`);
    const lines = data.toString().trim().split('\n');
    const lowerModule = moduleName.toLowerCase();

    for (const line of lines) {
      if (!line.toLowerCase().includes(lowerModule)) continue;
      const startHex = line.split('-')[0].trim();
      return parseInt(startHex, 16);
    }
    return null;
  }

  /**
   * Fallback: find any .exe module mapped at file offset 0.
   * Under Wine/Proton, the PE is file-backed and the path ends with .exe.
   */
  async findExeModuleInMaps(): Promise<number | null> {
    const data = await fs.readFile(`/proc/${this.pid}/maps`);
    const lines = data.toString().trim().split('\n');

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const offset = parts[2];
      const path = parts[parts.length - 1];

      // Look for file-backed mappings at offset 0 that are .exe files
      if (offset !== '00000000' && offset !== '0000000000000000') continue;
      if (path.toLowerCase().endsWith('.exe')) {
        const startHex = parts[0].split('-')[0];
        return parseInt(startHex, 16);
      }
    }
    return null;
  }

  /**
   * Return debug info about mapped regions for troubleshooting module base resolution.
   */
  async getMapsDebugInfo(): Promise<string> {
    try {
      const data = await fs.readFile(`/proc/${this.pid}/maps`);
      const lines = data.toString().trim().split('\n');
      // Return summary: total lines, unique file paths, and any .exe entries
      const paths = new Set<string>();
      const exeLines: string[] = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 6) {
          const path = parts[parts.length - 1];
          if (path.startsWith('/')) paths.add(path);
          if (path.toLowerCase().endsWith('.exe')) exeLines.push(line);
        }
      }
      return `totalLines=${lines.length} uniquePaths=${paths.size} exeEntries=${exeLines.length}${exeLines.length > 0 ? ' exe=' + exeLines[0] : ''}`;
    } catch {
      return 'unreadable';
    }
  }

  /** Scan memory backwards */
  async *scanReverse(f?: FilterFunc): AsyncGenerator<{ buffer: Buffer; offset: number; map: ProcessMemoryMap }> {
    const maps = await this.loadMap();

    for (const map of [...maps].reverse()) {
      if (f != null && f(map) === false) continue;
      try {
        const buffer = await this.read(map.start, map.end - map.start);
        yield { buffer, offset: map.start, map: map };
      } catch (err) {
        continue;
      }
    }
  }
}
