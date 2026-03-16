import { Diablo2State } from '@diablo2/core';
import { Attribute, Difficulty, Diablo2Mpq, UnitType } from '@diablo2/data';
import { toHex } from 'binparse';
import { Diablo2ItemJson } from 'packages/state/build/json.js';
import { Diablo2Process } from './d2.js';
import { Diablo2Player } from './d2.player.js';
import { id, Log, LogType } from './logger.js';
import { ActS, D2rActMiscStrut } from './struts/d2r.act.js';

const sleep = (dur: number): Promise<void> => new Promise((r) => setTimeout(r, dur));

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
        if (errorCount > 5) break;
      }
    }
  }

  async waitForPlayer(logger: LogType): Promise<Diablo2Player> {
    if (this.player) {
      const player = await this.player.validate(logger);
      if (player != null) return this.player;
    }
    // this.player = null;
    let backOff = 0;
    while (true) {
      logger.info({ d2Proc: this.d2.process.pid, player: this.playerName }, 'Session:WaitForPlayer');

      await sleep(Math.min(backOff * 500, 5_000));
      backOff++;
      if (this.player) {
        const player = await this.player.validate(logger);
        if (player != null) return this.player;
        continue;
      }

      this.player = await this.d2.scanForPlayer(this.playerName, logger);
      if (this.player == null) continue;
      return this.player;
    }
  }

  async updateState(obj: Diablo2Player, logger: LogType): Promise<void> {
    const startTime = process.hrtime.bigint();
    const player = await obj.validate(logger);
    // Player object is no longer validate assume game has exited
    if (player == null) return;

    const path = await obj.getPath(player, logger);
    const act = await obj.getAct(player, logger);
    const stats = await obj.getStats(player, logger);

    // Load ActMisc once to get both mapSeed and difficulty without double-fetching
    const actMisc = act.pActMisc.isValid
      ? await obj.d2.readStrutAt(act.pActMisc.offset, D2rActMiscStrut)
      : null;
    const mapSeed = actMisc?.mapSeed ?? 0;

    this.state.map.act = player.actId;

    // Track map information
    if (mapSeed !== 0 && mapSeed !== this.state.map.id) {
      this.state.map.id = mapSeed;
      this.state.map.difficulty = resolveDifficulty(actMisc, act, logger);
      this.state.log.info({ map: this.state.map }, 'MapSeed:Changed');
      this.state.units.clear();
      this.state.items.clear();
      this.state.kills.clear();
      this.itemIgnore.clear();
      this.state.dirty();
      this.onMapChange?.(mapSeed, this.state.map.difficulty, player.actId);
    }

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

      if (itemData == null || !isRuneCode(itemData.code)) {
        this.itemIgnore.add(itemKey);
        continue;
      }

      const loc = await unit.pPath.fetch(this.d2.process);
      const itemJson: Diablo2ItemJson = {
        type: 'item',
        id: unit.unitId,
        updatedAt: Date.now(),
        name: Diablo2Mpq.t(itemData.code) ?? itemData.code,
        code: itemData.code,
        x: loc.staticX,
        y: loc.staticY,
        quality: { id: 0, name: 'Rune' },
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

function resolveDifficulty(
  actMisc: { difficulty: number } | null,
  act: ActS,
  logger: LogType,
): Difficulty {
  if (actMisc && actMisc.difficulty >= 0 && actMisc.difficulty <= 2) return actMisc.difficulty;

  if (actMisc) logger.warn({ raw: actMisc.difficulty, offset: '0x830' }, 'Player:InvalidDifficulty:FallingBack');
  else logger.error({ offset: toHex(act.pActMisc.offset) }, 'Player:OffsetInvalid:Difficulty');

  if (process.argv.includes('--nightmare')) return Difficulty.Nightmare;
  if (process.argv.includes('--normal')) return Difficulty.Normal;
  return Difficulty.Hell;
}

function isRuneCode(code: string): boolean {
  return /^r\d\d$/.test(code);
}

export function dumpStats(stats: Map<Attribute, number>): void {
  for (const stat of stats) {
    console.log(toHex(stat[0]), Attribute[stat[0]], stat[1]);
  }
}
