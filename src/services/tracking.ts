import { invoke } from '@tauri-apps/api/core';
import { Position, MapType, MAP_DIMENSIONS } from '../core/types';
import { getMinimapBounds, MinimapBounds } from '../core/map-calibration';
import { ChampionClassifier } from './champion-classifier';
import {
  computeMaxJumpPx,
  computeReacquireThreshold,
  pickBestBlobInRange,
  pickClassifierReacquisition,
  ScoreFns,
  // v0.3: CV tracking tweaks driven by IXAM's v0.1.33 issue #7 logs
  // (v0.3.1 reverted the classifier-confidence-dependent ones — see below)
  nextClassifierEma,
  shouldForceReacquisition,
  computeNearFieldPx,
  computeViewportCenter,
  FORCED_REACQUIRE_HOLD_MS,
} from './tracking-helpers';

export enum TrackingState {
  SCANNING = 'scanning',
  LOCKED = 'locked',
  DEAD = 'dead',
}

import type { Blob } from './blob-types';

export class TrackingService {
  private state: TrackingState = TrackingState.SCANNING;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly captureBounds: MinimapBounds;
  private screenWidth: number;
  private screenHeight: number;
  private mapType: MapType;
  private intervalId: number | null = null;
  private onPositionUpdate: ((pos: Position) => void) | null = null;

  // Minimap region (detected or set by calibration/config)
  private minimapRegion: { x: number; y: number; width: number; height: number } | null = null;
  private userMinimapRegion: { x: number; y: number; width: number; height: number } | null = null;
  private configMinimapScale: number | null = null;

  // Tracking state
  private lastPixelPos: { x: number; y: number } | null = null;
  private lastPosition: Position | null = null;
  private lastPositionUpdateMs = 0;
  private deathPosition: Position | null = null;
  private expectedIconDiam = 0;

  // Velocity prediction (smoothed over recent frames)
  private velocityX = 0;
  private velocityY = 0;

  // Known peer positions in region-relative pixel coordinates (from signaling broadcasts)
  // Used as soft penalty: blobs near a known peer are less likely to be "self"
  private peerPixelPositions: { x: number; y: number }[] = [];

  // Frame counter during SCANNING (warmup before lock-on)
  private scanFrameCount = 0;

  // Filtered image for overlay debug display
  private filteredImageUrl: string | null = null;
  private lastDebugImageMs = 0;

  // Champion classifier (ONNX model)
  private classifier: ChampionClassifier | null = null;
  // Cached classifier scores per blob (refreshed periodically, not every frame)
  private classifierScores: Map<string, number> = new Map();
  // EMA-smoothed classifier scores to dampen single-frame misclassifications
  private smoothedClassifierScores: Map<string, number> = new Map();
  private lastClassifierRunMs = 0;
  private lastClassifierLogMs = 0;
  private classifierRunning = false;

  // Debug canvas (reused to avoid allocation per frame)
  private debugCanvas: HTMLCanvasElement | null = null;
  private debugCtx: CanvasRenderingContext2D | null = null;

  // Tick guard + timing — all the per-frame constants are scaled against
  // TUNED_FPS so behavior is invariant when scan rate changes.
  private tickRunning = false;
  private lastTickMs = 0;
  private lastDtSec = 1 / 8; // seconds between this tick and the previous one
  private scanStartMs = 0;
  private holdStartMs = 0;
  // When we successfully tracked a blob that moved >3px from last tick.
  // Used to make Phase 2 re-acquisition stricter when stationary, so we don't
  // teleport the tracking dot onto a minion wave / turret if the icon flickers.
  private lastMovementMs = 0;
  private static readonly TUNED_FPS = 8;

  // Diagnostics
  private lockedTickCount = 0;
  private diagCounter = 0;
  private scanFps = 30;

  constructor(screenWidth: number, screenHeight: number, mapType: MapType) {
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;
    this.captureBounds = getMinimapBounds(screenWidth, screenHeight);
    this.mapType = mapType;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.captureBounds.width;
    this.canvas.height = this.captureBounds.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  /** Send capture bounds to the Tauri backend for screen capture cropping */
  async initCaptureBounds(): Promise<void> {
    await invoke('set_capture_bounds', {
      bounds: {
        x: this.captureBounds.x,
        y: this.captureBounds.y,
        width: this.captureBounds.width,
        height: this.captureBounds.height,
      },
    });
  }

  getState(): TrackingState { return this.state; }
  getLastPosition(): Position | null { return this.lastPosition; }

  /**
   * Centre of League's camera viewport in game coordinates, or null when the
   * rectangle isn't currently identifiable on the minimap. Independent of the
   * tracking state machine — this is where the player is LOOKING, not where
   * their champion is. See docs/compliance.md for why the two are kept apart.
   */
  getCameraPosition(): Position | null { return this.cameraPosition; }

  /**
   * Enable/disable camera-viewport detection. Off costs nothing — the scan is
   * two extra passes over the mask per frame, so it only runs when someone is
   * actually listening from their camera. Driven by the orchestrator so the
   * tracker doesn't need to know about user preferences.
   */
  setCameraTracking(enabled: boolean): void {
    if (this.cameraTrackingEnabled === enabled) return;
    this.cameraTrackingEnabled = enabled;
    if (!enabled) this.cameraPosition = null;
  }

  private updateCameraPosition(
    viewportMask: Uint8Array,
    region: { x: number; y: number; width: number; height: number },
  ): void {
    if (!this.cameraTrackingEnabled) return;
    const centre = computeViewportCenter(viewportMask, region.width, region.height);
    this.cameraPosition = centre
      ? this.pixelToGamePosition(region.x + centre.cx, region.y + centre.cy, region)
      : null;
  }

  // Single chokepoint for lastPosition writes so we can flag impossible
  // jumps (recall/TP is fine; CV mis-tracking the icon to a wrong location
  // looks identical in raw output and is a primary suspect for the
  // "loud voice from far away" symptom).
  //
  // Two conditions must both hold to warn:
  //   • distance > MIN_JUMP_UNITS — filters out per-tick pixel jitter on a
  //     stationary champion (≈1px on the minimap can be 50-100 game-units;
  //     at 50ms tick that registers as 2000+ u/s but isn't a real jump).
  //   • speed > MIN_JUMP_SPEED   — filters out fast-but-legit champion
  //     movement (Hecarim ult / Master Yi Q top out around 800 u/s; recalls
  //     and CV mis-tracks are 10x faster).
  // Without the distance gate, the v0.1.23-v0.1.29 threshold spammed ~100
  // warnings per 5-minute session of normal walking.
  private static readonly JUMP_WARN_MIN_UNITS = 500;
  private static readonly JUMP_WARN_MIN_SPEED = 2000;
  private setLastPosition(newPos: Position, source: string): void {
    if (this.lastPosition && this.lastPositionUpdateMs > 0) {
      const dx = newPos.x - this.lastPosition.x;
      const dy = newPos.y - this.lastPosition.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const dt = Math.max(0.05, (performance.now() - this.lastPositionUpdateMs) / 1000);
      const speed = dist / dt;
      if (dist > TrackingService.JUMP_WARN_MIN_UNITS && speed > TrackingService.JUMP_WARN_MIN_SPEED) {
        console.warn('[Tracking] WARN: position jumped ' + Math.round(dist) +
          ' units in ' + dt.toFixed(2) + 's (' + Math.round(speed) + ' u/s) via ' + source +
          ' — recall/TP or CV mis-tracking. (' +
          Math.round(this.lastPosition.x) + ',' + Math.round(this.lastPosition.y) + ') -> (' +
          Math.round(newPos.x) + ',' + Math.round(newPos.y) + ')');
      }
    }
    this.lastPosition = newPos;
    this.lastPositionUpdateMs = performance.now();
  }
  getFilteredImageUrl(): string | null { return this.filteredImageUrl; }
  /** Seconds since the last successful frame-to-frame lock, or 0 if currently tracking. */
  getHoldDurationSec(): number {
    return this.holdStartMs > 0 ? (performance.now() - this.holdStartMs) / 1000 : 0;
  }

  /** Get the minimap bounds in screen coordinates */
  getDetectedMinimapScreenBounds(): { screenX: number; screenY: number; screenWidth: number; screenHeight: number } | null {
    if (!this.minimapRegion) return null;
    return {
      screenX: this.captureBounds.x + this.minimapRegion.x,
      screenY: this.captureBounds.y + this.minimapRegion.y,
      screenWidth: this.minimapRegion.width,
      screenHeight: this.minimapRegion.height,
    };
  }

  /**
   * Set the minimap region from League's MinimapScale config value (0.0 - 3.0).
   * Calibrated from real measurements:
   *   1080p: scale 0 → 200px, scale 3 → 420px
   *   1440p: scale 0 → 280px, scale 3 → 560px
   * Formula: minimapSize = (h*2/9 - 40) + scale * (h/18 + 40/3)
   */
  setMinimapScaleFromConfig(scale: number): void {
    this.configMinimapScale = scale;

    const h = this.screenHeight;
    const base = h * 2 / 9 - 40;          // size at scale 0
    const rate = h / 18 + 40 / 3;         // additional size per scale unit
    const minimapSize = Math.round(base + scale * rate);

    // The minimap is anchored to the bottom-right of the screen.
    const screenMinimapX = this.screenWidth - minimapSize;
    const screenMinimapY = this.screenHeight - minimapSize;
    const region = {
      x: screenMinimapX - this.captureBounds.x,
      y: screenMinimapY - this.captureBounds.y,
      width: minimapSize,
      height: minimapSize,
    };

    this.minimapRegion = region;
    this.expectedIconDiam = Math.round(minimapSize * 0.087);
    console.log('[Tracking] Minimap from config: scale=' + scale +
      ' size=' + minimapSize + 'px' +
      ' screenPos=(' + screenMinimapX + ',' + screenMinimapY + ')' +
      ' region=' + JSON.stringify(region) +
      ' iconDiam=' + this.expectedIconDiam);

    this.state = TrackingState.SCANNING;
    this.lastPixelPos = null;
    this.lockedTickCount = 0;
    this.scanFrameCount = 0;
    this.scanStartMs = performance.now();
    this.holdStartMs = 0;
  }

  setMinimapRegion(region: { x: number; y: number; width: number; height: number } | null): void {
    this.userMinimapRegion = region;
    if (region) {
      this.minimapRegion = region;
      this.expectedIconDiam = Math.round(region.width * 0.087);
      console.log('[Tracking] Minimap set by calibration:', JSON.stringify(region), 'iconDiam:', this.expectedIconDiam);
    } else {
      this.minimapRegion = null;
    }
    this.state = TrackingState.SCANNING;
    this.lastPixelPos = null;
    this.lockedTickCount = 0;
    this.scanFrameCount = 0;
    this.scanStartMs = performance.now();
    this.holdStartMs = 0;
  }

  loadChampionTemplate(_championName: string): void {
    console.log('[Tracking] Using color filter + blob detection');
  }

  setClassifier(classifier: ChampionClassifier): void {
    this.classifier = classifier;
    console.log('[Tracking] Champion classifier set');
  }

  /**
   * Update known peer positions (from signaling broadcasts).
   * Converts game-unit positions to region-relative minimap pixel coordinates.
   * These are used as a soft penalty: blobs near a known peer are less likely to be "self".
   */
  setPeerGamePositions(positions: Position[]): void {
    if (!this.minimapRegion) {
      this.peerPixelPositions = [];
      return;
    }
    const dims = MAP_DIMENSIONS[this.mapType];
    const region = this.minimapRegion;
    this.peerPixelPositions = positions
      .filter(p => p.x > 0 && p.y > 0)
      .map(p => ({
        x: (p.x / dims.width) * region.width,
        y: ((dims.height - p.y) / dims.height) * region.height,
      }));
  }

  /**
   * Score how close a blob is to any known peer position.
   * Returns 0.0 if right on top of a peer, 1.0 if far from all peers.
   * Used as a soft factor in blob scoring — NOT a hard exclusion.
   */
  private peerAvoidanceScore(blob: Blob): number {
    if (this.peerPixelPositions.length === 0) return 1.0;
    const threshold = this.expectedIconDiam * 1.5; // within 1.5 icon diameters
    const thresholdSq = threshold * threshold;
    let minDistSq = Infinity;
    for (const pp of this.peerPixelPositions) {
      const dx = blob.cx - pp.x;
      const dy = blob.cy - pp.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < minDistSq) minDistSq = distSq;
    }
    if (minDistSq >= thresholdSq) return 1.0;
    // Linear falloff: 0 at distance 0, 1 at threshold
    return Math.sqrt(minDistSq) / threshold;
  }

  /**
   * Run the champion classifier on teal blobs and cache the "local champion confidence" per blob.
   * Called every few frames (not every frame) to amortize ONNX inference cost.
   * Scores are cached by blob center (cx,cy) for fuzzy lookup.
   */
  private async updateClassifierScores(
    tealBlobs: Blob[],
    imageData: ImageData,
    region: { x: number; y: number; width: number; height: number },
  ): Promise<void> {
    if (!this.classifier || !this.classifier.isLoaded()) return;

    const crops = tealBlobs.map(b => ({
      cropX: region.x + b.minX - 1,
      cropY: region.y + b.minY - 1,
      cropW: b.maxX - b.minX + 3,
      cropH: b.maxY - b.minY + 3,
    }));

    try {
      const rawScores = await this.classifier.scoreBlobsForLocalChampion(imageData, crops);

      // Normalize scores across blobs: the model may have low absolute confidence
      // but still correctly RANK blobs. Normalizing makes relative differences useful.
      // E.g., raw [0.067, 0.000] → normalized [1.0, 0.0]
      // Minimum raw threshold: if no blob exceeds this, the model is saying none of them
      // match the local champion — don't inflate via normalization (prevents single wrong
      // blob from getting cls=1.0 just because it's the only one detected).
      const MIN_RAW_THRESHOLD = 0.005;
      const maxRaw = Math.max(...rawScores);
      const normalizedScores = maxRaw >= MIN_RAW_THRESHOLD
        ? rawScores.map(s => s / maxRaw)
        : rawScores.map(() => 0);

      // Apply EMA smoothing to prevent single-frame misclassifications from flipping scores.
      // Alpha=0.4 means ~60% prior + 40% new observation — dampens noise while still adapting.
      const EMA_ALPHA = 0.4;
      const tolerance = Math.max(5, this.expectedIconDiam * 0.6);
      const toleranceSq = tolerance * tolerance;

      this.classifierScores.clear();
      for (let i = 0; i < tealBlobs.length; i++) {
        const key = tealBlobs[i].cx + ',' + tealBlobs[i].cy;
        const norm = normalizedScores[i];

        // Find closest prior smoothed score (blobs shift slightly between frames)
        let priorSmoothed = -1;
        let bestDistSq = Infinity;
        for (const [sKey, sVal] of this.smoothedClassifierScores) {
          const [sx, sy] = sKey.split(',').map(Number);
          const dx = tealBlobs[i].cx - sx;
          const dy = tealBlobs[i].cy - sy;
          const dSq = dx * dx + dy * dy;
          if (dSq < toleranceSq && dSq < bestDistSq) {
            bestDistSq = dSq;
            priorSmoothed = sVal;
          }
        }

        const smoothed = priorSmoothed >= 0
          ? nextClassifierEma(priorSmoothed, norm, 1 - EMA_ALPHA)
          : norm; // first observation: use raw normalized
        this.classifierScores.set(key, smoothed);
      }

      // Update smoothed scores map for next frame
      this.smoothedClassifierScores.clear();
      for (const [key, val] of this.classifierScores) {
        this.smoothedClassifierScores.set(key, val);
      }

      // Diagnostic log every ~30s, independent of scan rate
      const now = performance.now();
      if (now - this.lastClassifierLogMs >= 30000) {
        this.lastClassifierLogMs = now;
        const details = tealBlobs.map((b, i) =>
          '(' + b.cx + ',' + b.cy + ')raw=' + rawScores[i].toFixed(3) +
          '/ema=' + (this.classifierScores.get(b.cx + ',' + b.cy) ?? 0).toFixed(2)
        ).join(' | ');
        console.log('[Tracking] Classifier scores: ' + details);
      }
    } catch (e) {
      console.error('[Tracking] Classifier inference failed:', e);
    }
  }

  /**
   * Get cached classifier score for a blob.
   * Uses fuzzy matching: finds the closest cached blob center within icon diameter.
   */
  private getClassifierScore(blob: Blob): number {
    // Exact match first
    const exact = this.classifierScores.get(blob.cx + ',' + blob.cy);
    if (exact !== undefined) return exact;

    // Fuzzy match: find closest cached center within icon diameter tolerance
    const tolerance = Math.max(5, this.expectedIconDiam * 0.6);
    const toleranceSq = tolerance * tolerance;
    let bestScore = 0;
    let bestDistSq = Infinity;
    for (const [key, score] of this.classifierScores) {
      const [kx, ky] = key.split(',').map(Number);
      const dx = blob.cx - kx;
      const dy = blob.cy - ky;
      const distSq = dx * dx + dy * dy;
      if (distSq < toleranceSq && distSq < bestDistSq) {
        bestDistSq = distSq;
        bestScore = score;
      }
    }
    return bestScore;
  }

  /** Current scan rate in FPS, so callers can skip a no-op restart. */
  getScanFps(): number { return this.scanFps; }

  start(onPositionUpdate: (pos: Position) => void, fps: number = 30): void {
    this.onPositionUpdate = onPositionUpdate;
    this.scanFps = fps;
    const intervalMs = Math.max(1, Math.round(1000 / fps));
    const now = performance.now();
    this.lastTickMs = now;
    this.scanStartMs = now;
    this.holdStartMs = 0;
    this.lastDebugImageMs = 0;
    this.lastClassifierRunMs = 0;
    this.lastClassifierLogMs = 0;
    this.tickRunning = false;
    this.intervalId = window.setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  onDeath(): void {
    if (this.state === TrackingState.DEAD) return;
    this.deathPosition = this.lastPosition;
    this.state = TrackingState.DEAD;
  }

  onRespawn(): void {
    if (this.state !== TrackingState.DEAD) return;
    this.state = TrackingState.SCANNING;
    this.lastPixelPos = null;
    this.deathPosition = null;
    this.lockedTickCount = 0;
    this.scanFrameCount = 0;
    this.scanStartMs = performance.now();
    this.holdStartMs = 0;
  }

  // --- Color classification ---

  /** Classify a pixel as teal (ally border), red (enemy border), or null */
  private classifyPixel(r: number, g: number, b: number): 0 | 1 | 2 {
    // Teal/cyan ally border: low red, high green+blue
    if (r < 100 && g > 120 && b > 120 && (g + b) > 280) return 1;
    // Red enemy border: high red, low green+blue
    if (r > 140 && g < 100 && b < 100) return 2;
    return 0;
  }

  // --- Binary mask creation from minimap region ---

  private createMask(imageData: ImageData, region: { x: number; y: number; width: number; height: number }): Uint8Array {
    const { data, width } = imageData;
    const w = region.width;
    const h = region.height;
    const mask = new Uint8Array(w * h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const srcIdx = ((region.y + y) * width + (region.x + x)) * 4;
        mask[y * w + x] = this.classifyPixel(data[srcIdx], data[srcIdx + 1], data[srcIdx + 2]);
      }
    }

    return mask;
  }

  /** Dilate the mask to connect 1-pixel gaps in icon borders */
  private dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
    const result = new Uint8Array(mask);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (result[idx]) continue;
        // Spread from 4-connected neighbors (same color only)
        const up = mask[(y - 1) * w + x];
        const dn = mask[(y + 1) * w + x];
        const lt = mask[y * w + x - 1];
        const rt = mask[y * w + x + 1];
        // Pick the first nonzero neighbor color
        result[idx] = up || dn || lt || rt;
      }
    }
    return result;
  }

  // --- Connected component (flood-fill) blob detection ---

  private findBlobs(mask: Uint8Array, w: number, h: number): Blob[] {
    const visited = new Uint8Array(w * h);
    const blobs: Blob[] = [];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (visited[idx] || mask[idx] === 0) continue;

        const targetVal = mask[idx];
        const color: 'teal' | 'red' = targetVal === 1 ? 'teal' : 'red';
        const stack: number[] = [x, y];
        let sumX = 0, sumY = 0, count = 0;
        let minX = x, maxX = x, minY = y, maxY = y;

        while (stack.length > 0) {
          const cy = stack.pop()!;
          const cx = stack.pop()!;
          if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
          const ci = cy * w + cx;
          if (visited[ci] || mask[ci] !== targetVal) continue;

          visited[ci] = 1;
          sumX += cx;
          sumY += cy;
          count++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          stack.push(cx - 1, cy, cx + 1, cy, cx, cy - 1, cx, cy + 1);
        }

        if (count >= 10) {
          const bboxArea = (maxX - minX + 1) * (maxY - minY + 1);
          blobs.push({
            color,
            pixels: count,
            cx: Math.round(sumX / count),
            cy: Math.round(sumY / count),
            minX, maxX, minY, maxY,
            fillRatio: bboxArea > 0 ? count / bboxArea : 1,
          });
        }
      }
    }

    return blobs;
  }

  /** Filter blobs to those matching champion icon rings (not towers or minion clusters) */
  private filterIconBlobs(blobs: Blob[]): Blob[] {
    const diam = this.expectedIconDiam;
    if (diam < 5) return blobs;

    const minSize = diam * 0.6;
    const maxSize = diam * 1.6;

    return blobs.filter(b => {
      const bw = b.maxX - b.minX + 1;
      const bh = b.maxY - b.minY + 1;
      // Bounding box should be close to icon-sized (tighter range)
      if (bw < minSize || bw > maxSize || bh < minSize || bh > maxSize) return false;
      // Aspect ratio close to square (champion icons are circles)
      const aspect = bw / bh;
      if (aspect < 0.6 || aspect > 1.7) return false;
      // Minimum pixel count (at least a partial arc)
      if (b.pixels < 15) return false;
      // Champion icon borders are RINGS (hollow center) → low fill ratio
      // Towers and minion clusters are FILLED shapes → high fill ratio
      // Ring of diameter D, border ~3px: fillRatio ≈ 0.25-0.35
      // Minion groups: fillRatio > 0.40 (many pixels clumped together)
      if (b.fillRatio > 0.40) return false;
      // Too sparse means noise, not a real border
      if (b.fillRatio < 0.08) return false;
      return true;
    });
  }

  // --- Movement path line detection (white pixels near teal blobs) ---

  // Cached viewport mask (white pixels that are part of long straight runs)
  private viewportMask: Uint8Array | null = null;
  // Centre of the camera viewport rectangle in game coords (#36), refreshed
  // every tick while enabled. null when no plausible rectangle was found this
  // frame, or when camera tracking is off.
  private cameraTrackingEnabled = false;
  private cameraPosition: Position | null = null;

  /**
   * Build a mask of white pixels, marking those that belong to the camera viewport
   * rectangle (long horizontal/vertical runs) so they can be excluded from path detection.
   * Viewport edges are long straight lines (15+ pixels); the movement path line is short/diagonal.
   */
  private buildWhiteMasks(
    imageData: ImageData,
    region: { x: number; y: number; width: number; height: number },
  ): { whiteMask: Uint8Array; viewportMask: Uint8Array } {
    const { data, width: imgW } = imageData;
    const w = region.width;
    const h = region.height;
    const whiteMask = new Uint8Array(w * h);
    const viewportMask = new Uint8Array(w * h);
    const RUN_THRESHOLD = 12; // pixels in a row = viewport edge

    // Pass 1: identify all white pixels
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const srcIdx = ((region.y + y) * imgW + (region.x + x)) * 4;
        const r = data[srcIdx];
        const g = data[srcIdx + 1];
        const b = data[srcIdx + 2];
        if (r > 200 && g > 200 && b > 200) {
          whiteMask[y * w + x] = 1;
        }
      }
    }

    // Pass 2: mark white pixels in long horizontal runs as viewport
    for (let y = 0; y < h; y++) {
      let runStart = -1;
      for (let x = 0; x <= w; x++) {
        const isWhite = x < w && whiteMask[y * w + x] === 1;
        if (isWhite && runStart < 0) {
          runStart = x;
        } else if (!isWhite && runStart >= 0) {
          if (x - runStart >= RUN_THRESHOLD) {
            for (let rx = runStart; rx < x; rx++) {
              viewportMask[y * w + rx] = 1;
            }
          }
          runStart = -1;
        }
      }
    }

    // Pass 3: mark white pixels in long vertical runs as viewport
    for (let x = 0; x < w; x++) {
      let runStart = -1;
      for (let y = 0; y <= h; y++) {
        const isWhite = y < h && whiteMask[y * w + x] === 1;
        if (isWhite && runStart < 0) {
          runStart = y;
        } else if (!isWhite && runStart >= 0) {
          if (y - runStart >= RUN_THRESHOLD) {
            for (let ry = runStart; ry < y; ry++) {
              viewportMask[ry * w + x] = 1;
            }
          }
          runStart = -1;
        }
      }
    }

    this.viewportMask = viewportMask;
    return { whiteMask, viewportMask };
  }

  /**
   * Count non-viewport white pixels in an annular region around a teal blob.
   * Excludes white pixels that are part of the camera viewport rectangle.
   */
  private countWhiteNearBlob(
    blob: Blob,
    whiteMask: Uint8Array,
    viewportMask: Uint8Array,
    regionWidth: number,
    regionHeight: number,
  ): number {
    const pad = Math.max(4, Math.round(this.expectedIconDiam * 0.3));
    const x0 = Math.max(0, blob.minX - pad);
    const y0 = Math.max(0, blob.minY - pad);
    const x1 = Math.min(regionWidth - 1, blob.maxX + pad);
    const y1 = Math.min(regionHeight - 1, blob.maxY + pad);
    // Inner bbox (the blob's own area — skip these pixels)
    const ix0 = blob.minX;
    const iy0 = blob.minY;
    const ix1 = blob.maxX;
    const iy1 = blob.maxY;

    let count = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (x >= ix0 && x <= ix1 && y >= iy0 && y <= iy1) continue;
        const idx = y * regionWidth + x;
        // White pixel that is NOT part of the viewport rectangle
        if (whiteMask[idx] === 1 && viewportMask[idx] === 0) {
          count++;
        }
      }
    }
    return count;
  }


  /**
   * Score movement path line evidence for a blob (0 = none, 1 = strong).
   * Normalizes the raw white pixel count to [0, 1]: 8+ white pixels = full score.
   */
  private whitePixelScore(
    blob: Blob,
    whiteMask: Uint8Array,
    viewportMask: Uint8Array,
    regionWidth: number,
    regionHeight: number,
  ): number {
    const count = this.countWhiteNearBlob(blob, whiteMask, viewportMask, regionWidth, regionHeight);
    return Math.min(1, count / 8);
  }

  // --- Filtered image generation for overlay debug ---

  private generateFilteredImage(
    mask: Uint8Array, w: number, h: number, blobs: Blob[],
    imageData?: ImageData, region?: { x: number; y: number; width: number; height: number },
  ): string {
    if (!this.debugCanvas || this.debugCanvas.width !== w || this.debugCanvas.height !== h) {
      this.debugCanvas = document.createElement('canvas');
      this.debugCanvas.width = w;
      this.debugCanvas.height = h;
      this.debugCtx = this.debugCanvas.getContext('2d')!;
    }
    const c = this.debugCanvas;
    const ctx = this.debugCtx!;
    const img = ctx.createImageData(w, h);

    // Draw filtered pixels (teal, red, and movement path white)
    for (let i = 0; i < w * h; i++) {
      const pi = i * 4;
      if (mask[i] === 1) {
        img.data[pi] = 0; img.data[pi + 1] = 220; img.data[pi + 2] = 180; img.data[pi + 3] = 200;
      } else if (mask[i] === 2) {
        img.data[pi] = 255; img.data[pi + 1] = 50; img.data[pi + 2] = 50; img.data[pi + 3] = 200;
      } else if (imageData && region) {
        // Show non-viewport white pixels as yellow (movement path line)
        const srcIdx = ((region.y + Math.floor(i / w)) * imageData.width + (region.x + (i % w))) * 4;
        const r = imageData.data[srcIdx];
        const g = imageData.data[srcIdx + 1];
        const b = imageData.data[srcIdx + 2];
        if (r > 200 && g > 200 && b > 200 && this.viewportMask && this.viewportMask[i] === 0) {
          img.data[pi] = 255; img.data[pi + 1] = 255; img.data[pi + 2] = 0; img.data[pi + 3] = 220;
        }
      }
    }

    ctx.putImageData(img, 0, 0);

    // Draw circles around detected icon blobs
    ctx.lineWidth = 2;
    for (const b of blobs) {
      const bw = b.maxX - b.minX + 1;
      const bh = b.maxY - b.minY + 1;
      const r = Math.max(bw, bh) / 2;
      ctx.strokeStyle = b.color === 'teal' ? '#00ffcc' : '#ff4444';
      ctx.beginPath();
      ctx.arc(b.cx, b.cy, r + 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Draw tracked position
    if (this.lastPixelPos && this.minimapRegion) {
      const lx = this.lastPixelPos.x - this.minimapRegion.x;
      const ly = this.lastPixelPos.y - this.minimapRegion.y;
      ctx.fillStyle = '#ff0000';
      ctx.beginPath();
      ctx.arc(lx, ly, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    return c.toDataURL('image/png');
  }

  // --- Main tick ---

  private tick(): void {
    if (this.state === TrackingState.DEAD) {
      if (this.deathPosition && this.onPositionUpdate) {
        this.onPositionUpdate(this.deathPosition);
      }
      return;
    }

    // Drop tick if the previous one is still in flight (capture + CV + classifier
    // can exceed the interval at high scan rates). Better to skip than to pile up.
    if (this.tickRunning) return;
    this.tickRunning = true;

    const tickNow = performance.now();
    this.lastDtSec = (tickNow - this.lastTickMs) / 1000;
    this.lastTickMs = tickNow;

    invoke<{ data_url: string; width: number; height: number }>('capture_minimap')
      .then((result) => {
        const img = new Image();
        img.onload = () => {
          try {
            this.ctx.drawImage(img, 0, 0);
            const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

            // Minimap region is set from game.cfg config (or manual calibration).
            // No CV-based auto-detection needed.
            if (!this.minimapRegion && this.userMinimapRegion) {
              this.minimapRegion = this.userMinimapRegion;
              this.expectedIconDiam = Math.round(this.minimapRegion.width * 0.087);
            }

            if (!this.minimapRegion) return;

            // Create filtered mask and find blobs
            const region = this.minimapRegion;
            let mask = this.createMask(imageData, region);
            mask = this.dilate(mask, region.width, region.height);
            const allBlobs = this.findBlobs(mask, region.width, region.height);
            const iconBlobs = this.filterIconBlobs(allBlobs);

            // Regenerate the debug-mode filtered image at 5Hz (scan-rate independent).
            // This is what makes the debug overlay feel "live" without paying the
            // canvas-encode cost on every tick.
            const nowMs = performance.now();
            if (nowMs - this.lastDebugImageMs >= 200) {
              this.lastDebugImageMs = nowMs;
              this.filteredImageUrl = this.generateFilteredImage(mask, region.width, region.height, iconBlobs, imageData, region);
            }

            this.diagCounter++;

            // Build white pixel masks (separating movement path from viewport rectangle)
            const { whiteMask, viewportMask } = this.buildWhiteMasks(imageData, region);

            // Camera viewport centre → game coords, for "voice on camera" (#36).
            // Cheap (two counting passes over a mask we already built) and
            // independent of lock state, so it keeps working while the tracker
            // is SCANNING.
            this.updateCameraPosition(viewportMask, region);

            // Run classifier at most every 500ms (scan-rate independent)
            const tealBlobs = iconBlobs.filter(b => b.color === 'teal');
            if (
              this.classifier &&
              tealBlobs.length > 0 &&
              !this.classifierRunning &&
              nowMs - this.lastClassifierRunMs >= 500
            ) {
              this.classifierRunning = true;
              this.lastClassifierRunMs = nowMs;
              this.updateClassifierScores(tealBlobs, imageData, region).finally(() => {
                this.classifierRunning = false;
              });
            }

            if (this.state === TrackingState.SCANNING) {
              this.handleScanning(iconBlobs, whiteMask, viewportMask, region);
            } else if (this.state === TrackingState.LOCKED) {
              this.handleLocked(iconBlobs, whiteMask, viewportMask, region);
            }
          } finally {
            this.tickRunning = false;
          }
        };
        img.onerror = () => { this.tickRunning = false; };
        img.src = result.data_url;
      })
      .catch((err) => {
        console.error('[Tracking] capture_minimap failed:', err);
        this.tickRunning = false;
      });
  }

  /**
   * Scan: initial identification of the local player's teal blob.
   * Uses a unified composite score (classifier, peer avoidance, movement path, ring quality).
   * Only used once at game start (or after respawn). Once locked, we never return to SCANNING —
   * instead we hold position and re-acquire via classifier.
   */
  private handleScanning(
    iconBlobs: Blob[],
    whiteMask: Uint8Array,
    viewportMask: Uint8Array,
    region: { x: number; y: number; width: number; height: number },
  ): void {
    if (!this.minimapRegion) return;

    const tealBlobs = iconBlobs.filter(b => b.color === 'teal');
    if (tealBlobs.length === 0) return;

    this.scanFrameCount++;

    // Wait ~1s for classifier EMA to stabilize (~0.5s without classifier),
    // independent of scan rate.
    const hasClassifier = !!(this.classifier && this.classifier.isLoaded());
    const warmupMs = hasClassifier ? 1000 : 500;
    if (performance.now() - this.scanStartMs < warmupMs) {
      if (this.onPositionUpdate && this.lastPosition) {
        this.onPositionUpdate(this.lastPosition);
      }
      return;
    }

    let bestBlob = tealBlobs[0];
    let bestScore = -Infinity;

    // The classifier only earns its 0.45 weight if it actually discriminated
    // this frame. updateClassifierScores() zeroes every blob when no raw score
    // clears MIN_RAW_THRESHOLD, and the model genuinely returns ~0 for some
    // champions at some minimap scales (NotOtakuu's Twisted Fate log). Scoring
    // against an all-zero classifier just scales every candidate down by the
    // same 0.45 while distorting the weights of the signals that DO have
    // something to say, so fall back to the no-classifier weighting instead.
    const clsScores = tealBlobs.map(b => this.getClassifierScore(b));
    const classifierUsable = hasClassifier && clsScores.some(s => s > 0);

    for (let i = 0; i < tealBlobs.length; i++) {
      const b = tealBlobs[i];
      const peerScore = this.peerAvoidanceScore(b);
      const whiteScore = this.whitePixelScore(b, whiteMask, viewportMask, region.width, region.height);
      const clsScore = clsScores[i];
      const ringScore = Math.min(1, b.pixels * (1 - b.fillRatio) / 200);

      const score = classifierUsable
        ? clsScore * 0.45 + whiteScore * 0.25 + peerScore * 0.20 + ringScore * 0.10
        : peerScore * 0.40 + whiteScore * 0.35 + ringScore * 0.25;

      if (score > bestScore) {
        bestScore = score;
        bestBlob = b;
      }
    }

    // v0.3.1: reverted the v0.3.0 shouldAcceptLocked classifier gate. It hard-
    // blocked this transition whenever classifier confidence was low, which is
    // the normal case for champions the 172-class classifier is weak on (e.g.
    // Teemo) — so the tracker refused to lock at all and never broadcast a
    // position. The classifier still contributes to the composite score above;
    // it's just no longer a veto. The whole classifier-confidence path is being
    // replaced by template matching in v0.4 (docs/plans/2026-06-03-cv-tracking-research.md).
    this.lockOnBlob(bestBlob, 'composite(score=' + bestScore.toFixed(2) + ')');
  }

  /** Lock onto a teal blob as the local player */
  private lockOnBlob(blob: Blob, reason: string): void {
    if (!this.minimapRegion) return;

    const cx = this.minimapRegion.x + blob.cx;
    const cy = this.minimapRegion.y + blob.cy;

    this.lastPixelPos = { x: cx, y: cy };
    this.setLastPosition(this.pixelToGamePosition(cx, cy, this.minimapRegion), 'lockOnBlob');
    this.state = TrackingState.LOCKED;
    this.lockedTickCount = 0;
    this.scanFrameCount = 0;
    this.scanStartMs = performance.now();
    this.holdStartMs = 0;
    // Treat the moment of lock as a "movement" so Phase 2 doesn't start in
    // stationary-stickiness mode before we've seen any real movement.
    this.lastMovementMs = performance.now();
    this.velocityX = 0;
    this.velocityY = 0;

    const bw = blob.maxX - blob.minX + 1;
    const bh = blob.maxY - blob.minY + 1;
    console.log('[Tracking] SCANNING -> LOCKED via ' + reason +
      ': center=(' + cx + ',' + cy + ')' +
      ' size=' + bw + 'x' + bh + ' pixels=' + blob.pixels +
      ' fill=' + blob.fillRatio.toFixed(2));

    if (this.onPositionUpdate && this.lastPosition) {
      this.onPositionUpdate(this.lastPosition);
    }
  }

  /**
   * Locked: follow the tracked blob using a unified composite score.
   * Never drops back to SCANNING — instead holds last known position when blobs vanish
   * (death, camera pan, overlapping icons, teleport) and re-acquires via classifier
   * when a confident match reappears anywhere on the minimap.
   */
  private handleLocked(
    iconBlobs: Blob[],
    whiteMask: Uint8Array,
    viewportMask: Uint8Array,
    region: { x: number; y: number; width: number; height: number },
  ): void {
    if (!this.lastPixelPos || !this.minimapRegion) return;

    // v0.3: bail out of LOCKED if we've been holding too long. Extrapolated
    // position past ~5s is essentially noise; better to drop back to SCANNING
    // and let the classifier re-acquire from scratch. IXAM's v0.1.33 logs
    // (issue #7) showed holds up to 44s with phantom coords flowing the
    // whole time.
    if (shouldForceReacquisition(this.holdStartMs, performance.now())) {
      console.warn('[Tracking] Hold exceeded ' + FORCED_REACQUIRE_HOLD_MS +
        'ms — forcing re-acquisition (back to SCANNING)');
      this.state = TrackingState.SCANNING;
      this.holdStartMs = 0;
      this.scanFrameCount = 0;
      this.scanStartMs = performance.now();
      return;
    }

    const tealBlobs = iconBlobs.filter(b => b.color === 'teal');
    const hasClassifier = !!(this.classifier && this.classifier.isLoaded());

    // No teal blobs at all — extrapolate position using decaying velocity
    if (tealBlobs.length === 0) {
      if (this.lockedTickCount === 0) {
        console.log('[Tracking] Extrapolating position (no teal blobs)');
      }
      this.extrapolatePosition(region);
      return;
    }

    // Predicted position using velocity + adaptive jump radius (expanded
    // during holds so we can catch up to a blob that moved while we waited).
    const lastReg = {
      x: this.lastPixelPos.x - this.minimapRegion.x,
      y: this.lastPixelPos.y - this.minimapRegion.y,
    };
    const predicted = { x: lastReg.x + this.velocityX, y: lastReg.y + this.velocityY };
    const now = performance.now();
    const holdSec = this.holdStartMs > 0 ? (now - this.holdStartMs) / 1000 : 0;
    const maxJumpPx = computeMaxJumpPx(this.expectedIconDiam, this.holdStartMs, now);

    const scoreFns: ScoreFns = {
      cls: (b) => this.getClassifierScore(b),
      white: (b) => this.whitePixelScore(b, whiteMask, viewportMask, region.width, region.height),
      peer: (b) => this.peerAvoidanceScore(b),
    };

    // Phase 1: nearest in-range blob with composite scoring. Blobs inside the
    // near-field radius are followed on continuity alone — the classifier only
    // gates candidates further out (see computeNearFieldPx).
    const phase1 = pickBestBlobInRange(
      tealBlobs, lastReg, predicted, maxJumpPx, hasClassifier, scoreFns,
      computeNearFieldPx(this.expectedIconDiam),
    );

    // Phase 2: classifier-based long-range reacquire if Phase 1 found nothing
    if (!phase1 && hasClassifier) {
      if (this.holdStartMs === 0) this.holdStartMs = performance.now();
      const stationarySec = this.lastMovementMs > 0 ? (now - this.lastMovementMs) / 1000 : 0;
      const reacquireThreshold = computeReacquireThreshold(stationarySec, holdSec);
      const phase2 = pickClassifierReacquisition(tealBlobs, reacquireThreshold, scoreFns.cls);
      if (phase2) {
        this.acquireViaClassifier(phase2.blob, phase2.score);
        return;
      }
    }

    // Phase 3: no blob matched at all — extrapolate
    if (!phase1) {
      if (this.lockedTickCount === 0) {
        console.log('[Tracking] Extrapolating position (no match in range)');
        this.holdStartMs = performance.now();
      }
      this.extrapolatePosition(region);
      return;
    }

    this.finalizeLockedFrame(phase1.blob, lastReg, holdSec);
  }

  /** Phase 2 success path: snap position, reset velocity, log, fire callback. */
  private acquireViaClassifier(blob: Blob, clsScore: number): void {
    if (!this.minimapRegion) return;
    const cx = this.minimapRegion.x + blob.cx;
    const cy = this.minimapRegion.y + blob.cy;
    this.lastPixelPos = { x: cx, y: cy };
    const newPos = this.pixelToGamePosition(cx, cy, this.minimapRegion);
    this.setLastPosition(newPos, 'classifier-reacquire');
    this.velocityX = 0;
    this.velocityY = 0;
    this.lockedTickCount++;
    console.log('[Tracking] Re-acquired via classifier (cls=' + clsScore.toFixed(2) +
      '): pixel(' + cx + ',' + cy + ')' +
      ' game(' + Math.round(newPos.x) + ',' + Math.round(newPos.y) + ')');
    if (this.onPositionUpdate && this.lastPosition) {
      this.onPositionUpdate(this.lastPosition);
    }
  }

  /** Phase 1 success path: update velocity EMA, position, movement timestamp. */
  private finalizeLockedFrame(
    blob: Blob,
    lastReg: { x: number; y: number },
    holdSec: number,
  ): void {
    if (!this.minimapRegion) return;
    if (this.lockedTickCount > 0) {
      console.log('[Tracking] Resumed tracking after hold (' + holdSec.toFixed(2) + 's)');
    }

    const cx = this.minimapRegion.x + blob.cx;
    const cy = this.minimapRegion.y + blob.cy;

    // Velocity EMA — preserve per-frame-at-8-FPS behavior across scan rates.
    // weight_old = 0.5^(TUNED_FPS * dt); at 8 FPS dt=0.125 → weight_old = 0.5.
    const velWeightOld = Math.pow(0.5, TrackingService.TUNED_FPS * this.lastDtSec);
    const velWeightNew = 1 - velWeightOld;
    this.velocityX = this.velocityX * velWeightOld + (blob.cx - lastReg.x) * velWeightNew;
    this.velocityY = this.velocityY * velWeightOld + (blob.cy - lastReg.y) * velWeightNew;

    // Track real movement so Phase 2 can prefer stationary "stickiness".
    const moveDx = blob.cx - lastReg.x;
    const moveDy = blob.cy - lastReg.y;
    if (moveDx * moveDx + moveDy * moveDy > 9 /* 3px */) {
      this.lastMovementMs = performance.now();
    }

    this.lastPixelPos = { x: cx, y: cy };
    this.setLastPosition(this.pixelToGamePosition(cx, cy, this.minimapRegion), 'locked-track');
    this.lockedTickCount = 0;
    this.holdStartMs = 0;

    if (this.onPositionUpdate && this.lastPosition) {
      this.onPositionUpdate(this.lastPosition);
    }
  }

  /**
   * Extrapolate position using decaying velocity when tracking is lost.
   * Velocity fades out over ~1 second of wall-clock time, regardless of scan rate.
   * Position is clamped to minimap bounds to prevent drifting off-map.
   */
  private extrapolatePosition(region: { x: number; y: number; width: number; height: number }): void {
    this.lockedTickCount++;
    if (this.holdStartMs === 0) this.holdStartMs = performance.now();

    // Cap velocity to a physically-plausible magnitude before applying. The
    // velocity-EMA in handleLocked can latch onto huge values when the tracked
    // blob suddenly jumps (e.g. classifier re-acquisition after a long hold
    // puts the position in a totally different spot). Without this cap, even
    // 1-2 ticks of extrapolation can fly the position into a map corner — we
    // saw a 12000-game-unit drift in 500ms on a real user log. Champions
    // top out around 2 px/tick on the minimap at any normal scale; 10 leaves
    // a generous safety margin while bounding any runaway.
    const VEL_CAP_PX = 10;
    const velMag = Math.hypot(this.velocityX, this.velocityY);
    if (velMag > VEL_CAP_PX) {
      const scale = VEL_CAP_PX / velMag;
      this.velocityX *= scale;
      this.velocityY *= scale;
    }

    // Only extrapolate if we have meaningful velocity
    const speed = Math.abs(this.velocityX) + Math.abs(this.velocityY);
    if (speed > 0.1 && this.lastPixelPos && this.minimapRegion) {
      const lastRegX = this.lastPixelPos.x - this.minimapRegion.x;
      const lastRegY = this.lastPixelPos.y - this.minimapRegion.y;

      // Apply velocity and clamp to minimap bounds
      const newRegX = Math.max(0, Math.min(region.width - 1, lastRegX + this.velocityX));
      const newRegY = Math.max(0, Math.min(region.height - 1, lastRegY + this.velocityY));

      const cx = this.minimapRegion.x + newRegX;
      const cy = this.minimapRegion.y + newRegY;
      this.lastPixelPos = { x: cx, y: cy };
      this.setLastPosition(this.pixelToGamePosition(cx, cy, this.minimapRegion), 'extrapolate');

      // Decay velocity: at 8 FPS this was 0.7/frame → 0.7^8 ≈ 0.058 per second.
      // Preserve that wall-clock rate regardless of scan rate.
      const decay = Math.pow(0.7, TrackingService.TUNED_FPS * this.lastDtSec);
      this.velocityX *= decay;
      this.velocityY *= decay;
    }

    if (this.onPositionUpdate && this.lastPosition) {
      this.onPositionUpdate(this.lastPosition);
    }
  }

  pixelToGamePosition(
    pixelX: number, pixelY: number,
    region: { x: number; y: number; width: number; height: number },
  ): Position {
    const relX = Math.max(0, Math.min(1, (pixelX - region.x) / region.width));
    const relY = Math.max(0, Math.min(1, (pixelY - region.y) / region.height));
    const dims = MAP_DIMENSIONS[this.mapType];
    return {
      x: relX * dims.width,
      y: dims.height - relY * dims.height,
    };
  }
}
