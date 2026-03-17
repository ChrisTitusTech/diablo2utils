/**
 * Browser-native WebSocket client for receiving real-time game state
 * from the @diablo2/map server.  Auto-reconnects on disconnect.
 */

export interface WsClientOptions {
  /** Called on every state message from the server */
  onState: (state: any) => void;
  /** Called when the WebSocket connection opens */
  onOpen?: () => void;
  /** Called when the WebSocket connection closes */
  onClose?: () => void;
  /** Called when the WebSocket receives an error */
  onError?: () => void;
  /** Called when a raw WebSocket message is received */
  onMessage?: () => void;
  /** Base URL override; defaults to deriving from window.location */
  url?: string;
  /** Reconnect delay in ms (default 2000) */
  reconnectDelay?: number;
}

export class GameStateWsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onState: (state: any) => void;
  private onOpen?: () => void;
  private onClose?: () => void;
  private onError?: () => void;
  private onMessage?: () => void;
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: WsClientOptions) {
    this.onState = opts.onState;
    this.onOpen = opts.onOpen;
    this.onClose = opts.onClose;
    this.onError = opts.onError;
    this.onMessage = opts.onMessage;
    this.reconnectDelay = opts.reconnectDelay ?? 2000;

    if (opts.url) {
      this.url = opts.url;
    } else {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.url = `${proto}//${window.location.host}/ws`;
    }

    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[WS] connected to', this.url);
      this.onOpen?.();
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      this.onMessage?.();
      try {
        const state = JSON.parse(ev.data);
        this.onState(state);
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      console.log('[WS] disconnected, reconnecting in', this.reconnectDelay, 'ms');
      this.onClose?.();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.onError?.();
      // onclose will fire after this — let it handle reconnect
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
  }

  /** Permanently close the connection and stop reconnecting */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
