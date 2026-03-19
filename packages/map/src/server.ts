import cors from 'cors';
import * as express from 'express';
import http from 'http';
import 'source-map-support/register.js';
import * as ulid from 'ulid';
import { ActUtil, Diablo2Level } from '@diablo2/data';
import { Log } from './logger.js';
import { MapCluster } from './map/map.process.js';
import { HttpError, Request, Route } from './route.js';
import { HealthRoute } from './routes/health.js';
import { MapImageRoute } from './routes/map.image.js';
import { MapActLevelRoute, MapActRoute, MapRoute } from './routes/map.js';
import { StateGetRoute, currentGameState } from './routes/state.js';
import { setupWebSocket, broadcastState } from './ws.js';

function isPointInLevel(level: Diablo2Level, x: number, y: number): boolean {
  return (
    x >= level.offset.x &&
    y >= level.offset.y &&
    x < level.offset.x + level.size.width &&
    y < level.offset.y + level.size.height
  );
}

function resolveLevelFromPoint(levels: Diablo2Level[], x: number, y: number, preferredLevelId?: number): Diablo2Level | null {
  const matches = levels.filter((l) => isPointInLevel(l, x, y));
  if (matches.length === 0) return null;
  if (preferredLevelId != null && preferredLevelId > 0) {
    const preferred = matches.find((l) => l.id === preferredLevelId);
    if (preferred) return preferred;
  }
  // Prefer smallest area (most specific)
  matches.sort((a, b) => a.size.width * a.size.height - b.size.width * b.size.height);
  return matches[0] ?? null;
}

/** Reconcile the player's position against the loaded map levels */
async function reconcileLevel(): Promise<void> {
  const { player, seed, act, levelId = 0, difficulty } = currentGameState;
  if (player == null || typeof player.x !== 'number' || typeof player.y !== 'number') return;
  if (player.x <= 0 || player.y <= 0 || seed <= 0) return;

  try {
    const resolvedAct = levelId > 0 ? (ActUtil.fromLevel(levelId) ?? act) : act;
    const levels = await MapCluster.map(seed, difficulty, resolvedAct, Log);
    const resolved = resolveLevelFromPoint(levels, player.x, player.y, levelId);

    if (resolved != null && resolved.id !== levelId) {
      Log.info(
        { seed, act: resolvedAct, reportedLevelId: levelId, resolvedLevelId: resolved.id, resolvedLevelName: resolved.name, player: { x: player.x, y: player.y } },
        'State:LevelReconciled',
      );
      currentGameState.levelId = resolved.id;
      currentGameState.act = ActUtil.fromLevel(resolved.id) ?? act;
    }
  } catch (err) {
    Log.warn({ err, seed, act, levelId }, 'State:LevelReconcileFailed');
  }
}

/** Handle POST /v1/state from the memory reader */
async function handleStatePost(req: express.Request, res: express.Response): Promise<void> {
  const body = req.body;
  if (body == null || typeof body !== 'object') {
    res.status(400).json({ message: 'Invalid body' });
    return;
  }

  const seed = Number(body.seed);
  if (isNaN(seed) || seed < 0) {
    res.status(422).json({ message: 'Invalid seed' });
    return;
  }

  // seed === 0 signals "game ended" — clear the state so the viewer
  // stops showing stale map data and waits for a new game.
  if (seed === 0) {
    currentGameState.seed = 0;
    currentGameState.player = undefined;
    currentGameState.units = [];
    currentGameState.items = [];
    currentGameState.kills = [];
    currentGameState.levelId = 0;
    currentGameState.updatedAt = Date.now();
    broadcastState(currentGameState);
    Log.info('State:GameEnded');
    res.status(200).json(currentGameState);
    return;
  }

  currentGameState.seed = seed;

  const difficulty = Number(body.difficulty);
  const act = Number(body.act);
  const levelId = Number(body.levelId);
  if (!isNaN(difficulty) && difficulty >= 0 && difficulty <= 2) currentGameState.difficulty = difficulty;
  if (!isNaN(act) && act >= 0 && act <= 4) currentGameState.act = act;
  if (!isNaN(levelId) && levelId >= 0) currentGameState.levelId = levelId;

  if (body.player === null) currentGameState.player = undefined;
  else if (body.player && typeof body.player === 'object') currentGameState.player = body.player;
  if (Array.isArray(body.units)) currentGameState.units = body.units;
  if (Array.isArray(body.items)) currentGameState.items = body.items;
  if (Array.isArray(body.kills)) currentGameState.kills = body.kills;

  // Set updatedAt and broadcast BEFORE reconcileLevel so the viewer gets
  // immediate updates instead of waiting for the WINE map process.
  currentGameState.updatedAt = Date.now();
  broadcastState(currentGameState);

  Log.info({ seed, difficulty, act, levelId, hasPlayer: currentGameState.player != null }, 'State:Updated');
  res.status(200).json(currentGameState);

  // Reconcile level in the background — if the level changes, the next
  // POST cycle will pick it up and broadcast the corrected value.
  reconcileLevel().catch((err) => Log.warn({ err }, 'State:ReconcileFailed'));
}

class Diablo2MapServer {
  server = express.default();
  port = parseInt(process.env.PORT ?? '8899', 10);

  constructor() {
    this.server.use(cors());
    this.server.use(express.json());
  }

  bind(route: Route): void {
    Log.info({ url: route.url }, 'Bind');
    this.server.get(route.url, async (ex: express.Request, res: express.Response, next: express.NextFunction) => {
      const req = ex as Request;
      req.id = ulid.ulid();
      req.log = Log.child({ id: req.id });
      const startTime = Date.now();
      try {
        const output = await route.process(req, res);
        if (output != null) {
          if (Buffer.isBuffer(output)) {
            res.status(200).header('content-type', 'image/png').end(output);
          } else {
            res.status(200).json(output);
          }
        }
      } catch (e) {
        if (e instanceof HttpError) {
          req.log.warn(e.message);
          res.status(e.status ?? 500).json({ id: req.id, message: e.message });
        } else {
          req.log.error({ err: e }, 'Failed to run');
          res.status(500).json({ id: req.id, message: 'Internal server error' });
        }
      }
      req.log.info({ duration: Date.now() - startTime, status: res.statusCode }, req.url);
    });
  }

  async init(): Promise<void> {
    this.bind(new HealthRoute());
    this.bind(new StateGetRoute());
    this.bind(new MapRoute());
    this.bind(new MapActRoute());
    this.bind(new MapActLevelRoute());
    this.bind(new MapImageRoute());

    this.server.post('/v1/state', handleStatePost);

    const httpServer = http.createServer(this.server);
    setupWebSocket(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(this.port, () => {
        Log.info(
          {
            port: this.port,
            url: 'http://localhost:' + this.port,
            ws: 'ws://localhost:' + this.port + '/ws',
            processes: MapCluster.ProcessCount,
            version: process.env.GIT_VERSION,
            hash: process.env.GIT_HASH,
          },
          'Server started...',
        );
        resolve();
      });
    });
  }
}

export const MapServer = new Diablo2MapServer();
