import { Act, ActUtil, Difficulty, DifficultyUtil } from '@diablo2/data';
import { toHex } from 'binparse/build/src/hex.js';
import { LevelBounds } from './bounds.js';
import { MapLayers } from './map.objects.js';
import { registerMapProtocols } from './map.protocol.js';
import { Diablo2GameState, Diablo2ItemJson } from '@diablo2/state';
import { toFeatureCollection } from '@linzjs/geojson';
import { Diablo2MapTiles } from './tile.js';
import { GameStateWsClient } from './ws.client.js';

declare const maplibregl: any;

type ViewerStateSource = 'ws' | 'http';
type DebugConsoleLevel = 'info' | 'warn' | 'error';

interface ViewerDebugEvent {
  time: number;
  kind: string;
  message: string;
  details?: unknown;
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

export class Diablo2MapViewer {
  map: any;
  debugWindow: Window | null = null;
  dropsWindow: Window | null = null;

  color = 'white';
  ctx: Diablo2GameState;
  hasPlayer = false;
  playerStatus = 'Waiting for player';

  /** Zoom level to switch to when the player is centered, nullish to turn off */
  stateZoom = 7;
  /** Should the map follow the player */
  centerOnPlayer = true;
  debugMaxEvents = 60;
  debugEvents: ViewerDebugEvent[] = [];
  debugState = {
    ws: { status: 'connecting', url: '', connectedAt: 0, disconnectedAt: 0, lastMessageAt: 0, messages: 0, lastError: '' },
    http: { lastPollAt: 0, lastSuccessAt: 0, successCount: 0, failureCount: 0, lastError: '', lastStatus: 0 },
    server: {
      source: 'http' as ViewerStateSource,
      receivedAt: 0,
      updatedAt: 0,
      seed: 0,
      difficulty: 0,
      act: 0,
      resolvedAct: 0,
      reportedLevelId: 0,
      playerName: '',
      playerX: 0,
      playerY: 0,
      playerLife: 0,
      hasPlayer: false,
      ignoredInvalidAt: 0,
      ignoredInvalidSource: '' as '' | ViewerStateSource,
      ignoredInvalidSeed: 0,
      ignoredInvalidUpdatedAt: 0,
      ignoredInvalidDifficulty: 0,
      ignoredInvalidAct: 0,
    },
    viewer: {
      seed: 0,
      difficulty: 0,
      act: 0,
      levelId: 0,
      playerX: 0,
      playerY: 0,
      hasPlayer: false,
      zoom: 0,
      mapUrl: '',
    },
    reconcile: {
      requestedAt: 0,
      resolvedAt: 0,
      reportedLevelId: 0,
      reportedLevelName: '',
      inferredLevelId: 0,
      inferredLevelName: '',
      selectedLevelId: 0,
      selectedLevelName: '',
      act: 0,
      requestKey: '',
      error: '',
    },
    mapFetch: {
      lastStartedAt: 0,
      lastFinishedAt: 0,
      okCount: 0,
      errorCount: 0,
      lastUrl: '',
      lastPath: '',
      lastStatus: 0,
      lastError: '',
      lastLevelCount: 0,
    },
    issues: [] as string[],
  };
  lastIssueSignature = '';

  constructor(el: string) {
    this.ctx = new Diablo2GameState('');
    registerMapProtocols(maplibregl);

    this.map = new maplibregl.Map({
      container: el,
      zoom: 0,
      minZoom: 0,
      center: [180, 90],
      style: {
        version: 8,
        id: 'base-style',
        sources: {},
        layers: [],
        glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
        sprite: 'https://nst-guide.github.io/osm-liberty-topo/sprites/osm-liberty-topo',
      },
      accessToken: '',
    });

    (window as any).map = this.map;
    this.installDebugHooks();
    this.recordDebugEvent('viewer:init', 'Viewer initialized', { container: el });

    this.map.on('load', () => {
      this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      this.trackDom();
      this.updateFromUrl();
      this.update();
      this.startWebSocket();
      this.startStatePolling();
    });

    this.map.on('error', (event: any) => {
      const error = event?.error instanceof Error ? event.error.message : event?.error ?? 'Unknown map error';
      this.recordDebugEvent('map:error', 'MapLibre reported an error', { error }, 'error');
    });
  }

  /** WebSocket client for real-time state updates from the map server */
  wsClient: GameStateWsClient | null = null;

  /** Poll the map server for game state updates pushed by the memory reader */
  stateTimer: unknown;
  lastStateUpdatedAt = 0;
  pendingLevelResolveKey = '';
  lastUrl: string | null = null;

  /**
   * Create a canvas-based arrow image and register it with the map
   * for use as the player position marker.
   */
  addPlayerArrowImage(): void {
    const size = 48;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cx = size / 2;
    ctx.clearRect(0, 0, size, size);

    ctx.beginPath();
    ctx.moveTo(cx, 4);
    ctx.lineTo(cx + 16, size - 8);
    ctx.lineTo(cx, size - 16);
    ctx.lineTo(cx - 16, size - 8);
    ctx.closePath();
    ctx.fillStyle = '#000000';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx, 7);
    ctx.lineTo(cx + 13, size - 10);
    ctx.lineTo(cx, size - 17);
    ctx.lineTo(cx - 13, size - 10);
    ctx.closePath();
    ctx.fillStyle = '#00ff88';
    ctx.fill();

    const imageData = ctx.getImageData(0, 0, size, size);
    this.map.addImage('player-arrow', { width: size, height: size, data: imageData.data });
  }

  startWebSocket(): void {
    this.debugState.ws.url = this.getWebSocketUrl();
    this.wsClient = new GameStateWsClient({
      onState: (state) => this.handleStateUpdate(state, 'ws'),
      onOpen: () => {
        this.debugState.ws.status = 'open';
        this.debugState.ws.connectedAt = Date.now();
        this.debugState.ws.lastError = '';
        this.recordDebugEvent('ws:open', 'WebSocket connected', { url: this.debugState.ws.url }, 'info');
      },
      onClose: () => {
        this.debugState.ws.status = 'closed';
        this.debugState.ws.disconnectedAt = Date.now();
        this.recordDebugEvent('ws:close', 'WebSocket disconnected', { url: this.debugState.ws.url }, 'warn');
      },
      onError: () => {
        this.debugState.ws.status = 'error';
        this.debugState.ws.lastError = 'WebSocket error';
        this.recordDebugEvent('ws:error', 'WebSocket error', { url: this.debugState.ws.url }, 'warn');
      },
      onMessage: () => {
        this.debugState.ws.messages += 1;
        this.debugState.ws.lastMessageAt = Date.now();
      },
    });
  }

  handleStateUpdate(state: any, source: ViewerStateSource = 'ws'): void {
    if (!state) return;

    if (state.seed <= 0) {
      const invalidHasPlayer = !!state.player && state.player.x > 0 && state.player.y > 0;
      const hasValidServerState = this.debugState.server.seed > 0 && this.debugState.server.updatedAt > 0;
      if (hasValidServerState) {
        this.debugState.server.ignoredInvalidAt = Date.now();
        this.debugState.server.ignoredInvalidSource = source;
        this.debugState.server.ignoredInvalidSeed = state.seed ?? 0;
        this.debugState.server.ignoredInvalidUpdatedAt = state.updatedAt ?? 0;
        this.debugState.server.ignoredInvalidDifficulty = state.difficulty ?? 0;
        this.debugState.server.ignoredInvalidAct = state.act ?? 0;
      } else {
        this.debugState.server = {
          source,
          receivedAt: Date.now(),
          updatedAt: state.updatedAt ?? 0,
          seed: state.seed ?? 0,
          difficulty: state.difficulty ?? this.debugState.server.difficulty ?? 0,
          act: state.act ?? this.debugState.server.act ?? 0,
          resolvedAct: state.act ?? this.debugState.server.resolvedAct ?? 0,
          reportedLevelId: state.levelId ?? 0,
          playerName: state.player?.name ?? this.debugState.server.playerName,
          playerX: state.player?.x ?? 0,
          playerY: state.player?.y ?? 0,
          playerLife: state.player?.life ?? 0,
          hasPlayer: invalidHasPlayer,
          ignoredInvalidAt: Date.now(),
          ignoredInvalidSource: source,
          ignoredInvalidSeed: state.seed ?? 0,
          ignoredInvalidUpdatedAt: state.updatedAt ?? 0,
          ignoredInvalidDifficulty: state.difficulty ?? 0,
          ignoredInvalidAct: state.act ?? 0,
        };
      }
      this.recordDebugEvent(
        'state:invalid-seed',
        `Ignoring ${source.toUpperCase()} state with invalid seed`,
        {
          seed: state.seed,
          updatedAt: state.updatedAt ?? 0,
          act: state.act ?? 0,
          difficulty: state.difficulty ?? 0,
        },
      );
      this.refreshViewerDebugState();
      this.evaluateSyncIssues();
      this.updateDebugDom();
      return;
    }
    if (state.updatedAt <= this.lastStateUpdatedAt) {
      return;
    }

    this.lastStateUpdatedAt = state.updatedAt;
    const map = this.ctx.state.map;
    const nextLevelId = state.levelId ?? 0;
    const nextAct = nextLevelId > 0 ? (ActUtil.fromLevel(nextLevelId) ?? state.act) : state.act;
    const changed =
      map.id !== state.seed ||
      map.act !== nextAct ||
      map.difficulty !== state.difficulty ||
      (map.levelId ?? 0) !== nextLevelId;

    if (changed) {
      map.id = state.seed;
      map.act = nextAct ?? map.act;
      map.difficulty = state.difficulty ?? map.difficulty;
      map.levelId = nextLevelId;
    }

    const hasPlayer = !!state.player && state.player.x > 0 && state.player.y > 0;
    const previousHasPlayer = this.hasPlayer;
    this.hasPlayer = hasPlayer;
    this.playerStatus = hasPlayer
      ? `Following ${state.player.name || this.ctx.state.player.name || 'player'}`
      : 'Waiting for player';

    this.debugState.server = {
      source,
      receivedAt: Date.now(),
      updatedAt: state.updatedAt ?? 0,
      seed: state.seed ?? 0,
      difficulty: state.difficulty ?? 0,
      act: state.act ?? 0,
      resolvedAct: nextAct ?? state.act ?? 0,
      reportedLevelId: nextLevelId,
      playerName: state.player?.name ?? '',
      playerX: state.player?.x ?? 0,
      playerY: state.player?.y ?? 0,
      playerLife: state.player?.life ?? 0,
      hasPlayer,
      ignoredInvalidAt: 0,
      ignoredInvalidSource: '',
      ignoredInvalidSeed: 0,
      ignoredInvalidUpdatedAt: 0,
      ignoredInvalidDifficulty: 0,
      ignoredInvalidAct: 0,
    };

    if (hasPlayer) {
      this.ctx.state.player.x = state.player.x;
      this.ctx.state.player.y = state.player.y;
      if (state.player.name) this.ctx.state.player.name = state.player.name;
      if (state.player.level) this.ctx.state.player.level = state.player.level;
      if (state.player.life != null) this.ctx.state.player.life = state.player.life;
    } else {
      this.ctx.state.player.x = 0;
      this.ctx.state.player.y = 0;
    }

    this.ctx.state.units = Array.isArray(state.units) && hasPlayer ? state.units : [];
    this.ctx.state.items = Array.isArray(state.items) && hasPlayer ? state.items : [];

    if (changed) {
      this.recordDebugEvent(
        'state:map',
        `Viewer map updated from ${source.toUpperCase()} state`,
        {
          seed: state.seed > 0 ? toHex(state.seed, 8) : 'n/a',
          difficulty: this.formatDifficulty(state.difficulty),
          serverAct: this.formatAct(state.act),
          resolvedAct: this.formatAct(nextAct),
          reportedLevelId: nextLevelId,
        },
        'info',
      );
    }

    if (previousHasPlayer !== hasPlayer) {
      this.recordDebugEvent(
        'state:player',
        hasPlayer ? 'Player position acquired' : 'Player missing from current state',
        { name: state.player?.name ?? this.ctx.state.player.name, x: state.player?.x ?? 0, y: state.player?.y ?? 0 },
        hasPlayer ? 'info' : 'warn',
      );
    }

    this.update();
    void this.reconcileLevelId(state);
  }

  async reconcileLevelId(state: any): Promise<void> {
    if (!state?.player || state.player.x <= 0 || state.player.y <= 0) return;

    const reportedLevelId = state.levelId ?? 0;
    const act = reportedLevelId > 0 ? (ActUtil.fromLevel(reportedLevelId) ?? state.act) : state.act;
    const requestKey = [state.seed, state.difficulty, act, state.player.x, state.player.y, state.updatedAt].join('__');
    this.pendingLevelResolveKey = requestKey;
    this.debugState.reconcile.requestedAt = Date.now();
    this.debugState.reconcile.requestKey = requestKey;
    this.debugState.reconcile.act = act;
    this.debugState.reconcile.reportedLevelId = reportedLevelId;
    this.debugState.reconcile.reportedLevelName = this.formatLevelLabel(reportedLevelId);
    this.debugState.reconcile.error = '';

    try {
      const map = await Diablo2MapTiles.get(state.difficulty, state.seed, act);
      if (this.pendingLevelResolveKey !== requestKey) return;

      const inferredLevel = map.findLevelAtPoint(act, state.player.x, state.player.y, reportedLevelId);
      this.debugState.reconcile.resolvedAt = Date.now();

      if (inferredLevel == null) {
        this.debugState.reconcile.inferredLevelId = 0;
        this.debugState.reconcile.inferredLevelName = 'No containing level found';
        this.evaluateSyncIssues();
        return;
      }

      this.debugState.reconcile.inferredLevelId = inferredLevel.id;
      this.debugState.reconcile.inferredLevelName = inferredLevel.name ?? this.formatLevelLabel(inferredLevel.id);

      const currentLevelId = this.ctx.state.map.levelId ?? 0;
      if (currentLevelId === inferredLevel.id) {
        this.debugState.reconcile.selectedLevelId = currentLevelId;
        this.debugState.reconcile.selectedLevelName = inferredLevel.name ?? this.formatLevelLabel(currentLevelId);
        this.evaluateSyncIssues();
        return;
      }

      this.ctx.state.map.levelId = inferredLevel.id;
      this.debugState.reconcile.selectedLevelId = inferredLevel.id;
      this.debugState.reconcile.selectedLevelName = inferredLevel.name ?? this.formatLevelLabel(inferredLevel.id);
      this.recordDebugEvent(
        'reconcile:level',
        'Viewer level corrected using player coordinates',
        {
          reportedLevelId,
          inferredLevelId: inferredLevel.id,
          inferredLevelName: inferredLevel.name,
          player: { x: state.player.x, y: state.player.y },
        },
        reportedLevelId === inferredLevel.id ? 'info' : 'warn',
      );
      this.update();
    } catch (err) {
      this.debugState.reconcile.error = err instanceof Error ? err.message : String(err);
      this.recordDebugEvent('reconcile:error', 'Level reconciliation failed', { error: this.debugState.reconcile.error }, 'warn');
    } finally {
      this.evaluateSyncIssues();
    }
  }

  startStatePolling(): void {
    const poll = async (): Promise<void> => {
      this.debugState.http.lastPollAt = Date.now();
      try {
        const res = await fetch('/v1/state', { cache: 'no-store' });
        this.debugState.http.lastStatus = res.status;
        if (!res.ok) {
          this.debugState.http.failureCount += 1;
          this.debugState.http.lastError = `HTTP ${res.status} ${res.statusText}`;
          this.recordDebugEvent('http:error', 'State polling failed', { status: res.status, statusText: res.statusText }, 'warn');
          return;
        }
        const state = await res.json();
        this.debugState.http.successCount += 1;
        this.debugState.http.lastSuccessAt = Date.now();
        this.debugState.http.lastError = '';
        this.handleStateUpdate(state, 'http');
      } catch (err) {
        this.debugState.http.failureCount += 1;
        this.debugState.http.lastError = err instanceof Error ? err.message : String(err);
        this.recordDebugEvent('http:error', 'State polling threw an error', { error: this.debugState.http.lastError }, 'warn');
      }
    };

    this.stateTimer = setInterval(poll, 5000);
    poll();
  }

  updateFromUrl(): void {
    const urlParams = new URLSearchParams(window.location.search);
    this.color = urlParams.get('color') || 'white';
  }

  updateMapStyles(): void {
    const state = this.ctx.state;
    const map = state.map;
    const hasValidSeed = Number.isFinite(map.id) && map.id > 0;
    const hasValidDifficulty = Difficulty[map.difficulty] != null;
    const hasValidAct = Act[map.act] != null;

    if (!hasValidSeed || !hasValidDifficulty || !hasValidAct) {
      this.debugState.viewer.mapUrl = '';
      return;
    }

    const levelSuffix = (map.levelId ?? 0) > 0 ? `/${map.levelId}` : '';
    const d2Url = `${toHex(map.id, 8)}/${Difficulty[map.difficulty]}/${Act[map.act]}${levelSuffix}/{z}/{x}/{y}/${this.color}`;
    this.debugState.viewer.mapUrl = d2Url;

    if (this.lastUrl === d2Url) return;
    this.lastUrl = d2Url;

    if (this.map.style && this.map.style.sourceCaches['source-diablo2-collision']) {
      this.map.removeLayer('layer-diablo2-collision');
      this.map.removeSource('source-diablo2-collision');

      for (const layerId of MapLayers.keys()) this.map.removeLayer(layerId);
      this.map.removeSource('source-diablo2-vector');
    }
    this.map.addSource('source-diablo2-collision', { type: 'raster', tiles: [`d2r://${d2Url}`], maxzoom: 14 });
    this.map.addSource('source-diablo2-vector', { type: 'geojson', data: `d2v://${d2Url}` });

    if (this.map.getSource('game-state') == null) {
      this.map.addSource('game-state', { type: 'geojson', data: toFeatureCollection([]) });
    }
    this.map.addLayer({ id: 'layer-diablo2-collision', type: 'raster', source: 'source-diablo2-collision' });

    for (const [layerId, layer] of MapLayers) {
      layer.source = layer.source ?? 'source-diablo2-vector';
      layer.id = layerId;
      layer.name = layerId;
      this.map.addLayer(layer);
    }
  }

  update(): void {
    this.refreshViewerDebugState();
    this.updateDom();
    this.updateMapStyles();
    this.evaluateSyncIssues();

    const state = this.ctx.state;

    if (state.player.x > 0) {
      const { lng, lat } = LevelBounds.sourceToLatLng(state.player.x, state.player.y);
      if (this.centerOnPlayer) {
        this.map.jumpTo({ center: [lng, lat], zoom: this.stateZoom ?? this.map.getZoom() });
      }
      const playerJson: GeoJSON.Feature = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: { ...state.player, type: 'player' },
      };

      const features = [playerJson];
      for (const unit of state.units) {
        const { lng, lat } = LevelBounds.sourceToLatLng(unit.x, unit.y);
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: unit });
      }

      for (const item of state.items) {
        const { lng, lat } = LevelBounds.sourceToLatLng(item.x, item.y);
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: item });
      }
      const playerSource = this.map.getSource('game-state');
      if (playerSource == null) {
        this.map.addSource('game-state', { type: 'geojson', data: toFeatureCollection(features) });
      } else playerSource.setData(toFeatureCollection(features));
    } else {
      const playerSource = this.map.getSource('game-state');
      if (playerSource == null) {
        this.map.addSource('game-state', { type: 'geojson', data: toFeatureCollection([]) });
      } else playerSource.setData(toFeatureCollection([]));
    }
  }

  setAct(a: string): void {
    const act = ActUtil.fromString(a);
    if (act == null || this.ctx.state.map.act === act) return;
    this.ctx.state.map.act = act;
    this.recordDebugEvent('viewer:act', 'Act changed from viewer controls', { act: this.formatAct(act) }, 'info');
    this.update();
  }

  setDifficulty(a: string): void {
    const difficulty = DifficultyUtil.fromString(a);
    if (difficulty == null || this.ctx.state.map.difficulty === difficulty) return;
    this.ctx.state.map.difficulty = difficulty;
    this.recordDebugEvent('viewer:difficulty', 'Difficulty changed from viewer controls', { difficulty: this.formatDifficulty(difficulty) }, 'info');
    this.update();
  }

  trackDom(): void {
    document
      .querySelectorAll<HTMLButtonElement>('button.options__act')
      .forEach((f) => f.addEventListener('click', (): void => this.setAct(f.value)));

    document
      .querySelectorAll<HTMLButtonElement>('button.options__difficulty')
      .forEach((f) => f.addEventListener('click', (): void => this.setDifficulty(f.value)));

    document
      .querySelectorAll<HTMLButtonElement>('button.options__debug')
      .forEach((f) =>
        f.addEventListener('click', (): void => {
          this.openDebugWindow();
        }),
      );

    document
      .querySelectorAll<HTMLButtonElement>('button.options__drops-toggle')
      .forEach((f) =>
        f.addEventListener('click', (): void => {
          this.toggleDropsWindow();
        }),
      );
  }

  updateDom(): void {
    const state = this.ctx.state;
    const acts = document.querySelectorAll('button.options__act') as NodeListOf<HTMLButtonElement>;
    acts.forEach((f: HTMLButtonElement) => {
      if (ActUtil.fromString(f.value) === state.map.act) {
        f.classList.add('button-outline');
        f.classList.remove('button-clear');
      } else {
        f.classList.remove('button-outline');
        f.classList.add('button-clear');
      }
    });

    const seed = document.querySelector('.options__seed') as HTMLDivElement | null;
    if (seed) seed.innerText = toHex(state.map.id, 8);

    const playerStatus = document.querySelector('.options__player-status') as HTMLSpanElement | null;
    if (playerStatus) {
      playerStatus.innerText = this.playerStatus;
      playerStatus.dataset.state = this.hasPlayer ? 'live' : 'waiting';
    }

    const difficulties = document.querySelectorAll('button.options__difficulty') as NodeListOf<HTMLButtonElement>;
    difficulties.forEach((f: HTMLButtonElement) => {
      if (DifficultyUtil.fromString(f.value) === state.map.difficulty) {
        f.classList.add('button-outline');
        f.classList.remove('button-clear');
      } else {
        f.classList.remove('button-outline');
        f.classList.add('button-clear');
      }
    });

    const dropsToggle = document.querySelector('.options__drops-toggle') as HTMLButtonElement | null;
    if (dropsToggle) {
      const dropsWindowOpen = this.isDropsWindowOpen();
      dropsToggle.innerText = dropsWindowOpen ? 'Close Drops' : 'Open Drops';
      dropsToggle.classList.toggle('button-outline', dropsWindowOpen);
      dropsToggle.classList.toggle('button-clear', !dropsWindowOpen);
    }

    this.updateDebugDom();
  }

  isDropsWindowOpen(): boolean {
    return this.dropsWindow != null && !this.dropsWindow.closed;
  }

  toggleDropsWindow(): void {
    if (this.isDropsWindowOpen()) {
      this.closeDropsWindow();
      return;
    }
    this.openDropsWindow();
  }

  openDropsWindow(): void {
    if (this.isDropsWindowOpen()) {
      this.dropsWindow?.focus();
      return;
    }

    const popup = window.open('/drops.html', 'diablo2-drops', 'popup=yes,width=520,height=760,resizable=yes,scrollbars=yes');
    if (popup == null) {
      this.recordDebugEvent('drops:window-blocked', 'Drops window was blocked by the browser, falling back to the drops page', undefined, 'warn');
      window.location.assign('/drops.html');
      return;
    }

    this.dropsWindow = popup;
    popup.addEventListener('beforeunload', () => this.handleDropsWindowClosed(), { once: true });
    popup.focus();
    this.update();
  }

  closeDropsWindow(): void {
    const popup = this.dropsWindow;
    if (popup != null && !popup.closed) popup.close();
    this.handleDropsWindowClosed();
  }

  handleDropsWindowClosed(): void {
    if (this.dropsWindow == null) return;
    this.dropsWindow = null;
    this.update();
  }

  describeDropItem(item: Diablo2ItemJson): string {
    const details: string[] = [];
    if (item.code) details.push(`code=${item.code}`);
    if (item.quality?.name) details.push(`quality=${item.quality.name}`);
    if (item.x != null && item.y != null) details.push(`pos=${item.x},${item.y}`);
    if (item.sockets != null) details.push(`sockets=${item.sockets}`);
    if (item.isEthereal) details.push('ethereal');
    if (item.isIdentified) details.push('identified');
    if (item.isRuneWord) details.push('runeword');
    return `${item.name}${details.length > 0 ? ` — ${details.join(', ')}` : ''}`;
  }

  escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  installDebugHooks(): void {
    window.addEventListener('d2:map-fetch', this.handleMapFetchDebug as EventListener);
    (window as any).D2ViewerDebug = {
      getSnapshot: () => this.buildDebugSnapshot(),
      getEvents: () => this.debugEvents.slice(),
      dump: () => {
        const snapshot = this.buildDebugSnapshot();
        console.log('[D2ViewerDebug] snapshot', snapshot);
        return snapshot;
      },
    };
  }

  handleMapFetchDebug = (event: Event): void => {
    const detail = (event as CustomEvent<MapFetchDebugDetail>).detail;
    if (!detail) return;

    this.debugState.mapFetch.lastUrl = detail.url;
    this.debugState.mapFetch.lastPath = detail.path;

    if (detail.phase === 'start') {
      this.debugState.mapFetch.lastStartedAt = detail.occurredAt;
      this.recordDebugEvent('map-fetch:start', 'Map JSON fetch started', detail);
      return;
    }

    if (detail.phase === 'success') {
      this.debugState.mapFetch.lastFinishedAt = detail.occurredAt;
      this.debugState.mapFetch.okCount += 1;
      this.debugState.mapFetch.lastStatus = detail.status ?? 0;
      this.debugState.mapFetch.lastError = '';
      this.debugState.mapFetch.lastLevelCount = detail.levelCount ?? 0;
      this.recordDebugEvent('map-fetch:success', 'Map JSON fetch completed', detail);
      return;
    }

    this.debugState.mapFetch.lastFinishedAt = detail.occurredAt;
    this.debugState.mapFetch.errorCount += 1;
    this.debugState.mapFetch.lastStatus = detail.status ?? 0;
    this.debugState.mapFetch.lastError = detail.error ?? '';
    this.recordDebugEvent('map-fetch:error', 'Map JSON fetch failed', detail, 'warn');
  };

  recordDebugEvent(kind: string, message: string, details?: unknown, consoleLevel: DebugConsoleLevel | null = null): void {
    this.debugEvents.unshift({ time: Date.now(), kind, message, details });
    if (this.debugEvents.length > this.debugMaxEvents) this.debugEvents.length = this.debugMaxEvents;

    if (consoleLevel === 'error') console.error('[D2ViewerDebug]', message, details ?? '');
    else if (consoleLevel === 'warn') console.warn('[D2ViewerDebug]', message, details ?? '');
    else if (consoleLevel === 'info') console.info('[D2ViewerDebug]', message, details ?? '');
  }

  refreshViewerDebugState(): void {
    const state = this.ctx.state;
    this.debugState.viewer.seed = state.map.id;
    this.debugState.viewer.difficulty = state.map.difficulty;
    this.debugState.viewer.act = state.map.act;
    this.debugState.viewer.levelId = state.map.levelId ?? 0;
    this.debugState.viewer.playerX = state.player.x;
    this.debugState.viewer.playerY = state.player.y;
    this.debugState.viewer.hasPlayer = state.player.x > 0 && state.player.y > 0;
    this.debugState.viewer.zoom = typeof this.map?.getZoom === 'function' ? Number(this.map.getZoom().toFixed(2)) : 0;
  }

  evaluateSyncIssues(): void {
    const issues: string[] = [];
    const server = this.debugState.server;
    const viewer = this.debugState.viewer;
    const reconcile = this.debugState.reconcile;
    const now = Date.now();
    const serverPayloadAge = server.updatedAt > 0 ? now - server.updatedAt : 0;
    const serverReceiveAge = server.receivedAt > 0 ? now - server.receivedAt : 0;

    if (server.seed > 0 && viewer.seed > 0 && server.seed !== viewer.seed) {
      issues.push(`Seed mismatch: server=${toHex(server.seed, 8)} viewer=${toHex(viewer.seed, 8)}`);
    }
    if (server.seed > 0 && viewer.difficulty !== server.difficulty) {
      issues.push(`Difficulty mismatch: server=${this.formatDifficulty(server.difficulty)} viewer=${this.formatDifficulty(viewer.difficulty)}`);
    }
    if (server.seed > 0 && viewer.act !== server.resolvedAct) {
      issues.push(`Act mismatch: server=${this.formatAct(server.resolvedAct)} viewer=${this.formatAct(viewer.act)}`);
    }
    if (server.reportedLevelId > 0 && reconcile.inferredLevelId > 0 && server.reportedLevelId !== reconcile.inferredLevelId) {
      issues.push(`Level mismatch: reported=${server.reportedLevelId} inferred=${reconcile.inferredLevelId}`);
    }
    if (reconcile.inferredLevelId > 0 && viewer.levelId > 0 && viewer.levelId !== reconcile.inferredLevelId) {
      issues.push(`Viewer level drift: viewer=${viewer.levelId} inferred=${reconcile.inferredLevelId}`);
    }
    if (server.updatedAt > 0 && serverPayloadAge > 5000) {
      if (server.receivedAt > 0 && Math.abs(serverReceiveAge - serverPayloadAge) > 2000) {
        issues.push(
          `Server payload is stale (${this.formatAge(server.updatedAt)} old; latest ${server.source.toUpperCase()} transport ${this.formatAge(server.receivedAt)})`,
        );
      } else {
        issues.push(`Server state is stale (${this.formatAge(server.updatedAt)})`);
      }
    }
    if (this.debugState.ws.status !== 'open') {
      issues.push('WebSocket disconnected — relying on HTTP polling');
    }
    if (!server.hasPlayer) {
      issues.push('No player coordinates in the latest server state');
    }
    if (server.ignoredInvalidAt > 0) {
      issues.push(
        `Ignored invalid ${server.ignoredInvalidSource.toUpperCase()} state (${this.formatAge(server.ignoredInvalidAt)}; seed ${server.ignoredInvalidSeed > 0 ? toHex(server.ignoredInvalidSeed, 8) : 'n/a'})`,
      );
    }
    if (this.debugState.mapFetch.lastError) {
      issues.push(`Last map fetch failed: ${this.debugState.mapFetch.lastError}`);
    }
    if (reconcile.error) {
      issues.push(`Reconcile error: ${reconcile.error}`);
    }

    this.debugState.issues = issues;
    const signature = issues.join('|');
    if (signature !== this.lastIssueSignature) {
      this.lastIssueSignature = signature;
      if (issues.length === 0) this.recordDebugEvent('sync:ok', 'Viewer and server state are in sync');
      else this.recordDebugEvent('sync:issues', 'Sync diagnostics changed', { issues }, 'warn');
    }
  }

  buildDebugSnapshot(): Record<string, unknown> {
    return {
      server: {
        ...this.debugState.server,
        seedHex: this.debugState.server.seed > 0 ? toHex(this.debugState.server.seed, 8) : '0x00000000',
        difficultyLabel: this.formatDifficulty(this.debugState.server.difficulty),
        actLabel: this.formatAct(this.debugState.server.resolvedAct),
      },
      viewer: {
        ...this.debugState.viewer,
        seedHex: this.debugState.viewer.seed > 0 ? toHex(this.debugState.viewer.seed, 8) : '0x00000000',
        difficultyLabel: this.formatDifficulty(this.debugState.viewer.difficulty),
        actLabel: this.formatAct(this.debugState.viewer.act),
      },
      ws: this.debugState.ws,
      http: this.debugState.http,
      reconcile: this.debugState.reconcile,
      mapFetch: this.debugState.mapFetch,
      issues: this.debugState.issues.slice(),
      recentEvents: this.debugEvents.slice(0, 20),
    };
  }

  updateDebugDom(): void {
    this.updateDebugDocument(document);

    const debugWindow = this.debugWindow;
    if (!debugWindow || debugWindow.closed) {
      this.debugWindow = null;
      return;
    }

    try {
      this.updateDebugDocument(debugWindow.document);
    } catch (err) {
      this.recordDebugEvent('debug:popup-error', 'Failed to update debug popup', { error: err instanceof Error ? err.message : String(err) }, 'warn');
      this.debugWindow = null;
    }
  }

  updateDebugDocument(doc: Document): void {
    const copyButton = doc.querySelector('.debug-panel__copy') as HTMLButtonElement | null;
    if (copyButton && copyButton.dataset.bound !== 'true') {
      copyButton.dataset.bound = 'true';
      copyButton.addEventListener('click', (): void => {
        void this.copyDebugOutput(doc);
      });
    }

    const summary = doc.querySelector('.debug-panel__summary') as HTMLDivElement | null;
    if (summary) {
      summary.innerText = this.debugState.issues[0] ?? 'Viewer and D2R state are in sync';
      summary.dataset.state = this.debugState.issues.length > 0 ? 'warning' : 'ok';
    }

    const serverEl = doc.querySelector('.debug-panel__server') as HTMLPreElement | null;
    if (serverEl) {
      serverEl.textContent = this.buildServerDebugLines().join('\n');
    }

    const viewerEl = doc.querySelector('.debug-panel__viewer') as HTMLPreElement | null;
    if (viewerEl) {
      viewerEl.textContent = this.buildViewerDebugLines().join('\n');
    }

    const syncEl = doc.querySelector('.debug-panel__sync') as HTMLPreElement | null;
    if (syncEl) {
      syncEl.textContent = this.buildSyncDebugLines().join('\n');
    }

    const eventsEl = doc.querySelector('.debug-panel__events') as HTMLPreElement | null;
    if (eventsEl) {
      eventsEl.textContent = this.buildEventDebugLines().join('\n');
    }
  }

  buildServerDebugLines(): string[] {
    return [
      `source      ${this.debugState.server.source.toUpperCase()} received ${this.formatAge(this.debugState.server.receivedAt)}`,
      `updatedAt    ${this.formatTimestamp(this.debugState.server.updatedAt)} (payload ${this.formatAge(this.debugState.server.updatedAt)})`,
      `ignored     ${this.debugState.server.ignoredInvalidAt > 0 ? `${this.debugState.server.ignoredInvalidSource.toUpperCase()} invalid seed ${this.debugState.server.ignoredInvalidSeed > 0 ? toHex(this.debugState.server.ignoredInvalidSeed, 8) : 'n/a'} @ ${this.formatAge(this.debugState.server.ignoredInvalidAt)}` : 'none'}`,
      `seed         ${this.debugState.server.seed > 0 ? toHex(this.debugState.server.seed, 8) : 'n/a'}`,
      `difficulty   ${this.formatDifficulty(this.debugState.server.difficulty)}`,
      `act          raw=${this.formatAct(this.debugState.server.act)} resolved=${this.formatAct(this.debugState.server.resolvedAct)}`,
      `level        reported=${this.debugState.server.reportedLevelId || 'n/a'} ${this.formatLevelLabel(this.debugState.server.reportedLevelId)}`,
      `player       ${this.debugState.server.playerName || 'n/a'} @ (${this.debugState.server.playerX}, ${this.debugState.server.playerY})`,
      `life         ${this.debugState.server.playerLife || 0}`,
    ];
  }

  buildViewerDebugLines(): string[] {
    return [
      `seed         ${this.debugState.viewer.seed > 0 ? toHex(this.debugState.viewer.seed, 8) : 'n/a'}`,
      `difficulty   ${this.formatDifficulty(this.debugState.viewer.difficulty)}`,
      `act          ${this.formatAct(this.debugState.viewer.act)}`,
      `level        ${this.debugState.viewer.levelId || 'n/a'} ${this.formatLevelLabel(this.debugState.viewer.levelId)}`,
      `player       ${this.debugState.viewer.hasPlayer ? 'tracked' : 'waiting'} @ (${this.debugState.viewer.playerX}, ${this.debugState.viewer.playerY})`,
      `zoom         ${this.debugState.viewer.zoom}`,
      `style url    ${this.debugState.viewer.mapUrl || 'n/a'}`,
    ];
  }

  buildSyncDebugLines(): string[] {
    const issues = this.debugState.issues.length > 0 ? this.debugState.issues.map((issue) => `- ${issue}`) : ['- none'];
    return [
      `ws           ${this.debugState.ws.status} msgs=${this.debugState.ws.messages} last=${this.formatAge(this.debugState.ws.lastMessageAt)}`,
      `http         ok=${this.debugState.http.successCount} fail=${this.debugState.http.failureCount} last=${this.formatAge(this.debugState.http.lastSuccessAt)}`,
      `reconcile    reported=${this.debugState.reconcile.reportedLevelId || 'n/a'} inferred=${this.debugState.reconcile.inferredLevelId || 'n/a'} selected=${this.debugState.reconcile.selectedLevelId || 'n/a'}`,
      `reconcile    ${this.debugState.reconcile.reportedLevelName || 'n/a'} -> ${this.debugState.reconcile.inferredLevelName || 'n/a'} -> ${this.debugState.reconcile.selectedLevelName || 'n/a'}`,
      `map fetch    ok=${this.debugState.mapFetch.okCount} fail=${this.debugState.mapFetch.errorCount} last=${this.debugState.mapFetch.lastPath || 'n/a'}`,
      'issues',
      ...issues,
    ];
  }

  buildEventDebugLines(): string[] {
    return this.debugEvents
      .slice(0, 14)
      .map((event) => `[${new Date(event.time).toLocaleTimeString()}] ${event.kind} ${event.message}`);
  }

  buildDebugText(): string {
    return [
      'Viewer Debug Output',
      `Summary: ${this.debugState.issues[0] ?? 'Viewer and D2R state are in sync'}`,
      '',
      '[Server state]',
      ...this.buildServerDebugLines(),
      '',
      '[Viewer state]',
      ...this.buildViewerDebugLines(),
      '',
      '[Sync diagnostics]',
      ...this.buildSyncDebugLines(),
      '',
      '[Recent events]',
      ...this.buildEventDebugLines(),
    ].join('\n');
  }

  async copyDebugOutput(doc: Document): Promise<void> {
    const text = this.buildDebugText();
    const statusEl = doc.querySelector('.debug-panel__copy-status') as HTMLSpanElement | null;
    const setStatus = (message: string, state: 'ok' | 'error'): void => {
      if (!statusEl) return;
      statusEl.textContent = message;
      statusEl.dataset.state = state;
    };

    try {
      const nav = doc.defaultView?.navigator ?? window.navigator;
      if (nav?.clipboard?.writeText) {
        await nav.clipboard.writeText(text);
      } else {
        const textarea = doc.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        doc.body.appendChild(textarea);
        textarea.select();
        doc.execCommand('copy');
        doc.body.removeChild(textarea);
      }
      setStatus('Copied.', 'ok');
      this.recordDebugEvent('debug:copy', 'Copied debug output to clipboard');
    } catch (err) {
      setStatus('Copy failed.', 'error');
      this.recordDebugEvent('debug:copy-error', 'Failed to copy debug output', { error: err instanceof Error ? err.message : String(err) }, 'warn');
    }
  }

  openDebugWindow(): void {
    const existing = this.debugWindow;
    if (existing && !existing.closed) {
      existing.focus();
      this.updateDebugDocument(existing.document);
      return;
    }

    const popup = window.open('', 'd2-viewer-debug', 'popup=yes,width=980,height=760,resizable=yes,scrollbars=yes');
    if (!popup) {
      this.recordDebugEvent('debug:popup-blocked', 'Debug popup was blocked by the browser', undefined, 'warn');
      return;
    }

    this.debugWindow = popup;
    popup.document.open();
    popup.document.write(this.buildDebugWindowHtml());
    popup.document.close();
    popup.focus();
    this.recordDebugEvent('debug:popup-open', 'Opened debug popup window');
    this.updateDebugDocument(popup.document);
  }

  buildDebugWindowHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Viewer Debug Output</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 14px;
      font-family: 'Roboto Condensed', Arial, sans-serif;
      background: #0e1318;
      color: #d7e3f4;
    }
    .debug-panel__toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    h1 {
      margin: 0;
      font-size: 2rem;
      color: #f7fafc;
    }
    .debug-panel__actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .debug-panel__copy {
      border: 1px solid rgba(255, 255, 255, 0.25);
      background: rgba(255, 255, 255, 0.08);
      color: #f7fafc;
      border-radius: 4px;
      padding: 6px 10px;
      cursor: pointer;
      font: inherit;
      font-size: 0.9rem;
    }
    .debug-panel__copy:hover {
      background: rgba(255, 255, 255, 0.14);
    }
    .debug-panel__copy-status {
      min-width: 72px;
      font-size: 0.85rem;
      color: #a0aec0;
      text-align: right;
    }
    .debug-panel__copy-status[data-state="ok"] { color: #68d391; }
    .debug-panel__copy-status[data-state="error"] { color: #fc8181; }
    .debug-panel__summary {
      font-weight: bold;
      margin-bottom: 10px;
      font-size: 1rem;
    }
    .debug-panel__summary[data-state="ok"] { color: #68d391; }
    .debug-panel__summary[data-state="warning"] { color: #f6ad55; }
    .debug-panel__grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 10px;
    }
    .debug-panel__card {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 6px;
      padding: 10px;
      min-height: 180px;
    }
    .debug-panel__card h5 {
      margin: 0 0 6px;
      color: #f7fafc;
      font-size: 1rem;
    }
    .debug-panel__card pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.82rem;
      line-height: 1.3;
      color: #d7e3f4;
    }
  </style>
</head>
<body>
  <div class="debug-panel__toolbar">
    <h1>Viewer Debug Output</h1>
    <div class="debug-panel__actions">
      <button class="debug-panel__copy" type="button">Copy All</button>
      <span class="debug-panel__copy-status" data-state="ok"></span>
    </div>
  </div>
  <div class="debug-panel__summary" data-state="ok">Viewer and D2R state are in sync</div>
  <div class="debug-panel__grid">
    <div class="debug-panel__card">
      <h5>Server state</h5>
      <pre class="debug-panel__server">Waiting for data…</pre>
    </div>
    <div class="debug-panel__card">
      <h5>Viewer state</h5>
      <pre class="debug-panel__viewer">Waiting for data…</pre>
    </div>
    <div class="debug-panel__card">
      <h5>Sync diagnostics</h5>
      <pre class="debug-panel__sync">Waiting for data…</pre>
    </div>
    <div class="debug-panel__card">
      <h5>Recent events</h5>
      <pre class="debug-panel__events">Viewer initialized</pre>
    </div>
  </div>
</body>
</html>`;
  }

  formatDifficulty(difficulty?: number): string {
    return difficulty == null || Difficulty[difficulty] == null ? `${difficulty ?? 'n/a'}` : Difficulty[difficulty];
  }

  formatAct(act?: number): string {
    return act == null || Act[act] == null ? `${act ?? 'n/a'}` : Act[act];
  }

  formatTimestamp(value: number): string {
    if (!value) return 'n/a';
    return new Date(value).toLocaleTimeString();
  }

  formatAge(value: number): string {
    if (!value) return 'n/a';
    const diff = Math.max(0, Date.now() - value);
    if (diff < 1000) return `${diff}ms ago`;
    return `${(diff / 1000).toFixed(diff < 10000 ? 1 : 0)}s ago`;
  }

  formatLevelLabel(levelId?: number): string {
    if (levelId == null || levelId <= 0) return '';
    const act = ActUtil.fromLevel(levelId);
    return act == null ? `(#${levelId})` : `(${Act[act]} #${levelId})`;
  }

  getWebSocketUrl(): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
}
