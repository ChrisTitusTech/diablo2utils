import { Diablo2Version, UnitType } from '@diablo2/data';
import { StrutAny, StrutInfer, toHex } from 'binparse';
import 'source-map-support/register.js';
import { Diablo2Player } from './d2.player.js';
import { LogType } from './logger.js';
import { Process } from './process.js';
import { ScannerBuffer } from './scanner.js';
import { D2rUnitDataPlayerStrut, D2rUnitStrut, UnitAnyS } from './struts/d2r.unit.any.js';
import { Pointer } from './struts/pointer.js';
import { dump } from './util/dump.js';

/**
 * Offset from D2R.exe module base to the UnitHashTable global.
 * Updated per D2R patch — current value from PrimeMH (latest patch).
 * Override via D2R_UNIT_TABLE_OFFSET environment variable if needed.
 */
const UNIT_TABLE_OFFSET = Number(process.env['D2R_UNIT_TABLE_OFFSET'] || 0x1eaa3d0);

/** Hash table has 128 buckets per unit type; items are the 5th array (index 4). */
const HASH_BUCKET_COUNT = 128;
const HASH_BUCKET_SIZE = 8; // u64 pointer per bucket
const ITEM_ARRAY_OFFSET = 4 * HASH_BUCKET_COUNT * HASH_BUCKET_SIZE; // skip player/npc/object/missile

export class Diablo2Process {
  version: Diablo2Version = Diablo2Version.Resurrected;
  process: Process;

  lastOffset = { name: 0, player: 0, seed: 0 };

  /** Cached D2R.exe module base address */
  private _d2rBase: number | null = null;

  constructor(proc: Process) {
    this.process = proc;
  }

  /** Resolve the D2R.exe module base address (cached after first call). */
  async getD2RBase(logger: LogType): Promise<number> {
    if (this._d2rBase != null) return this._d2rBase;

    // Strategy 1: Search /proc/PID/maps for D2R.exe path
    let base = await this.process.findModuleBase('D2R.exe');
    if (base == null) base = await this.process.findModuleBase('d2r');

    // Strategy 2: Look for any .exe module mapped at file offset 0
    if (base == null) base = await this.process.findExeModuleInMaps();

    // Strategy 3: Check default 64-bit PE base address (Wine often maps here)
    if (base == null) {
      const DEFAULT_PE_BASES = [0x140000000, 0x400000];
      for (const candidate of DEFAULT_PE_BASES) {
        try {
          const header = await this.process.read(candidate, 4);
          // Check for 'MZ' DOS header magic
          if (header[0] === 0x4d && header[1] === 0x5a) {
            base = candidate;
            break;
          }
        } catch {
          // Not readable at this address
        }
      }
    }

    if (base == null) {
      // Log available maps info for debugging
      const mapsInfo = await this.process.getMapsDebugInfo();
      logger.warn({ mapsInfo }, 'D2R:ModuleBase:NotFound');
      throw new Error('D2R.exe module not found — could not locate PE base in process memory');
    }

    this._d2rBase = base;
    logger.info({ base: toHex(base) }, 'D2R:ModuleBase');
    return base;
  }

  /**
   * Read all ground items from D2R's UnitHashTable.
   *
   * This is the same approach used by PrimeMH and d2r-mapview:
   * walk the item_ptrs[128] hash buckets following Unit.pNext (0x150).
   */
  async getGroundItems(logger: LogType): Promise<Map<number, UnitAnyS>> {
    const base = await this.getD2RBase(logger);
    const itemHashAddr = base + UNIT_TABLE_OFFSET + ITEM_ARRAY_OFFSET;

    // Read all 128 bucket pointers at once (128 × 8 bytes = 1024 bytes)
    const bucketBuf = await this.process.read(itemHashAddr, HASH_BUCKET_COUNT * HASH_BUCKET_SIZE);
    const items = new Map<number, UnitAnyS>();

    const MaxChainLength = 500;

    for (let i = 0; i < HASH_BUCKET_COUNT; i++) {
      // Read u64 pointer (little-endian) from bucket
      const lo = bucketBuf.readUInt32LE(i * 8);
      const hi = bucketBuf.readUInt32LE(i * 8 + 4);
      let unitPtr = lo + hi * 0x100000000;

      let chainLen = 0;
      while (unitPtr > 0x110000 && unitPtr < 0x7fffffff0000) {
        if (++chainLen > MaxChainLength) {
          logger.warn({ bucket: i, chainLen }, 'HashTable:ChainTooLong');
          break;
        }

        try {
          const unit = await this.readStrutAt(unitPtr, D2rUnitStrut);
          // Only include items (type 4); mode 3 = on ground, mode 5 = dropping
          if (unit.type === UnitType.Item && (unit.mode === 3 || unit.mode === 5)) {
            items.set(unit.unitId, unit);
          }
          // Follow Unit.pNext (hash chain pointer at offset 0x150)
          unitPtr = unit.pNext;
        } catch {
          break; // invalid memory – stop walking this chain
        }
      }
    }

    logger.trace({ items: items.size }, 'HashTable:Items');
    return items;
  }

  async dump(address: number, count = 100): Promise<void> {
    const data = await this.process.read(address, count);
    dump(data, toHex(address));
  }

  async readStrutAt<T extends StrutAny>(offset: number, strut: T, size = strut.size): Promise<StrutInfer<T>> {
    const buf = await this.process.read(offset, size);
    return strut.raw(buf);
  }

  /** Find the running diablo2 process */
  static async find(): Promise<Diablo2Process> {
    const procName = 'D2R.exe';
    const pid = await Process.findPidByName(procName);
    if (pid == null) throw new Error('Unable to find process: ' + procName);
    return new Diablo2Process(new Process(pid));
  }

  async scanForPlayer(playerName: string, logger: LogType): Promise<Diablo2Player | null> {
    if (this.lastOffset.name > 0) {
      logger.info({ lastGoodAddress: this.lastOffset }, 'Offsets:Previous');

      try {
        const unit = await this.readStrutAt(this.lastOffset.player, D2rUnitStrut);
        if (Pointer.isPointersValid(unit) !== 0) return new Diablo2Player(this, this.lastOffset.player);
      } catch (e) {
        console.log('Cache:Failed', { e });
      }
    }

    for await (const mem of this.process.scanDistance(this.lastOffset.name)) {
      for (const nameOffset of ScannerBuffer.text(mem.buffer, playerName, 0x40)) {
        const playerNameOffset = nameOffset + mem.map.start;

        const strut = D2rUnitDataPlayerStrut.raw(mem.buffer, nameOffset);

        if (!strut.questNormal.isValid) continue;
        if (!strut.questNightmare.isValid) continue;
        if (!strut.questHell.isValid) continue;

        if (!strut.wpNormal.isValid) continue;
        if (!strut.wpNightmare.isValid) continue;
        if (!strut.wpHell.isValid) continue;

        logger.info({ offset: toHex(playerNameOffset) }, 'Player:Offset');

        const lastPlayer = this.lastOffset.player;
        for await (const p of this.process.scanDistance(
          lastPlayer,
          (f) => lastPlayer === 0 || Math.abs(f.start - lastPlayer) < 0xff_ff_ff_ff,
        )) {
          for (const off of ScannerBuffer.pointer(p.buffer, playerNameOffset)) {
            const verOffset = this.version === Diablo2Version.Classic ? 20 : 16;
            const playerRelStrutOffset = off - verOffset;
            const playerStrutOffset = playerRelStrutOffset + p.map.start;

            const unit = D2rUnitStrut.raw(p.buffer, playerRelStrutOffset);
            logger.info(
              {
                offset: toHex(playerNameOffset),
                unit: toHex(playerStrutOffset),
                pointers: Pointer.isPointersValid(unit),
              },
              'Player:Offset:Pointer',
            );

            if (Pointer.isPointersValid(unit) === 0) continue;
            logger.info(
              { offset: toHex(playerNameOffset), unit: toHex(playerStrutOffset) },
              'Player:Offset:Pointer:Found',
            );

            this.lastOffset.player = playerStrutOffset;
            this.lastOffset.name = playerNameOffset;

            return new Diablo2Player(this, playerStrutOffset);
          }
        }
      }
    }

    logger.warn({ playerName }, 'Player:NotFound');
    return null;
  }
}
