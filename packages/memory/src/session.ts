import { Diablo2State } from '@diablo2/core';
import { ActUtil, Attribute, Difficulty, Diablo2Mpq, ItemQuality, UnitType } from '@diablo2/data';
import { toHex } from 'binparse';
import { Diablo2ItemJson } from '@diablo2/state';
import { Diablo2Process } from './d2.js';
import { Diablo2Player } from './d2.player.js';
import { id, Log, LogType } from './logger.js';
import { ActMiscS, ActS, D2rActMiscStrut } from './struts/d2r.act.js';
import { D2rLevelStrut, D2rRoomExStrut, D2rRoomStrut } from './struts/d2r.room.js';
import { D2rUnitDataItemStrut, UnitAnyS } from './struts/d2r.unit.any.js';

const sleep = (dur: number): Promise<void> => new Promise((r) => setTimeout(r, dur));
const UINT32_MOD = 0x1_0000_0000n;
const UINT32_MASK = 0xffff_ffffn;
const SEED_MAGIC = 0x6ac6_90c5n;
const SEED_MAGIC_INVERSE = 0x8a3e_6e0dn;
const SEED_OFFSET = 666n;
const ITEM_FLAG_IDENTIFIED = 0x0000_0010;
const ITEM_FLAG_ETHEREAL = 0x0400_0000;
const ITEM_FLAG_RUNEWORD = 0x4000_0000;

/** Item codes for monster body parts / gore – visual debris, not real loot */
const BODY_PART_CODES: ReadonlySet<string> = new Set([
  'hrt', // Heart
  'brz', // Brain
  'jaw', // Jawbone
  'eyz', // Eye
  'hrn', // Horn
  'tal', // Tail
  'flg', // Flag
  'fng', // Fang
  'qll', // Quill
  'sol', // Soul
  'scz', // Scalp
  'spe', // Spleen
]);

export class Diablo2GameSessionMemory {
  state: Diablo2State;
  d2: Diablo2Process;
  playerName: string;

  player: Diablo2Player | null;
  /** Delay to wait between ticks */
  tickSpeed = 250;

  /** Callback fired whenever the map seed, act, or difficulty changes */
  onMapChange?: (seed: number, difficulty: Difficulty, act: number) => void;

  itemIgnore = new Set<string>();

  /**
   * Counts consecutive ticks where the player pointer validates but position
   * is (0, 0).  After a threshold the player is considered "lost" (e.g. the
   * user returned to the main menu while the stale UnitAny pointer still
   * resolves).
   */
  private _noPositionTicks = 0;

  /** Number of consecutive no-position ticks before we treat the pointer as
   *  stale and trigger a player-lost event.  4 ticks ≈ 1 second. */
  private static readonly NO_POSITION_THRESHOLD = 4;

  constructor(proc: Diablo2Process, playerName?: string) {
    this.d2 = proc;
    this.playerName = playerName ?? '';
    this.state = new Diablo2State(id, Log);
  }

  markPlayerLost(logger: LogType, reason: string, err?: unknown): void {
    const hadTrackedPlayer = this.player != null || this.state.player.x > 0 || this.state.player.y > 0;
    this.player = null;

    const statePlayer = this.state.player;
    let dirty = false;

    if (statePlayer.x !== 0 || statePlayer.y !== 0) {
      statePlayer.x = 0;
      statePlayer.y = 0;
      dirty = true;
    }

    // Reset the map seed so the system doesn't stay stuck on the old game.
    // When the player enters a new game the seed will be re-detected.
    const mapState = this.state.map as typeof this.state.map & { levelId?: number };
    if (mapState.id !== 0) {
      mapState.id = 0;
      mapState.act = 0;
      mapState.difficulty = 0;
      mapState.levelId = 0;
      dirty = true;
    }

    if (this.state.units.size > 0) {
      this.state.units.clear();
      dirty = true;
    }

    if (this.state.items.size > 0) {
      this.state.items.clear();
      dirty = true;
    }

    if (this.state.kills.size > 0) {
      this.state.kills.clear();
      dirty = true;
    }

    this.itemIgnore.clear();

    // Reset the player identity so addPlayer() can assign the new unitId.
    // Without this, the state.player getter returns the OLD player entry
    // (with x=0, y=0) and the server thinks hasPlayer=false.
    this.state.playerId = -1;
    if (this.state.players.size > 0) {
      this.state.players.clear();
      dirty = true;
    }

    // Reset no-position counter so a stale count doesn't immediately
    // trigger another NoPosition loss after re-acquisition.
    this._noPositionTicks = 0;

    // Reset cached memory offsets so scanForPlayer doesn't cling to stale data.
    // The hash-table scan doesn't need these, and the slow fallback scan will
    // start fresh instead of wasting time near the old (now invalid) addresses.
    this.d2.lastOffset = { name: 0, player: 0, seed: 0 };

    // Force re-detection of the D2R.exe module base. If the user restarted
    // the game process, the old cached address would be wrong and the
    // hash-table scan would silently fail.
    this.d2.resetBase();

    if (dirty) this.state.dirty();
    if (!hadTrackedPlayer) return;

    logger.warn({ d2Proc: this.d2.process.pid, player: this.playerName, reason, err }, 'Player:Lost');
  }

  async start(logger: LogType): Promise<void> {
    const displayName = this.playerName || '(auto-detect)';
    logger.info({ d2Proc: this.d2.process.pid, player: displayName }, 'Session:Start');

    let errorCount = 0;
    while (true) {
      try {
        const player = await this.waitForPlayer(logger);
        if (player == null) continue;

        await this.updateState(player, logger);
        this.state.player.name = this.playerName;
        await sleep(this.tickSpeed);
        errorCount = 0;
      } catch (err) {
        logger.error({ d2Proc: this.d2.process.pid, err }, 'Session:Error');
        errorCount++;
        // Cap backoff at 5× tick speed to avoid updates stalling indefinitely
        const backoffMultiplier = Math.min(errorCount, 5);
        await sleep(this.tickSpeed * backoffMultiplier);
      }
    }
  }

  async waitForPlayer(logger: LogType): Promise<Diablo2Player> {
    const currentPlayer = this.player;
    if (currentPlayer) {
      let player = null;
      try {
        player = await currentPlayer.validate(logger);
      } catch (err) {
        this.markPlayerLost(logger, 'ValidateFailed', err);
      }
      if (player != null) return currentPlayer;
      this.markPlayerLost(logger, 'PointerInvalid');
    }

    let backOff = 0;
    while (true) {
      logger.info({ d2Proc: this.d2.process.pid, player: this.playerName }, 'Session:WaitForPlayer');

      await sleep(Math.min(backOff * 500, 5_000));
      backOff++;
      const existingPlayer = this.player;
      if (existingPlayer) {
        let player = null;
        try {
          player = await existingPlayer.validate(logger);
        } catch (err) {
          this.markPlayerLost(logger, 'ValidateFailed', err);
        }
        if (player != null) return existingPlayer;
        this.markPlayerLost(logger, 'PointerInvalid');
        continue;
      }

      // Use fast hash-table scan only for the first few attempts.  If it
      // keeps failing (e.g. the active player unit is missing from the hash
      // table — known to happen in some D2R versions), fall back to the
      // slower full-memory scan which can find unlinked player units.
      const skipSlowScan = backOff <= 6; // ~3 seconds of hash-table-only tries
      this.player = await this.d2.scanForPlayer(this.playerName || undefined, logger, skipSlowScan);

      // Auto-detect: populate playerName from auto-detected name even if
      // the player unit itself wasn't found yet (name is discovered from
      // stale hash-table entries whose path data is zero).
      if (!this.playerName && this.d2.lastPlayerName) {
        this.playerName = this.d2.lastPlayerName;
        logger.info({ player: this.playerName }, 'Player:AutoDetected');
      }

      if (this.player == null) continue;

      return this.player;
    }
  }

  async updateState(obj: Diablo2Player, logger: LogType): Promise<void> {
    const startTime = process.hrtime.bigint();
    let player = null;
    try {
      player = await obj.validate(logger);
    } catch (err) {
      this.markPlayerLost(logger, 'ValidateFailed', err);
      return;
    }
    // Player object is no longer validate assume game has exited
    if (player == null) {
      this.markPlayerLost(logger, 'PointerInvalid');
      return;
    }

    const path = await obj.getPath(player, logger);

    // When the player quits a game the UnitAny pointer may still resolve
    // (D2R doesn't zero it out immediately) but the position becomes (0, 0).
    // Skip processing stale data and, after several consecutive ticks,
    // consider the player lost so we can scan for a new one.
    if (path.x === 0 && path.y === 0) {
      this._noPositionTicks++;
      if (this._noPositionTicks >= Diablo2GameSessionMemory.NO_POSITION_THRESHOLD) {
        this.markPlayerLost(logger, 'NoPosition');
      }
      return;
    }
    this._noPositionTicks = 0;

    const act = await obj.getAct(player, logger);
    const stats = await obj.getStats(player, logger);
    const levelId = await obj.getLevelId(path, logger);
    const currentAct = levelId > 0 ? (ActUtil.fromLevel(levelId) ?? player.actId) : player.actId;

    // Load ActMisc once to get both mapSeed and difficulty without double-fetching
    const actMisc = act?.pActMisc.isValid
      ? await obj.d2.readStrutAt(act.pActMisc.offset, D2rActMiscStrut)
      : null;
    const mapSeed = act != null ? resolveMapSeed(act, actMisc, logger) : 0;

    const mapState: Record<string, unknown> & { levelId?: number } = this.state.map as any;

    let mapDirty = false;
    if (mapState.act !== currentAct) {
      mapState.act = currentAct;
      mapDirty = true;
    }
    if (mapState.levelId !== levelId) {
      mapState.levelId = levelId;
      // Clear items when changing levels — the hash table contains ground items
      // from ALL levels, and we only want to show items in the current area.
      this.state.items.clear();
      this.itemIgnore.clear();
      mapDirty = true;
    }

    // Track map information
    if (mapSeed !== 0 && mapSeed !== mapState.id) {
      mapState.id = mapSeed;
      mapState.difficulty = await resolveDifficulty(this.d2, actMisc, act, logger);
      this.state.log.info({ map: mapState }, 'MapSeed:Changed');
      this.state.units.clear();
      this.state.items.clear();
      this.state.kills.clear();
      this.itemIgnore.clear();
      mapDirty = true;
      this.onMapChange?.(mapSeed, mapState.difficulty as Difficulty, currentAct);
    }

    if (mapDirty) this.state.dirty();

    // Track player location
    if (this.state.players.get(player.unitId) == null) {
      this.state.addPlayer(player.unitId, 'Player', path.x, path.y);
    } else {
      this.state.movePlayer(undefined, player.unitId, path.x, path.y);
    }

    syncPlayerState(this.state.player, this.playerName, stats, this.state);

    // Use hash-table based item enumeration (matches PrimeMH / d2r-mapview).
    // This walks item_ptrs[128] → Unit.pNext chains instead of the old
    // room-based traversal which used unreliable pUnitFirst / pRoomNext offsets.
    const units = await this.d2.getGroundItems(logger);
    for (const unit of units.values()) {
      // type and mode are already filtered inside getGroundItems()

      const itemData = this.d2.getItemByIndex(unit.txtFileNo);
      const itemKey = `${unit.unitId}-${unit.txtFileNo}`;

      if (this.itemIgnore.has(itemKey)) continue;
      if (this.state.items.has(unit.unitId)) continue;

      if (itemData == null) {
        this.itemIgnore.add(itemKey);
        continue;
      }

      // Skip monster body parts (visual debris, not real loot)
      if (BODY_PART_CODES.has(itemData.code)) {
        this.itemIgnore.add(itemKey);
        continue;
      }

      // Skip items with no localized name (nameId sentinel 5382 = unused/placeholder)
      const itemName = Diablo2Mpq.t(itemData.nameId);
      if (itemName == null) {
        this.itemIgnore.add(itemKey);
        continue;
      }

      // Fast act-based filter: items from a different act definitely aren't
      // in the current level.  unit.actId is already parsed from the hash
      // table scan — no extra memory reads required.
      if (unit.actId !== currentAct) {
        this.itemIgnore.add(itemKey);
        continue;
      }

      const loc = await unit.pPath.fetch(this.d2.process);

      // Filter by current level: try to resolve the item's room chain to
      // determine its levelId.  Items use a StaticPath whose pRoom field at
      // offset 0x20 may not be populated (different layout from the player's
      // DynamicPath) or may point to a stale / unloaded room.  Because of
      // this, we can only EXCLUDE items where the chain resolves successfully
      // and the levelId is confirmed to be different.  If we can't resolve
      // the chain we allow the item through — the act filter above already
      // eliminates the most obvious cross-area phantoms.
      if (levelId > 0 && loc.pRoom.isValid) {
        try {
          const room = await this.d2.readStrutAt(loc.pRoom.offset, D2rRoomStrut);
          if (room.pRoomExt.isValid) {
            const roomEx = await this.d2.readStrutAt(room.pRoomExt.offset, D2rRoomExStrut);
            if (roomEx.pLevel.isValid) {
              const itemLevel = await this.d2.readStrutAt(roomEx.pLevel.offset, D2rLevelStrut);
              if (itemLevel.levelId !== levelId) {
                this.itemIgnore.add(itemKey);
                continue;
              }
            }
          }
        } catch {
          // Can't resolve item level — allow through
        }
      }

      const itemUnitData = unit.pData.isValid ? await this.d2.readStrutAt(unit.pData.offset, D2rUnitDataItemStrut) : null;

      // Double-check ownership: skip items in player inventory/stash/cube/belt.
      // dwOwnerId != 0 and != 0xFFFFFFFF means the item belongs to a player.
      if (itemUnitData != null) {
        const ownerId = itemUnitData.dwOwnerId;
        if (ownerId !== 0 && ownerId !== 0xFFFFFFFF) {
          this.itemIgnore.add(itemKey);
          continue;
        }
        // invPage 0=inventory, 1=stash, 2=cube — those are not ground drops
        if (itemUnitData.invPage <= 2) {
          this.itemIgnore.add(itemKey);
          continue;
        }
      }

      const qualityId = itemUnitData?.quality ?? ItemQuality.NotApplicable;
      const itemJson: Diablo2ItemJson = {
        type: 'item',
        id: unit.unitId,
        updatedAt: Date.now(),
        seenAt: Date.now(),
        name: itemName,
        code: itemData.code,
        x: loc.staticX,
        y: loc.staticY,
        quality: { id: qualityId, name: ItemQuality[qualityId] ?? 'Unknown' },
        isEthereal: ((itemUnitData?.flags ?? 0) & ITEM_FLAG_ETHEREAL) !== 0,
        isIdentified: ((itemUnitData?.flags ?? 0) & ITEM_FLAG_IDENTIFIED) !== 0,
        isRuneWord: ((itemUnitData?.flags ?? 0) & ITEM_FLAG_RUNEWORD) !== 0,
      };

      this.state.trackItem(itemJson);
    }

    // Reconcile state: remove tracked items that are no longer on the ground.
    // Without this, picked-up / despawned items persist in the drops display
    // until the distance/time filter in filterOld() eventually cleans them.
    const groundIds = new Set(units.keys());
    for (const trackedId of this.state.items.keys()) {
      if (!groundIds.has(trackedId)) {
        this.state.items.delete(trackedId);
        this.state.dirty();
      }
    }

    const duration = Number(process.hrtime.bigint() - startTime) / 1_000_000;

    if (duration > 10) logger.warn({ duration }, 'Update:Tick:Slow');
    else if (duration > 5) logger.info({ duration }, 'Update:Tick:Slow');
    else logger.trace({ duration }, 'Update:Tick');
  }
}

function syncPlayerState(
  player: Diablo2State['player'],
  playerName: string,
  stats: Map<Attribute, number>,
  state: Diablo2State,
): void {
  let dirty = false;

  if (player.name !== playerName) {
    player.name = playerName;
    dirty = true;
  }

  const level = getStat(stats, Attribute.CurrentLevel);
  if (level > 0 && player.level !== level) {
    player.level = level;
    dirty = true;
  }

  const life = getShiftedStat(stats, Attribute.Life, 8);
  if (life >= 0 && player.life !== life) {
    player.life = life;
    dirty = true;
  }

  const experience = getStat(stats, Attribute.Experience);
  if (experience >= 0 && player.xp.current !== experience) {
    if (player.xp.start < 0 || player.xp.start > experience) player.xp.start = experience;
    player.xp.current = experience;
    player.xp.diff = player.xp.current - player.xp.start;
    dirty = true;
  }

  if (dirty) state.dirty();
}

function getStat(stats: Map<Attribute, number>, stat: Attribute): number {
  return stats.get(stat) ?? -1;
}

function getShiftedStat(stats: Map<Attribute, number>, stat: Attribute, shift: number): number {
  const value = stats.get(stat);
  if (value == null) return -1;
  return value >> shift;
}

async function resolveDifficulty(
  d2: Diablo2Process,
  actMisc: { difficulty: number } | null,
  act: ActS | null,
  logger: LogType,
): Promise<Difficulty> {
  if (actMisc && actMisc.difficulty >= 0 && actMisc.difficulty <= 2) return actMisc.difficulty;

  if (actMisc) logger.info({ raw: actMisc.difficulty, offset: '0x830' }, 'Player:InvalidDifficulty:FallingBack');
  else if (act) logger.error({ offset: toHex(act.pActMisc.offset) }, 'Player:OffsetInvalid:Difficulty');
  else logger.warn({}, 'Player:Act:Null:FallingBack');

  if (process.argv.includes('--nightmare')) return Difficulty.Nightmare;
  if (process.argv.includes('--normal')) return Difficulty.Normal;
  return Difficulty.Hell;
}

function resolveMapSeed(act: ActS, actMisc: ActMiscS | null, logger: LogType): number {
  const derivedSeed = actMisc == null ? null : deriveMapSeed(actMisc.initSeedHash, actMisc.endSeedHash);

  if (derivedSeed != null) {
    if (act.mapSeed !== 0 && act.mapSeed !== derivedSeed) {
      logger.warn(
        {
          actMapSeed: act.mapSeed,
          derivedMapSeed: derivedSeed,
          initSeedHash: `0x${actMisc!.initSeedHash.toString(16)}`,
          endSeedHash: `0x${actMisc!.endSeedHash.toString(16)}`,
        },
        'MapSeed:DerivedMismatch',
      );
    }

    return derivedSeed;
  }

  if (act.mapSeed !== 0) return act.mapSeed;

  if (actMisc != null && actMisc.endSeedHash !== 0) {
    logger.warn(
      {
        initSeedHash: `0x${actMisc.initSeedHash.toString(16)}`,
        endSeedHash: `0x${actMisc.endSeedHash.toString(16)}`,
      },
      'MapSeed:DerivedInvalid',
    );
  }

  return 0;
}

function deriveMapSeed(initSeedHash: bigint | number, endSeedHash: number): number | null {
  if (endSeedHash === 0) return null;

  const initSeedHash32 = toUint32(initSeedHash);
  const recoveredSeed = Number((normalizeUint32(BigInt(endSeedHash) - SEED_OFFSET) * SEED_MAGIC_INVERSE) & UINT32_MASK);
  const gameSeedXor = (initSeedHash32 ^ recoveredSeed) >>> 0;
  const verifiedSeed = (initSeedHash32 ^ gameSeedXor) >>> 0;
  const verifiedEndSeedHash = (Math.imul(verifiedSeed, Number(SEED_MAGIC)) + Number(SEED_OFFSET)) >>> 0;

  if (verifiedEndSeedHash !== (endSeedHash >>> 0)) return null;
  return verifiedSeed;
}

function normalizeUint32(value: bigint): bigint {
  return ((value % UINT32_MOD) + UINT32_MOD) & UINT32_MASK;
}

function toUint32(value: bigint | number): number {
  return typeof value === 'bigint' ? Number(value & UINT32_MASK) >>> 0 : value >>> 0;
}

export function dumpStats(stats: Map<Attribute, number>, logger?: LogType): void {
  for (const [code, value] of stats) {
    const msg = `${toHex(code)} ${Attribute[code]} ${value}`;
    if (logger) logger.debug({ code, name: Attribute[code], value }, 'Stat');
    else console.log(msg);
  }
}
