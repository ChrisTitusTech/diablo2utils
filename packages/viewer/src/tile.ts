import { Act, ActUtil, Diablo2Level, Diablo2Map } from '@diablo2/data';
import { Difficulty, LruCache } from '@diablo2/data/';
import { toHex } from 'binparse';
import { Bounds, LevelBounds } from './bounds.js';
import { LevelRender } from './render.js';

export interface MapParams {
  seed: number;
  difficulty: number;
  act: number;
  levelId?: number;
  x: number;
  y: number;
  z: number;
  rasterFillColor: string;
}

interface MapFetchDebugDetail {
  phase: 'start' | 'success' | 'error';
  url: string;
  path: string;
  seed: number;
  difficulty: number;
  act: number;
  levelId?: number;
  status?: number;
  statusText?: string;
  error?: string;
  levelCount?: number;
  occurredAt: number;
}

process = typeof process === 'undefined' ? ({ env: {} } as any) : process;
/** Load and create tiles from a remote map host */
export class Diablo2MapTiles {
  static MapHost = typeof window !== 'undefined' ? '' : (process.env.MAP_HOST ?? 'https://diablo2.chard.dev');

  static tiles = new LruCache<Promise<unknown>>(1024);
  static maps = new LruCache<Promise<LevelData>>(32);

  static url(difficulty: Difficulty, seed: number, act: number, levelId?: number): string {
    const base = `v1/map/${toHex(seed, 8)}/${Difficulty[difficulty]}/${Act[act]}`;
    return levelId != null && levelId > 0 ? `${base}/${levelId}.json` : `${base}.json`;
  }

  static get(difficulty: Difficulty, seed: number, act: number, levelId?: number): Promise<LevelData> {
    const mapId = [difficulty, toHex(seed, 8), act, levelId ?? 0].join('__');
    let existing = this.maps.get(mapId);
    if (existing == null) {
      existing = this.fetch(difficulty, seed, act, levelId);
      this.maps.set(mapId, existing);
    }
    return existing;
  }

  static async fetch(difficulty: Difficulty, seed: number, act: number, levelId?: number): Promise<LevelData> {
    const path = Diablo2MapTiles.url(difficulty, seed, act, levelId);
    const url = `${Diablo2MapTiles.MapHost}/${path}`;
    console.log('Fetching', { url });
    this.emitDebug({ phase: 'start', url, path, seed, difficulty, act, levelId, occurredAt: Date.now() });

    const res = await fetch(url);
    if (!res.ok) {
      this.emitDebug({
        phase: 'error',
        url,
        path,
        seed,
        difficulty,
        act,
        levelId,
        status: res.status,
        statusText: res.statusText,
        error: `Failed to fetch: ${url} - ${res.status} - ${res.statusText}`,
        occurredAt: Date.now(),
      });
      throw new Error(`Failed to fetch: ${url} - ${res.status} - ${res.statusText}`);
    }

    const json = await res.json();
    this.emitDebug({
      phase: 'success',
      url,
      path,
      seed,
      difficulty,
      act,
      levelId,
      status: res.status,
      statusText: res.statusText,
      levelCount: Array.isArray(json?.levels) ? json.levels.length : undefined,
      occurredAt: Date.now(),
    });
    return new LevelData(json);
  }

  static emitDebug(detail: MapFetchDebugDetail): void {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') {
      return;
    }
    window.dispatchEvent(new CustomEvent('d2:map-fetch', { detail }));
  }

  static getRaster(d: MapParams): Promise<unknown> {
    const tileId = ['raster', toHex(d.difficulty, 8), Act[d.act], d.seed, d.z, d.x, d.y, d.rasterFillColor].join('__');
    let existing = this.tiles.get(tileId);
    if (existing == null) {
      existing = this.tileRaster(d);
      this.tiles.set(tileId, existing);
    }
    return existing;
  }

  static async tileRaster(d: MapParams): Promise<ArrayBuffer | void> {
    const map = await this.get(d.difficulty, d.seed, d.act, d.levelId);
    // const tileId = ['raster', toHex(d.difficulty, 8), Act[d.act], d.seed, d.z, d.x, d.y].join('__');
    // const startTime = Date.now();

    const bounds = LevelBounds.tileToSourceBounds(d.x, d.y, d.z);
    const zones = map.findMaps(d.act, bounds, d.levelId);

    if (zones.length === 0) return;

    const canvas = document.createElement('canvas') as HTMLCanvasElement;

    const scale = LevelBounds.getScale(d.z);

    canvas.width = LevelBounds.TileSize * 2;
    canvas.height = LevelBounds.TileSize * 2;

    const ctx = canvas.getContext('2d');
    if (ctx == null) return;

    // console.time('RenderLevel:' + tileId);
    for (const zone of zones) LevelRender.render(zone, ctx, bounds, (1 / scale) * 2, d);
    // console.timeEnd('RenderLevel:' + tileId);

    // TODO 99% of the time for rendering a map is this conversion into a PNG
    // When maplibre lets us we should just return a canvas object
    const blob: Blob | null = await new Promise((r) => canvas.toBlob((b) => r(b), 'image/png'));
    if (blob == null) return;
    const buf = blob.arrayBuffer();
    // console.log(tileId, { duration: Date.now() - startTime });
    return buf;
  }
}

export class LevelData {
  data: Diablo2Map;
  levels: Map<number, Diablo2Level> = new Map();
  constructor(data: Diablo2Map) {
    this.data = data;
    for (const level of this.data.levels) this.levels.set(level.id, level);
  }

  static isMapInBounds(mapInfo: Diablo2Level, bounds: Bounds): boolean {
    if (mapInfo.offset.x + mapInfo.size.width < bounds.x) return false;
    if (mapInfo.offset.y + mapInfo.size.height < bounds.y) return false;
    if (mapInfo.offset.x > bounds.x + bounds.width) return false;
    if (mapInfo.offset.y > bounds.y + bounds.height) return false;
    return true;
  }

  static isPointInMap(mapInfo: Diablo2Level, x: number, y: number): boolean {
    if (x < mapInfo.offset.x) return false;
    if (y < mapInfo.offset.y) return false;
    if (x >= mapInfo.offset.x + mapInfo.size.width) return false;
    if (y >= mapInfo.offset.y + mapInfo.size.height) return false;
    return true;
  }

  findLevelAtPoint(act: Act, x: number, y: number, preferredLevelId?: number): Diablo2Level | null {
    const matches: Diablo2Level[] = [];

    for (const map of this.levels.values()) {
      const mapAct = ActUtil.fromLevel(map.id);
      if (mapAct !== act) continue;
      if (!LevelData.isPointInMap(map, x, y)) continue;
      matches.push(map);
    }

    if (matches.length === 0) return null;
    if (preferredLevelId != null && preferredLevelId > 0) {
      const preferred = matches.find((map) => map.id === preferredLevelId);
      if (preferred) return preferred;
    }

    matches.sort((a, b) => a.size.width * a.size.height - b.size.width * b.size.height);
    return matches[0] ?? null;
  }

  findMaps(act: Act, bounds: Bounds, levelId?: number): Diablo2Level[] {
    const output: Diablo2Level[] = [];
    for (const map of this.levels.values()) {
      const mapAct = ActUtil.fromLevel(map.id);
      if (mapAct !== act) continue;
      if (levelId != null && levelId > 0 && map.id !== levelId) continue;
      if (!LevelData.isMapInBounds(map, bounds)) continue;
      output.push(map);
    }

    return output;
  }
}
