/**
 * Lightweight WebSocket client for the overlay.
 * Connects to the @diablo2/map server and receives game state updates.
 * Auto-reconnects on disconnect.
 */

export interface GameState {
  seed: number;
  difficulty: number;
  act: number;
  levelId?: number;
  updatedAt: number;
  player?: GameStatePlayer | null;
  units?: GameStateUnit[];
  items?: GameStateItem[];
  kills?: unknown[];
}

export interface GameStatePlayer {
  x: number;
  y: number;
  name?: string;
  level?: number;
  life?: number;
}

export interface GameStateUnit {
  type: string;
  x: number;
  y: number;
  name?: string;
  life?: number;
  enchants?: number[];
  flags?: number;
}

export interface GameStateItem {
  code: string;
  x: number;
  y: number;
  quality?: number;
  sockets?: number;
  ethereal?: boolean;
  identified?: boolean;
  runeword?: boolean;
}

export interface OverlayWsClientOptions {
  url: string;
  onState: (state: GameState) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  reconnectDelay?: number;
}

export class OverlayWsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onState: (state: GameState) => void;
  private onConnected?: () => void;
  private onDisconnected?: () => void;
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: OverlayWsClientOptions) {
    this.url = opts.url;
    this.onState = opts.onState;
    this.onConnected = opts.onConnected;
    this.onDisconnected = opts.onDisconnected;
    this.reconnectDelay = opts.reconnectDelay ?? 2000;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.closed) return;

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = (): void => {
      console.log('[Overlay WS] Connected to', this.url);
      this.onConnected?.();
    };

    this.ws.onmessage = (ev: MessageEvent): void => {
      try {
        const state: GameState = JSON.parse(ev.data as string);
        this.onState(state);
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = (): void => {
      console.log('[Overlay WS] Disconnected, reconnecting in', this.reconnectDelay, 'ms');
      this.onDisconnected?.();
      this.scheduleReconnect();
    };

    this.ws.onerror = (): void => {
      // onclose will fire after onerror, which handles reconnect
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
  }
}
