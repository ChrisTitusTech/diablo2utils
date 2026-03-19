import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Log } from './logger.js';
import { GameState } from './routes/state.js';
import { currentGameState } from './routes/state.js';

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

function removeClient(ws: WebSocket): void {
  clients.delete(ws);
}

/**
 * Attach a WebSocket server to the existing HTTP server at path `/ws`.
 * Connected browsers receive JSON game-state broadcasts in real time.
 */
export function setupWebSocket(server: http.Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    clients.add(ws);
    Log.info({ clients: clients.size }, 'WS:Connected');

    if (currentGameState.seed > 0) {
      ws.send(JSON.stringify(currentGameState), (err) => {
        if (err) Log.warn({ err: String(err) }, 'WS:SendError');
      });
    }

    ws.on('close', () => {
      removeClient(ws);
      Log.info({ clients: clients.size }, 'WS:Disconnected');
    });

    ws.on('error', (err) => {
      Log.warn({ err: String(err) }, 'WS:Error');
      removeClient(ws);
    });
  });

  Log.info('WS:Ready (path=/ws)');
}

/**
 * Broadcast the current game state to all connected WebSocket clients.
 * Silently drops messages for clients whose send buffer is backed up.
 */
export function broadcastState(state: GameState): void {
  if (clients.size === 0) return;
  const json = JSON.stringify(state);
  const MaxBufferedBytes = 1024 * 64; // 64KB backpressure threshold
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > MaxBufferedBytes) {
      Log.warn({ buffered: ws.bufferedAmount }, 'WS:SlowClient:Skipping');
      continue;
    }
    ws.send(json, (err) => {
      if (err) Log.warn({ err: String(err) }, 'WS:SendError');
    });
  }
}
