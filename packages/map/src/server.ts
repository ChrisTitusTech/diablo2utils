import cors from 'cors';
import * as express from 'express';
import http from 'http';
import 'source-map-support/register.js';
import * as ulid from 'ulid';
import { Log } from './logger.js';
import { MapCluster } from './map/map.process.js';
import { HttpError, Request, Route } from './route.js';
import { HealthRoute } from './routes/health.js';
import { MapImageRoute } from './routes/map.image.js';
import { MapActLevelRoute, MapActRoute, MapRoute } from './routes/map.js';
import { StateGetRoute, currentGameState } from './routes/state.js';
import { setupWebSocket, broadcastState } from './ws.js';

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
          res.status(200);
          if (Buffer.isBuffer(output)) {
            res.header('content-type', 'image/png');
            res.end(output);
          } else {
            res.json(output);
          }
        }
      } catch (e) {
        if (e instanceof HttpError) {
          req.log.warn(e.message);
          res.status(e.status ?? 500);
          res.json({ id: req.id, message: e.message });
        } else {
          req.log.error({ err: e }, 'Failed to run');
          res.status(500);
          res.json({ id: req.id, message: `Internal server error` });
        }
      }
      const duration = Date.now() - startTime;
      req.log.info({ duration, status: res.statusCode }, req.url);
      next();
    });
  }

  async init(): Promise<void> {
    this.bind(new HealthRoute());
    this.bind(new StateGetRoute());
    this.bind(new MapRoute());
    this.bind(new MapActRoute());
    this.bind(new MapActLevelRoute());
    this.bind(new MapImageRoute());

    // POST /v1/state — memory reader pushes game state updates
    this.server.post('/v1/state', (req: express.Request, res: express.Response) => {
      const body = req.body;
      if (body == null || typeof body !== 'object') {
        res.status(400).json({ message: 'Invalid body' });
        return;
      }
      const seed = Number(body.seed);
      const difficulty = Number(body.difficulty);
      const act = Number(body.act);
      const levelId = Number(body.levelId);

      if (isNaN(seed) || seed <= 0) {
        res.status(422).json({ message: 'Invalid seed' });
        return;
      }
      currentGameState.seed = seed;
      currentGameState.difficulty = isNaN(difficulty) ? currentGameState.difficulty : difficulty;
      currentGameState.act = isNaN(act) ? currentGameState.act : act;
      currentGameState.levelId = isNaN(levelId) ? currentGameState.levelId : levelId;
      currentGameState.updatedAt = Date.now();

      // Accept optional player position, units, items, kills from memory reader
      if (body.player === null) {
        currentGameState.player = undefined;
      } else if (body.player && typeof body.player === 'object') {
        currentGameState.player = body.player;
      }
      if (Array.isArray(body.units)) {
        currentGameState.units = body.units;
      }
      if (Array.isArray(body.items)) {
        currentGameState.items = body.items;
      }
      if (Array.isArray(body.kills)) {
        currentGameState.kills = body.kills;
      }

      // Broadcast to all connected WebSocket clients
      broadcastState(currentGameState);

      Log.info({ seed, difficulty, act, levelId, hasPlayer: currentGameState.player != null }, 'State:Updated');
      res.status(200).json(currentGameState);
    });

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
