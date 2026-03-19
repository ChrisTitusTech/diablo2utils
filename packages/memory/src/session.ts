import { Diablo2State } from '@diablo2/core';
import { ActUtil, Attribute, Difficulty, Diablo2Mpq, ItemQuality, UnitType } from '@diablo2/data';
import { toHex } from 'binparse';
import { Diablo2ItemJson } from 'packages/state/build/json.js';
import { Diablo2Process } from './d2.js';
import { Diablo2Player } from './d2.player.js';
import { id, Log, LogType } from './logger.js';
import { ActMiscS, ActS, D2rActMiscStrut } from './struts/d2r.act.js';
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

  constructor(proc: Diablo2Process, playerName: string) {
    this.d2 = proc;
    this.playerName = playerName;
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

    if (this.state.units.size > 0) {
      this.state.units.clear();
      dirty = true;
    }

    if (this.state.items.size > 0) {
      this.state.items.clear();
      dirty = true;
    }

    if (dirty) this.state.dirty();
    if (!hadTrackedPlayer) return;

    logger.warn({ d2Proc: this.d2.process.pid, player: this.playerName, reason, err }, 'Player:Lost');
  }

  async start(logger: LogType): Promise<void> {
    logger.info({ d2Proc: this.d2.process.pid, player: this.playerName }, 'Session:Start');

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
        await sleep(this.tickSpeed * errorCount);
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

      this.player = await this.d2.scanForPlayer(this.playerName, logger);
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
    const act = await obj.getAct(player, logger);
    const stats = await obj.getStats(player, logger);
    const levelId = await obj.getLevelId(path, logger);
    const currentAct = levelId > 0 ? (ActUtil.fromLevel(levelId) ?? player.actId) : player.actId;

    // Load ActMisc once to get both mapSeed and difficulty without double-fetching
    const actMisc = act.pActMisc.isValid
      ? await obj.d2.readStrutAt(act.pActMisc.offset, D2rActMiscStrut)
      : null;
    const mapSeed = resolveMapSeed(act, actMisc, logger);
    const mapState = this.state.map as typeof this.state.map & { levelId?: number };

    let mapDirty = false;
    if (mapState.act !== currentAct) {
      mapState.act = currentAct;
      mapDirty = true;
    }
    if (mapState.levelId !== levelId) {
      mapState.levelId = levelId;
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
      this.onMapChange?.(mapSeed, mapState.difficulty, currentAct);
    }

    if (mapDirty) this.state.dirty();

    // Track player location
    if (this.state.players.get(player.unitId) == null) {
      this.state.addPlayer(player.unitId, 'Player', path.x, path.y);
    } else {
      this.state.movePlayer(undefined, player.unitId, path.x, path.y);
    }

    syncPlayerState(this.state.player, this.playerName, stats, this.state);

    const units = await obj.getNearBy(path, logger);
    for (const unit of units.values()) {
      if (unit.type !== UnitType.Item) continue;

      const itemData = Diablo2Mpq.items.byIndex[unit.txtFileNo];
      const itemKey = `${unit.unitId}-${unit.txtFileNo}`;

      if (this.itemIgnore.has(itemKey)) continue;
      if (this.state.items.has(unit.unitId)) continue;

      if (itemData == null) {
        this.itemIgnore.add(itemKey);
        continue;
      }

      const loc = await unit.pPath.fetch(this.d2.process);
      const itemUnitData = unit.pData.isValid ? await this.d2.readStrutAt(unit.pData.offset, D2rUnitDataItemStrut) : null;
      const qualityId = itemUnitData?.quality ?? ItemQuality.NotApplicable;
      const itemJson: Diablo2ItemJson = {
        type: 'item',
        id: unit.unitId,
        updatedAt: Date.now(),
        seenAt: Date.now(),
        name: Diablo2Mpq.t(itemData.nameId) ?? itemData.code,
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
  act: ActS,
  logger: LogType,
): Promise<Difficulty> {
  if (actMisc && actMisc.difficulty >= 0 && actMisc.difficulty <= 2) return actMisc.difficulty;

  if (actMisc) logger.info({ raw: actMisc.difficulty, offset: '0x830' }, 'Player:InvalidDifficulty:FallingBack');
  else logger.error({ offset: toHex(act.pActMisc.offset) }, 'Player:OffsetInvalid:Difficulty');

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

export function dumpStats(stats: Map<Attribute, number>): void {
  for (const stat of stats) {
    console.log(toHex(stat[0]), Attribute[stat[0]], stat[1]);
  }
}
