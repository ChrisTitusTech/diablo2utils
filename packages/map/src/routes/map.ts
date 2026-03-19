import { Act, ActUtil, Diablo2Level, Diablo2Map, Difficulty, DifficultyUtil, toHex } from '@diablo2/data';
import { MapCluster } from '../map/map.process.js';
import { HttpError, Request, Route } from '../route.js';

export function isInSeedRange(seed: number): boolean {
  return seed > 0 && seed < 0xffffffff;
}

/** Shared param validation for seed + difficulty */
export function validateSeedDifficulty(req: Request): { seed: number; difficulty: number } {
  const seed = Number(req.params.seed);
  if (isNaN(seed) || !isInSeedRange(seed)) throw new HttpError(422, 'Invalid seed');

  const difficulty = DifficultyUtil.fromString(req.params.difficulty);
  if (difficulty == null) throw new HttpError(422, 'Invalid difficulty');

  return { seed, difficulty };
}

/** Dump the entire world for a difficulty/seed */
export class MapRoute implements Route {
  url = '/v1/map/:seed/:difficulty.json';

  async process(req: Request): Promise<Diablo2Map> {
    const { seed, difficulty } = validateSeedDifficulty(req);
    const levels = await MapCluster.map(seed, difficulty, -1, req.log);
    req.log = req.log.child({ seed: toHex(seed, 8), difficulty: Difficulty[difficulty] });
    return { id: req.id, seed, difficulty, levels };
  }
}

/** Grab a specific act for a difficulty */
export class MapActRoute implements Route {
  url = '/v1/map/:seed/:difficulty/:act.json';

  async process(req: Request): Promise<Diablo2Map> {
    const { seed, difficulty } = validateSeedDifficulty(req);
    const act = ActUtil.fromString(req.params.act);
    if (act == null) throw new HttpError(422, 'Invalid act');

    const levels = await MapCluster.map(seed, difficulty, act, req.log);
    req.log = req.log.child({ seed: toHex(seed, 8), difficulty: Difficulty[difficulty], act: Act[act] });
    return { id: req.id, seed, difficulty, levels, act };
  }
}

/** Grab a specific level for an act */
export class MapActLevelRoute implements Route {
  url = '/v1/map/:seed/:difficulty/:act/:level.json';

  async process(req: Request): Promise<Diablo2Map> {
    const { seed, difficulty } = validateSeedDifficulty(req);
    const act = ActUtil.fromString(req.params.act);
    if (act == null) throw new HttpError(422, 'Invalid act');

    const mapId = Number(req.params.level);
    if (isNaN(mapId) || ActUtil.fromLevel(mapId) !== act) throw new HttpError(422, 'Invalid map id');

    const levels = await MapCluster.map(seed, difficulty, act, req.log);
    req.log = req.log.child({ seed: toHex(seed, 8), difficulty: Difficulty[difficulty], act: Act[act], mapId });

    return { id: req.id, seed, difficulty, levels: levels.filter((l) => l.id === mapId), act };
  }
}
