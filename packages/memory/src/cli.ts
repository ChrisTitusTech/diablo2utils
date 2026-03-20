import { Diablo2MpqLoader } from '@diablo2/bintools';
import { Act, Difficulty } from '@diablo2/data';
import de from 'dotenv';
import fs from 'fs';
import http from 'http';
import path from 'path';
import 'source-map-support/register.js';
import { fileURLToPath } from 'url';
import { Diablo2Process } from './d2.js';
import { Log } from './logger.js';
import { Diablo2GameSessionMemory } from './session.js';

de.config();

function usage(err?: string): void {
  if (err) console.log(`Error ${err} \n`);
  console.log('Usage: reader [:playerName]\n');
  console.log('  If playerName is omitted, the active player is auto-detected.\n');
}

function getPlayerName(): string | null {
  // argv[0] = node, argv[1] = script path; player name starts at argv[2]
  for (let i = process.argv.length - 1; i >= 2; i--) {
    const arg = process.argv[i];
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return null;
}

function resolveDiablo2Path(): string | null {
  const currentFilePath = fileURLToPath(import.meta.url);
  const candidates = [
    process.env['DIABLO2_PATH'],
    path.resolve(process.cwd(), 'assets/d2'),
    path.resolve(process.cwd(), '../assets/d2'),
    path.resolve(process.cwd(), '../../assets/d2'),
    path.resolve(path.dirname(currentFilePath), '../../../assets/d2'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'd2data.mpq'))) return candidate;
  }

  return null;
}

/** Simple HTTP GET that returns the parsed JSON body. */
function httpGetJson<T = { levels?: unknown[] }>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data) as T);
        } catch {
          reject(new Error(`Invalid JSON from ${url}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

/** POST JSON to a URL (fire-and-forget friendly). */
function httpPostJson(url: string, body: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        res.resume(); // drain
        res.on('end', () => resolve());
      },
    );
    req.on('error', reject);
    req.setTimeout(5_000, () => {
      req.destroy();
      reject(new Error(`Timeout posting ${url}`));
    });
    req.end(data);
  });
}

function buildStatePayload(session: Diablo2GameSessionMemory): Record<string, unknown> | null {
  const json = session.state.toJSON();
  const map = json.map as typeof json.map & { levelId?: number };
  const hasPlayer = json.player.x > 0 && json.player.y > 0;

  return {
    seed: map.id,
    difficulty: map.difficulty,
    act: map.act,
    levelId: map.levelId,
    player: hasPlayer
      ? {
          x: json.player.x,
          y: json.player.y,
          name: json.player.name,
          level: json.player.level,
          life: json.player.life,
        }
      : null,
    units: json.units.map((unit) => ({
      id: unit.id,
      type: unit.type,
      name: unit.name,
      code: 'code' in unit ? unit.code : undefined,
      x: unit.x,
      y: unit.y,
      life: 'life' in unit ? unit.life : undefined,
    })),
    items: json.items.map((item) => ({
      id: item.id,
      type: item.type,
      name: item.name,
      code: item.code,
      x: item.x,
      y: item.y,
      seenAt: item.seenAt,
      quality: item.quality,
      sockets: item.sockets,
      isEthereal: item.isEthereal,
      isIdentified: item.isIdentified,
      isRuneWord: item.isRuneWord,
    })),
    kills: json.kills,
  };
}

/**
 * Fetch map data from the @diablo2/map server for a given seed/difficulty/act.
 * This pre-warms the server cache so maps are instantly available when the user
 * opens the browser.  Fetches all 5 acts in parallel for the current seed.
 */
async function fetchMaps(
  baseUrl: string,
  seed: number,
  difficulty: Difficulty,
  currentAct: number,
): Promise<void> {
  const diffName = Difficulty[difficulty];
  if (diffName == null) return; // invalid difficulty — nothing to fetch
  const diffStr = diffName.toLowerCase();

  // Fetch all 5 acts in parallel so the full seed is cached
  const acts = [0, 1, 2, 3, 4];
  const results = await Promise.allSettled(
    acts.map(async (actId) => {
      const url = `${baseUrl}/v1/map/${seed}/${diffStr}/${actId}.json`;
      const data = await httpGetJson(url);
      return { actId, levels: Array.isArray(data.levels) ? data.levels.length : 0 };
    }),
  );

  const summary: string[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const actName = Act[r.value.actId] ?? `Act${r.value.actId + 1}`;
      summary.push(`${actName}=${r.value.levels}`);
    } else {
      summary.push(`err`);
    }
  }

  const viewUrl = `${baseUrl}/v1/map/${seed}/${diffStr}/${currentAct}.json`;
  Log.info(
    { seed, difficulty: diffStr, maps: summary.join(' '), viewUrl },
    'Map:Fetched',
  );
  console.log(`\n  Maps cached: ${summary.join(', ')}`);
  console.log(`  Current act: ${viewUrl}\n`);
}

async function main(): Promise<void> {
  const playerName = getPlayerName();

  const diablo2Path = resolveDiablo2Path();
  if (diablo2Path) {
    await Diablo2MpqLoader.load(diablo2Path, Log);
  } else {
    Log.warn({ cwd: process.cwd() }, 'Process:MpqPathNotFound');
  }

  const proc = await Diablo2Process.find();

  Log.info({ procId: proc.process.pid }, 'Process:Found');

  // Scan D2R's memory for the items table to get correct txtFileNo → code mapping.
  // D2R may have different item indices than classic D2 1.13c MPQ data
  // (e.g., Sunder Charms and other additions shift the indices).
  await proc.initD2RItems(Log);

  const session = new Diablo2GameSessionMemory(proc, playerName ?? undefined);

  if (playerName) {
    Log.info({ player: playerName }, 'Player:Manual');
  } else {
    Log.info({}, 'Player:AutoDetect (no name specified)');
  }

  // When the map seed changes, automatically fetch maps from the @diablo2/map
  // server to pre-warm its cache.  The server must be running separately
  // (see packages/map/run.sh).
  // Set MAP_SERVER_URL env var to override the default (e.g. "http://localhost:8899").
  const mapServerUrl = (process.env['MAP_SERVER_URL'] ?? 'http://localhost:8899').replace(/\/$/, '');

  session.onMapChange = (seed: number, difficulty: Difficulty, act: number): void => {
    const diffName = Difficulty[difficulty];
    if (diffName == null) {
      Log.warn({ seed, difficulty, act }, 'Map:Changed:InvalidDifficulty (ignoring)');
      return;
    }
    const diffStr = diffName.toLowerCase();
    const url = `${mapServerUrl}/v1/map/${seed}/${diffStr}/${act}.json`;
    Log.info({ seed, difficulty: diffName, act, url }, 'Map:Changed');

    // Fire-and-forget: fetch all acts from the map server in the background.
    // This pre-warms the map cache so a browser refresh is instant.
    fetchMaps(mapServerUrl, seed, difficulty, act).catch((err) => {
      Log.warn({ err: String(err) }, 'Map:FetchFailed (is the map server running?)');
      // Still show the URL so the user can open it manually later
      console.log(`\n  Map layout: ${url}  (fetch failed — is the map server running?)\n`);
    });
  };

  let statePostInFlight = false;
  let statePostPending = false;

  const pushState = (): void => {
    const payload = buildStatePayload(session);
    if (payload == null) return;

    if (statePostInFlight) {
      statePostPending = true;
      return;
    }

    statePostInFlight = true;
    httpPostJson(`${mapServerUrl}/v1/state`, payload)
      .catch((err) => Log.trace({ err: String(err) }, 'State:PushFailed'))
      .finally(() => {
        statePostInFlight = false;
        if (statePostPending) {
          statePostPending = false;
          pushState();
        }
      });
  };

  session.state.onChange = (): void => {
    pushState();
  };

  await session.start(Log);
}

main().catch((e) => Log.fatal(e, 'FailedToRun'));
