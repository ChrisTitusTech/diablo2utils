import { Act, ActUtil, Difficulty, Diablo2Level, toHex } from '@diablo2/data';
import { MinimapRenderer, MinimapConfig } from './minimap.renderer.js';
import { OverlayWsClient, GameState } from './ws.client.js';

/**
 * Diablo 2 map data response — matches the JSON from GET /v1/map/{seed}/{difficulty}/{act}.json
 */
interface MapResponse {
  levels: Diablo2Level[];
}

export interface OverlayAppOptions {
  /** WebSocket URL for game state (e.g., 'ws://localhost:8899/ws') */
  wsUrl: string;
  /** HTTP base URL for map data (e.g., 'http://localhost:8899') */
  httpBase: string;
  /** Status callback for UI updates */
  onStatus?: (message: string, state: 'connected' | 'error' | 'waiting') => void;
  /** Minimap renderer configuration overrides */
  minimap?: Partial<MinimapConfig>;
  /** HTTP poll interval in ms as fallback (default 5000) */
  pollInterval?: number;
}

export class OverlayApp {
  private renderer: MinimapRenderer;
  private wsClient: OverlayWsClient;
  private options: OverlayAppOptions;

  // Current game state
  private currentSeed = 0;
  private currentDifficulty = 0;
  private currentAct = 0;
  private currentLevelId = 0;
  private playerX = 0;
  private playerY = 0;

  // Map data cache
  private levels: Diablo2Level[] = [];
  private mapCacheKey = '';

  // Polling fallback
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Render loop
  private animFrameId = 0;
  private dirty = true;

  constructor(canvas: HTMLCanvasElement, options: OverlayAppOptions) {
    this.options = options;
    this.renderer = new MinimapRenderer(canvas, options.minimap);

    this.wsClient = new OverlayWsClient({
      url: options.wsUrl,
      onState: (state) => this.onGameState(state),
      onConnected: () => {
        options.onStatus?.('Connected', 'connected');
        // Stop polling when WS is active
        this.stopPolling();
      },
      onDisconnected: () => {
        options.onStatus?.('Reconnecting...', 'waiting');
        // Start polling as fallback
        this.startPolling();
      },
    });
  }

  /** Start the overlay — connects to WS and begins render loop. */
  start(): void {
    this.renderer.resize();
    window.addEventListener('resize', () => {
      this.renderer.resize();
      this.dirty = true;
    });

    this.wsClient.start();
    this.startPolling(); // Start polling initially; will stop once WS connects
    this.renderLoop();
  }

  /** Stop the overlay — disconnects and cancels render loop. */
  stop(): void {
    this.wsClient.stop();
    this.stopPolling();
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
  }

  /** Handle incoming game state from WebSocket or polling. */
  private onGameState(state: GameState): void {
    if (!state || state.seed === 0) {
      this.options.onStatus?.('Waiting for game...', 'waiting');
      return;
    }

    // Derive act from levelId (like the viewer does) since state.act can be stale
    const levelId = state.levelId ?? 0;
    const act = levelId > 0 ? (ActUtil.fromLevel(levelId) ?? state.act) : state.act;

    const mapChanged =
      state.seed !== this.currentSeed ||
      state.difficulty !== this.currentDifficulty ||
      act !== this.currentAct;

    this.currentSeed = state.seed;
    this.currentDifficulty = state.difficulty;
    this.currentAct = act;
    this.currentLevelId = levelId;

    if (state.player) {
      this.playerX = state.player.x;
      this.playerY = state.player.y;
    }

    this.dirty = true;

    if (mapChanged) {
      console.log('[Overlay] Map changed, fetching', Act[act], Difficulty[this.currentDifficulty]);
      this.fetchMap().catch((err) => {
        console.error('[Overlay] Failed to fetch map:', err);
        this.options.onStatus?.('Map fetch failed', 'error');
      });
    }
  }

  /** Fetch map data from the HTTP server for the current seed/difficulty/act. */
  private async fetchMap(): Promise<void> {
    const seed = this.currentSeed;
    const difficulty = this.currentDifficulty;
    const act = this.currentAct;

    const cacheKey = `${seed}_${difficulty}_${act}`;
    if (cacheKey === this.mapCacheKey) return;

    const diffName = Difficulty[difficulty] ?? 'Normal';
    const actName = Act[act] ?? 'ActI';
    const url = `${this.options.httpBase}/v1/map/${toHex(seed, 8)}/${diffName}/${actName}.json`;

    console.log('[Overlay] Fetching map:', url);
    this.options.onStatus?.('Loading map...', 'waiting');

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const data: MapResponse = await res.json();
    this.levels = data.levels ?? [];
    this.mapCacheKey = cacheKey;
    this.dirty = true;

    this.options.onStatus?.(`${this.levels.length} levels loaded`, 'connected');
  }

  /** The render loop — only draws when state has changed. */
  private renderLoop(): void {
    this.animFrameId = requestAnimationFrame(() => this.renderLoop());

    if (!this.dirty) return;
    this.dirty = false;

    if (this.levels.length === 0 || this.currentSeed === 0) return;

    this.renderer.render(this.levels, this.playerX, this.playerY, this.currentLevelId);
  }

  /** Start HTTP polling as a fallback when WebSocket is disconnected. */
  private startPolling(): void {
    if (this.pollTimer) return;
    const interval = this.options.pollInterval ?? 5000;
    this.pollTimer = setInterval(() => this.pollState(), interval);
  }

  /** Stop HTTP polling. */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Poll the map server's state endpoint. */
  private async pollState(): Promise<void> {
    try {
      const res = await fetch(`${this.options.httpBase}/v1/state`);
      if (!res.ok) return;
      const state: GameState = await res.json();
      this.onGameState(state);
    } catch {
      // Silently ignore poll failures — WS reconnect will handle it
    }
  }
}
