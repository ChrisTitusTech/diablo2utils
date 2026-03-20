import { Diablo2Level } from '@diablo2/data';

/**
 * Minimap renderer — draws the Diablo 2 collision map, exits, waypoints,
 * and player position onto a Canvas 2D context with a transparent background.
 *
 * This is a self-contained renderer that does NOT depend on @diablo2/viewer
 * so the overlay package stays lightweight. The rendering logic is adapted
 * from @diablo2/viewer's LevelRender.
 */

export interface MinimapConfig {
  /** Radius of the viewport in game-world units around the player (default 120) */
  viewRadius: number;
  /** Background color/opacity behind the map (default 'rgba(0,0,0,0.45)') */
  bgColor: string;
  /** Walkable-area fill color (default 'rgba(200,200,200,0.65)') */
  mapColor: string;
  /** Exit marker color (default '#e74c3c') */
  exitColor: string;
  /** Waypoint marker color (default '#3498db') */
  waypointColor: string;
  /** Player marker color (default '#2ecc71') */
  playerColor: string;
  /** Marker size in pixels for exits/waypoints (default 6) */
  markerSize: number;
  /** Player dot radius in pixels (default 4) */
  playerSize: number;
  /** Whether to draw a circular mask (default true) */
  circular: boolean;
}

const DefaultConfig: MinimapConfig = {
  viewRadius: 120,
  bgColor: 'rgba(0, 0, 0, 0.45)',
  mapColor: 'rgba(200, 200, 200, 0.65)',
  exitColor: '#e74c3c',
  waypointColor: '#3498db',
  playerColor: '#2ecc71',
  markerSize: 6,
  playerSize: 4,
  circular: true,
};

export class MinimapRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  config: MinimapConfig;

  constructor(canvas: HTMLCanvasElement, config?: Partial<MinimapConfig>) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context from canvas');
    this.ctx = ctx;
    this.config = { ...DefaultConfig, ...config };
  }

  /** Resize the canvas to match its CSS display size (call on window resize). */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Render the minimap centered on the player's position.
   *
   * @param levels   All levels in the current act
   * @param playerX  Player X position in game coordinates
   * @param playerY  Player Y position in game coordinates
   * @param currentLevelId  The level the player is currently in (for highlighting)
   */
  render(levels: Diablo2Level[], playerX: number, playerY: number, currentLevelId?: number): void {
    const { width, height } = this.canvas.getBoundingClientRect();
    const ctx = this.ctx;
    const cfg = this.config;

    // Clear to transparent
    ctx.clearRect(0, 0, width, height);

    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(centerX, centerY);
    const viewRadius = cfg.viewRadius;

    // Scale: how many pixels per game-world unit
    const scale = radius / viewRadius;

    // Define the viewport bounds in game coords
    const boundsX = playerX - viewRadius;
    const boundsY = playerY - viewRadius;
    const boundsW = viewRadius * 2;
    const boundsH = viewRadius * 2;

    // Draw background
    ctx.save();
    if (cfg.circular) {
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
    }

    ctx.fillStyle = cfg.bgColor;
    ctx.fillRect(0, 0, width, height);

    // Render walkable areas for each visible level
    ctx.fillStyle = cfg.mapColor;
    for (const level of levels) {
      if (!this.isLevelVisible(level, boundsX, boundsY, boundsW, boundsH)) continue;
      this.renderLevel(level, ctx, boundsX, boundsY, scale);
    }

    // Render objects (exits, waypoints)
    for (const level of levels) {
      if (!this.isLevelVisible(level, boundsX, boundsY, boundsW, boundsH)) continue;
      this.renderObjects(level, ctx, boundsX, boundsY, scale, cfg);
    }

    // Draw player marker at center
    ctx.fillStyle = cfg.playerColor;
    ctx.beginPath();
    ctx.arc(centerX, centerY, cfg.playerSize, 0, Math.PI * 2);
    ctx.fill();

    // Draw a small directional dot above player
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.beginPath();
    ctx.arc(centerX, centerY - cfg.playerSize - 2, 1.5, 0, Math.PI * 2);
    ctx.fill();

    // Draw circular border
    if (cfg.circular) {
      ctx.restore();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius - 0.5, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.restore();
    }
  }

  /**
   * Render the collision map of a single level.
   * Adapted from @diablo2/viewer's LevelRender.render().
   */
  private renderLevel(
    level: Diablo2Level,
    ctx: CanvasRenderingContext2D,
    boundsX: number,
    boundsY: number,
    scale: number,
  ): void {
    const map = level.map;

    for (let yOffset = 0; yOffset < map.length; yOffset++) {
      const line = map[yOffset];
      if (line.length === 0) continue;

      const worldY = level.offset.y + yOffset;
      const screenY = (worldY - boundsY) * scale;

      let fill = false;
      let worldX = level.offset.x;

      for (let i = 0; i < line.length; i++) {
        const xCount = line[i];
        fill = !fill;

        if (!fill) {
          const screenX = (worldX - boundsX) * scale;
          const w = xCount * scale;
          if (w >= 0.3) {
            ctx.fillRect(screenX, screenY, w, scale);
          }
        }

        worldX += xCount;
      }

      // Handle trailing fill
      const xMax = level.offset.x + level.size.width;
      if (fill && worldX < xMax) {
        const screenX = (worldX - boundsX) * scale;
        ctx.fillRect(screenX, screenY, (xMax - worldX) * scale, scale);
      }
    }
  }

  /**
   * Render exits and waypoints as colored markers.
   */
  private renderObjects(
    level: Diablo2Level,
    ctx: CanvasRenderingContext2D,
    boundsX: number,
    boundsY: number,
    scale: number,
    cfg: MinimapConfig,
  ): void {
    const half = cfg.markerSize / 2;

    for (const obj of level.objects) {
      const worldX = obj.x + level.offset.x;
      const worldY = obj.y + level.offset.y;

      // Skip objects outside viewport
      if (worldX < boundsX || worldX > boundsX + cfg.viewRadius * 2) continue;
      if (worldY < boundsY || worldY > boundsY + cfg.viewRadius * 2) continue;

      const screenX = (worldX - boundsX) * scale;
      const screenY = (worldY - boundsY) * scale;

      if (obj.type === 'exit') {
        ctx.fillStyle = cfg.exitColor;
        ctx.fillRect(screenX - half, screenY - half, cfg.markerSize, cfg.markerSize);

        // Draw exit name if it fits
        if (obj.name && scale > 0.8) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
          ctx.font = '8px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(obj.name, screenX, screenY - half - 2);
        }
      }

      if (obj.type === 'object' && obj.name?.toLowerCase() === 'waypoint') {
        ctx.fillStyle = cfg.waypointColor;
        ctx.fillRect(screenX - half, screenY - half, cfg.markerSize, cfg.markerSize);
      }
    }
  }

  /** Check whether a level's bounding box overlaps with the viewport. */
  private isLevelVisible(
    level: Diablo2Level,
    boundsX: number,
    boundsY: number,
    boundsW: number,
    boundsH: number,
  ): boolean {
    if (level.offset.x + level.size.width < boundsX) return false;
    if (level.offset.y + level.size.height < boundsY) return false;
    if (level.offset.x > boundsX + boundsW) return false;
    if (level.offset.y > boundsY + boundsH) return false;
    return true;
  }
}
