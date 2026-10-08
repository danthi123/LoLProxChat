import { invoke } from '@tauri-apps/api/core';
import { Position, MapType, MAP_DIMENSIONS } from '../core/types';
import { CaptureFrame, decodeCaptureFrame } from '../core/capture-frame';
import '../core/window-globals';
import {
  getCaptureBoundsForRect,
  getMinimapRegionForRect,
  minimapRegionFitsCapture,
  MinimapBounds,
  ScreenRect,
} from '../core/map-calibration';
import { BlobScorer } from './champion-classifier';
import type { TrackingDebugSink } from './debug-bundle';
import { FrameSource, TauriFrameSource } from './frame-source';
import {
  computeMaxJumpPx,
  computeReacquireThreshold,
  filledIconRing,
  iconCropBox,
  TeammateVerdicts,
  TEAMMATE_VERDICT_RUNS,
  pickBestBlobInRange,
  pickClassifierReacquisition,
  reacquireThresholdAt,
  FAR_REACQUIRE_THRESHOLD,
  FAR_REACQUIRE_MIN_RAW,
  ScoreFns,
  // v0.3: CV tracking tweaks driven by IXAM's v0.1.33 issue #7 logs
  // (v0.3.1 reverted the classifier-confidence-dependent ones — see below)
  nextClassifierEma,
  shouldForceReacquisition,
  computeNearFieldPx,
  describeViewportCenter,
  ViewportMiss,
  HoldReason,
  FORCED_REACQUIRE_HOLD_MS,
  findOccluder,
  isPossibleOccluder,
  MAX_OCCLUDED_MS,
  COVERED_PIXEL_FRACTION,
  OCCLUDER_GRACE_MS,
  isPossibleStack,
  findStack,
  positionInStack,
  MAX_STACKED_MS,
  BYSTANDER_VOUCH_RUNS,
  rescanReachPx,
  WrongLockEvidence,
  emptyWrongLockEvidence,
  nextWrongLockEvidence,
  RESET_AVOID_MS,
  RESET_OBSERVE_MS,
  WRONG_LOCK_STILL_FRACTION,
  CameraDwell,
  ViewportBox,
  cameraFavourite,
  cameraSwitchTarget,
  readingNear,
  CAMERA_SWITCH_COOLDOWN_MS,
  CAMERA_REJECT_MS,
  isInBaseZone,
} from './tracking-helpers';

export enum TrackingState {
  SCANNING = 'scanning',
  LOCKED = 'locked',
  DEAD = 'dead',
}

// The panel is a ~240px column, so these stay short; the full geometry goes to
// the log instead. They are the only signal a user without Debug on ever sees
// for a capture geometry we refused, and the refusal never clears itself.
export const WARN_MINIMAP_TOO_LARGE = "Minimap too large to capture — lower MinimapScale in League's HUD.";
export const WARN_CALIBRATION_OUTSIDE_CAPTURE = 'Calibrated minimap is outside the capture area — recalibrate.';

import type { Blob } from './blob-types';

export class TrackingService {
  private state: TrackingState = TrackingState.SCANNING;
  readonly captureBounds: MinimapBounds;
  private gameRect: ScreenRect;
  private mapType: MapType;
  private frameSource: FrameSource;
  // Node and the DOM disagree on what setInterval hands back, and tests/cv runs
  // the real scan loop under node.
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onPositionUpdate: ((pos: Position) => void) | null = null;

  // Minimap region (detected or set by calibration/config)
  private minimapRegion: { x: number; y: number; width: number; height: number } | null = null;
  /** Panel-facing reason the minimap region was refused, or null. */
  private geometryRefusal: string | null = null;
  private userMinimapRegion: { x: number; y: number; width: number; height: number } | null = null;
  private configMinimapScale: number | null = null;

  // Tracking state
  private lastPixelPos: { x: number; y: number } | null = null;
  private lastPosition: Position | null = null;
  private lastPositionUpdateMs = 0;
  private deathPosition: Position | null = null;
  // The last position that came from actually seeing us (or the covered-icon
  // anchor) rather than from extrapolation — where onDeath puts the body.
  private lastSeenPosition: Position | null = null;
  private expectedIconDiam = 0;

  // Velocity prediction (smoothed over recent frames)
  private velocityX = 0;
  private velocityY = 0;

  // Frame counter during SCANNING (warmup before lock-on)
  private scanFrameCount = 0;

  // Filtered image for overlay debug display
  private filteredImageUrl: string | null = null;
  private lastDebugImageMs = 0;

  // Champion classifier (ONNX model)
  private classifier: BlobScorer | null = null;
  /** Debug only: saves minimap snapshots and classifier crops for the game's zip. */
  private debugSink: TrackingDebugSink | null = null;

  setDebugSink(sink: TrackingDebugSink | null): void {
    this.debugSink = sink;
  }
  // Cached classifier scores per blob (refreshed periodically, not every frame)
  private classifierScores: Map<string, number> = new Map();
  /** The latest run's un-normalized model output per blob — what a far
   *  re-acquisition is gated on (see FAR_REACQUIRE_MIN_RAW). */
  private rawClassifierScores: Map<string, number> = new Map();
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
  // Why the current hold started. 'no-blobs' means the minimap showed no
  // own-team icons at all this frame; 'no-match' means icons were there but
  // none of them was us. The distinction matters to the orchestrator: see
  // getHoldReason().
  private holdReason: HoldReason = null;
  // Occlusion (an enemy icon drawn over ours) — see occlusionStep().
  // occludedSinceMs is when the current episode started, or 0 if there has been
  // none since our icon was last found; an episode that ends without our icon
  // coming back leaves it set, which stops a second one starting.
  private occludedSinceMs = 0;
  private occluded = false;
  // Region px. Fixed for the whole episode: where the covering icon was when
  // ours vanished. We report this, not wherever that enemy goes next.
  private occlusionAnchor: { x: number; y: number } | null = null;
  private occluderLastSeenMs = 0;
  // Typical pixel count of our icon when nothing overlaps it (EMA), and whether
  // the last frame we saw it on showed it overlapped AND shrunk — the signature
  // of an icon being covered, as opposed to vanishing whole (recall, teleport).
  private fullIconPixels = 0;
  private iconPixelSamples: number[] = [];
  private lastIconSampleMs = 0;
  // Same, for the bounding box — what coverCorrectedCentre measures against.
  private fullIconW = 0;
  private fullIconH = 0;
  private lastSeenPartlyCovered = false;
  private lastSeenPixels: number | null = null;
  // This frame's red blobs that could be enemy icons over ours — looser than
  // the icon filter, see isPossibleOccluder.
  private occluderBlobs: Blob[] = [];
  // Teal blobs too big for one icon: ours merged with a teammate's. See
  // stackStep().
  private stackBlobs: Blob[] = [];
  // This frame's single-icon teal blobs, bystanders left out.
  private frameTealIcons: Blob[] = [];
  private stacked = false;
  // Where the teammate's icon sits in the pair (region px), mirrored from ours
  // through the merged blob's centroid.
  private stackPartner: { x: number; y: number } | null = null;
  // Our position relative to the merged blob's centroid (region px), so we
  // move with the pair and keep to our side of it. See stackStep().
  private stackOffset: { x: number; y: number } | null = null;
  // The most pixels the merged blob has had this episode, and whether it has
  // ever been wider than about two icons: an icon leaving a group of three or
  // more leaves a merged pair behind, not one icon. See stackStep().
  private stackPeakPixels = 0;
  private stackWasWide = false;
  // Where we last saw our icon on its own (one icon's size, nothing over it),
  // and when: which side of a merged pair we are on.
  private lastCleanReg: { x: number; y: number } | null = null;
  private lastCleanMs = 0;
  // Teammate icons that are not us although nothing identifies them: the one
  // left where a merged pair was after ours vanished out of it, and any
  // standing where we were when a hold ran out. Excluded from tracking while
  // they can be followed frame to frame — see excludeBystanders().
  private bystanders: Array<{ x: number; y: number; vouched: number; lastRunMs: number }> = [];
  // The same icons, unfiltered, for this frame's classifier run.
  private bystanderBlobs: Blob[] = [];
  // Own-team icons the skin match keeps calling a teammate's: set aside like
  // bystanders (never locked on), but still scored and counted for camera
  // dwell. See TeammateVerdicts.
  private teammateVerdicts = new TeammateVerdicts();
  private teammateBlobs: Blob[] = [];
  // When the current stacked episode began; latched (left set) when one ends
  // by the cap rather than by us reappearing, so it cannot simply restart.
  private stackedSinceMs = 0;
  // Set when a hold ran out and the tracker went back to SCANNING: where we
  // were (region px) and when. The rescan does not lock an unidentified icon
  // further from there than we could have walked — see handleScanning.
  private lostAt: { x: number; y: number } | null = null;
  private lostAtMs = 0;
  // Whether this frame showed anything at all on the minimap — any icon or
  // structure of either colour. See the no-teal branch of handleLocked.
  private minimapReadable = true;
  // When we successfully tracked a blob that moved >3px from last tick.
  // Used to make Phase 2 re-acquisition stricter when stationary, so we don't
  // teleport the tracking dot onto a minion wave / turret if the icon flickers.
  private lastMovementMs = 0;
  // Evidence that the lock is on a teal blob that is not us — see
  // nextWrongLockEvidence — and, once it is sufficient, where to move to.
  private wrongLock: WrongLockEvidence = emptyWrongLockEvidence();
  private wrongLockTarget: { x: number; y: number } | null = null;
  // Set by resetPosition(): the spot (region px) the user told us we are not
  // at, and until when the next scan avoids it.
  private avoidPoint: { x: number; y: number } | null = null;
  private avoidOrigin: { x: number; y: number } | null = null;
  private avoidUntilMs = 0;
  private static readonly TUNED_FPS = 8;

  // Repeated capture failures are logged at most once per distinct message
  // per 5s — see logCaptureError.
  private lastCaptureError = '';
  private lastCaptureErrorMs = 0;
  // Frame size we last tried to recover from by re-pushing the capture bounds.
  private lastFrameSizeResync = '';

  // Diagnostics
  private lockedTickCount = 0;
  private diagCounter = 0;
  private scanFps = 30;

  constructor(gameRect: ScreenRect, mapType: MapType, frameSource: FrameSource = new TauriFrameSource()) {
    this.gameRect = gameRect;
    this.captureBounds = getCaptureBoundsForRect(gameRect);
    this.mapType = mapType;
    this.frameSource = frameSource;
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

  /** Why the camera rectangle was not found this frame, with the pixel count
   *  that separates "nothing passed the white threshold" from "wrong shape". */
  getCameraMiss(): { reason: ViewportMiss; markedPixels: number } | null {
    return this.cameraMiss ? { reason: this.cameraMiss, markedPixels: this.cameraMarkedPixels } : null;
  }

  /**
   * Enable/disable publishing the camera centre for voice on camera. The
   * rectangle itself is read every frame regardless (two counting passes over
   * a mask processFrame builds anyway), because the tracker uses it to tell
   * our icon from a teammate's; this only controls getCameraPosition(). Driven
   * by the orchestrator so the tracker doesn't need to know about user
   * preferences.
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
    const result = describeViewportCenter(viewportMask, region.width, region.height);
    this.cameraBox = result.box ?? null;
    if (!this.cameraTrackingEnabled) return;
    this.cameraMiss = result.miss ?? null;
    this.cameraMarkedPixels = result.markedPixels;
    const centre = result.centre;
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
    if (source !== 'extrapolate') this.lastSeenPosition = newPos;
  }
  getFilteredImageUrl(): string | null { return this.filteredImageUrl; }
  /** Seconds since the last successful frame-to-frame lock, or 0 if currently tracking. */
  getHoldDurationSec(): number {
    return this.holdStartMs > 0 ? (performance.now() - this.holdStartMs) / 1000 : 0;
  }

  /**
   * Why the tracker is currently holding, or null if it is tracking normally.
   *
   * 'no-blobs' — not a single own-team icon was found on the minimap. In a
   * real game four allies are always drawn there, so this cannot mean we
   * moved; it means the capture failed or something covered the minimap (the
   * shop, the scoreboard, a full-screen death cam). The last position is
   * still very likely correct.
   *
   * 'no-match' — icons were present and none of them matched us. That IS a
   * movement signal: a recall is the case that matters, an instant teleport
   * the tracker cannot follow.
   */
  getHoldReason(): HoldReason {
    return this.holdStartMs > 0 ? this.holdReason : null;
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

  /** The game window's client rect that all capture geometry derives from. */
  getGameRect(): ScreenRect { return this.gameRect; }

  /**
   * Why the current minimap region was refused, in words short enough for the
   * overlay panel — or null when there is nothing to say.
   */
  getGeometryRefusal(): string | null { return this.geometryRefusal; }

  /**
   * Set the minimap region from League's MinimapScale config value.
   * The size formula and its calibration live in core/map-calibration.ts.
   */
  setMinimapScaleFromConfig(scale: number): void {
    this.configMinimapScale = scale;

    const region = getMinimapRegionForRect(this.gameRect, scale, this.captureBounds);

    if (!minimapRegionFitsCapture(region, this.captureBounds)) {
      // Scanning a region we can only see part of would index the frame out of
      // bounds in createMask, which wraps into the previous scanline rather
      // than failing. Refuse instead.
      console.error('[Tracking] MinimapScale ' + scale + ' needs a ' + region.width +
        'px minimap but the capture square is only ' + this.captureBounds.width + 'px' +
        ' (gameRect=' + JSON.stringify(this.gameRect) + ') — tracking cannot run');
      this.geometryRefusal = WARN_MINIMAP_TOO_LARGE;
      this.minimapRegion = null;
      this.expectedIconDiam = 0;
    } else {
      this.geometryRefusal = null;
      this.minimapRegion = region;
      this.expectedIconDiam = Math.round(region.width * 0.087);
      console.log('[Tracking] Minimap from config: scale=' + scale +
        ' size=' + region.width + 'px' +
        ' screenPos=(' + (this.captureBounds.x + region.x) + ',' + (this.captureBounds.y + region.y) + ')' +
        ' gameRect=' + JSON.stringify(this.gameRect) +
        ' region=' + JSON.stringify(region) +
        ' iconDiam=' + this.expectedIconDiam);
    }

    this.state = TrackingState.SCANNING;
    this.lostAt = null;
    this.bystanders = [];
    this.bystanderBlobs = [];
    this.teammateVerdicts.clear();
    this.teammateBlobs = [];
    this.lastCleanReg = null;
    this.lastPixelPos = null;
    this.lockedTickCount = 0;
    this.scanFrameCount = 0;
    this.scanStartMs = performance.now();
    this.holdStartMs = 0;
    this.holdReason = null;
    this.resetOcclusion();
    this.fullIconPixels = 0;
    this.iconPixelSamples = [];
  }

  /**
   * Manual calibration. `region` is CAPTURE-RELATIVE (the orchestrator subtracts
   * `captureBounds` before calling), so it is only valid while captureBounds
   * stays put — which it does today, being fixed at construction. Anything that
   * later re-anchors captureBounds mid-session must clear `userMinimapRegion`
   * too, or the stored region will point at the wrong pixels.
   */
  setMinimapRegion(region: { x: number; y: number; width: number; height: number } | null): void {
    // A hand-drawn region gets the same fit check as a config-derived one: the
    // out-of-bounds indexing in createMask does not care which produced it.
    if (region && !minimapRegionFitsCapture(region, this.captureBounds)) {
      console.error('[Tracking] Calibrated region ' + JSON.stringify(region) +
        ' does not fit the ' + this.captureBounds.width + 'px capture square' +
        ' (gameRect=' + JSON.stringify(this.gameRect) + ') — tracking cannot run');
      this.geometryRefusal = WARN_CALIBRATION_OUTSIDE_CAPTURE;
      this.userMinimapRegion = null;
      this.minimapRegion = null;
      this.expectedIconDiam = 0;
    } else if (region) {
      this.geometryRefusal = null;
      this.userMinimapRegion = region;
      this.minimapRegion = region;
      this.expectedIconDiam = Math.round(region.width * 0.087);
      console.log('[Tracking] Minimap set by calibration:', JSON.stringify(region), 'iconDiam:', this.expectedIconDiam);
    } else {
      this.geometryRefusal = null;
      this.userMinimapRegion = null;
      this.minimapRegion = null;
    }
    this.state = TrackingState.SCANNING;
    this.lostAt = null;
    this.bystanders = [];
    this.bystanderBlobs = [];
    this.teammateVerdicts.clear();
    this.teammateBlobs = [];
    this.lastCleanReg = null;
    this.lastPixelPos = null;
    this.lockedTickCount = 0;
    this.scanFrameCount = 0;
    this.scanStartMs = performance.now();
    this.holdStartMs = 0;
    this.holdReason = null;
    this.resetOcclusion();
    this.fullIconPixels = 0;
    this.iconPixelSamples = [];
  }

  loadChampionTemplate(_championName: string): void {
    console.log('[Tracking] Using color filter + blob detection');
  }

  setClassifier(classifier: BlobScorer): void {
    this.classifier = classifier;
    console.log('[Tracking] Champion classifier set');
  }

  /**
   * Run the champion classifier on teal blobs and cache the "local champion confidence" per blob.
   * Called every few frames (not every frame) to amortize ONNX inference cost.
   * Scores are cached by blob center (cx,cy) for fuzzy lookup.
   */
  private async updateClassifierScores(
    tealBlobs: Blob[],
    frame: CaptureFrame,
    region: { x: number; y: number; width: number; height: number },
  ): Promise<void> {
    if (!this.classifier || !this.classifier.isLoaded()) return;

    // One icon's square, centred on the blob. The blob's bounding box was used
    // before, which takes in whatever the dilated ring merged with — a turret
    // marker, a neighbour's ring — and was then stretched square: on the
    // 2026-10-08 crops, cutting them this way instead made the model rank the
    // right teammate first for Briar, Ekko and Kayn every time, at 3-10x the
    // confidence of a crop just 20% looser.
    const crops = tealBlobs.map(b => iconCropBox(region.x + b.cx, region.y + b.cy, this.expectedIconDiam));

    try {
      const rawScores = await this.classifier.scoreBlobsForLocalChampion(frame, crops);

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
      this.rawClassifierScores.clear();
      for (let i = 0; i < tealBlobs.length; i++) {
        const key = tealBlobs[i].cx + ',' + tealBlobs[i].cy;
        const norm = normalizedScores[i];
        this.rawClassifierScores.set(key, rawScores[i] ?? 0);

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

      const verdicts = this.classifier.lastVerdicts?.();
      if (verdicts && verdicts.length === tealBlobs.length) {
        this.teammateVerdicts.update(tealBlobs.map(b => ({ x: b.cx, y: b.cy })), verdicts,
          performance.now(), this.expectedIconDiam);
      }

      this.weighWrongLock(tealBlobs, normalizedScores, maxRaw >= MIN_RAW_THRESHOLD);

      const images = this.debugSink ? this.classifier.lastCrops?.() : undefined;
      if (this.debugSink && images && images.length === tealBlobs.length) {
        this.debugSink.onClassifierRun(tealBlobs.map((b, i) => ({
          image: images[i],
          cx: b.cx,
          cy: b.cy,
          raw: rawScores[i] ?? 0,
          smoothed: this.classifierScores.get(b.cx + ',' + b.cy) ?? 0,
        })));
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
   * Fold this classifier run into the evidence that the lock is on a blob that
   * is not us (nextWrongLockEvidence). Uses this run's normalized scores, not
   * the EMA: the EMA is what smooths a single wrong run, and the evidence
   * already needs six of them.
   *
   * Only while LOCKED and actually following something — a hold, or an enemy
   * icon over ours, says nothing about which blob we are on.
   */
  private weighWrongLock(tealBlobs: Blob[], scores: number[], discriminating: boolean): void {
    if (this.state !== TrackingState.LOCKED || !this.lastPixelPos || !this.minimapRegion) return;
    if (this.lockedTickCount > 0 || this.occluded) return;
    const last = {
      x: this.lastPixelPos.x - this.minimapRegion.x,
      y: this.lastPixelPos.y - this.minimapRegion.y,
    };
    const near = computeNearFieldPx(this.expectedIconDiam);
    let followed = -1;
    let followedDist = Infinity;
    for (let i = 0; i < tealBlobs.length; i++) {
      const d = Math.hypot(tealBlobs[i].cx - last.x, tealBlobs[i].cy - last.y);
      if (d <= near && d < followedDist) { followed = i; followedDist = d; }
    }
    let best = -1;
    for (let i = 0; i < tealBlobs.length; i++) {
      if (i === followed) continue;
      if (best < 0 || scores[i] > scores[best]) best = i;
    }
    const { evidence, switchTo } = nextWrongLockEvidence(this.wrongLock, {
      followed: followed >= 0 ? { x: tealBlobs[followed].cx, y: tealBlobs[followed].cy } : null,
      followedScore: followed >= 0 ? scores[followed] : 0,
      best: best >= 0 ? { x: tealBlobs[best].cx, y: tealBlobs[best].cy, score: scores[best] } : null,
      discriminating,
    }, performance.now(), this.expectedIconDiam);
    this.wrongLock = evidence;
    if (switchTo) this.wrongLockTarget = switchTo;
  }

  /**
   * Get cached classifier score for a blob.
   * Uses fuzzy matching: finds the closest cached blob center within icon diameter.
   */
  private getClassifierScore(blob: Blob, scores: Map<string, number> = this.classifierScores): number {
    // Exact match first
    const exact = scores.get(blob.cx + ',' + blob.cy);
    if (exact !== undefined) return exact;

    // Fuzzy match: find closest cached center within icon diameter tolerance
    const tolerance = Math.max(5, this.expectedIconDiam * 0.6);
    const toleranceSq = tolerance * tolerance;
    let bestScore = 0;
    let bestDistSq = Infinity;
    for (const [key, score] of scores) {
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
    this.holdReason = null;
    this.lastDebugImageMs = 0;
    this.lastClassifierRunMs = 0;
    this.lastClassifierLogMs = 0;
    this.tickRunning = false;
    this.intervalId = setInterval(() => { void this.tick(); }, intervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * We died: stay where we died until onRespawn.
   *
   * The orchestrator learns of a death from a 3s poll, so by now our icon may
   * already have been gone for a moment and the tracker holding — possibly
   * extrapolating away from the body, possibly already past the point where
   * the orchestrator disowns the position. None of that means anything once we
   * know why the icon went: the position becomes the last place the tracker
   * actually saw us (or the covered-icon anchor), and any hold is cleared so
   * the disown clock cannot run out partway through the death timer. The
   * orchestrator re-owns the position on its next tick.
   *
   * Until v0.5.10 this was never called (death was never detected), and a
   * death handed a covered-icon episode back to an ordinary hold — matching
   * what an undetected death did. With death detected, both now simply hold
   * the body's position.
   */
  onDeath(): void {
    if (this.state === TrackingState.DEAD) return;
    // Only a tracker that has us LOCKED knows where the body is. A tracker that
    // is SCANNING gave up on its last position — possibly long ago, possibly in
    // another lane — so there is no body to be at: the position is cleared and
    // the orchestrator stays team-only until respawn.
    this.deathPosition = this.state === TrackingState.LOCKED
      ? (this.lastSeenPosition ?? this.lastPosition)
      : null;
    this.lastPosition = this.deathPosition;
    this.state = TrackingState.DEAD;
    this.holdStartMs = 0;
    this.holdReason = null;
    this.resetOcclusion();
  }

  onRespawn(): void {
    if (this.state !== TrackingState.DEAD) return;
    this.state = TrackingState.SCANNING;
    this.cameraDwell.reset();
    this.lostAt = null;
    this.bystanders = [];
    this.bystanderBlobs = [];
    this.lastCleanReg = null;
    this.lastPixelPos = null;
    this.deathPosition = null;
    this.lastSeenPosition = null;
    this.lockedTickCount = 0;
    this.scanFrameCount = 0;
    this.scanStartMs = performance.now();
    this.holdStartMs = 0;
    this.holdReason = null;
    this.resetOcclusion();
  }

  /**
   * The user says the position is wrong ("re-find me"): drop the lock and scan
   * the minimap again, steering the scan away from where we were.
   *
   * For the cases the tracker cannot catch on its own — a lock on something
   * that is not us, with a classifier too quiet to say so. Returns false while
   * dead: the position is the body, and the respawn rescans anyway.
   */
  resetPosition(): boolean {
    if (this.state === TrackingState.DEAD) return false;
    const was = this.state === TrackingState.LOCKED && this.lastPixelPos && this.minimapRegion
      ? { x: this.lastPixelPos.x - this.minimapRegion.x, y: this.lastPixelPos.y - this.minimapRegion.y }
      : null;
    this.restartScan();
    this.avoidPoint = was;
    this.avoidOrigin = was;
    this.avoidUntilMs = performance.now() + RESET_AVOID_MS;
    // The scan's avoidance ends at its lock; this keeps the camera from moving
    // us straight back onto the icon the user just rejected once it may.
    if (was) this.cameraDwell.reject(was, computeNearFieldPx(this.expectedIconDiam), performance.now() + CAMERA_REJECT_MS);
    this.debugSink?.markEvent('reset');
    console.log('[Tracking] Position reset by the user — rescanning' +
      (was ? ' (avoiding (' + Math.round(was.x) + ',' + Math.round(was.y) + ') for the next lock, within ' + RESET_AVOID_MS / 1000 + 's)' : ''));
    return true;
  }

  /**
   * Another player in the game pressed RESET with shared RESET on (and so do
   * we): scan the minimap again. Unlike resetPosition nothing is avoided —
   * nobody has said OUR lock is wrong, only that one in the game was. And the
   * scan starts as if the icon had just been lost where the lock was: an icon
   * nothing identifies is taken only within walking reach of there, as after
   * a hold runs out. A clean scan with nothing to go on takes whichever icon
   * has the cleanest ring, so without this a lock that was right could be
   * traded for a teammate across the map. Returns false while dead, as
   * resetPosition does.
   */
  rescan(): boolean {
    if (this.state === TrackingState.DEAD) return false;
    const was = this.state === TrackingState.LOCKED && this.lastPixelPos && this.minimapRegion
      ? { x: this.lastPixelPos.x - this.minimapRegion.x, y: this.lastPixelPos.y - this.minimapRegion.y }
      : null;
    const wasLost = this.lostAt;
    this.restartScan();
    this.avoidPoint = null;
    this.avoidOrigin = null;
    this.avoidUntilMs = 0;
    // Already scanning after a loss: keep that loss's spot and clock.
    if (was) {
      this.lostAt = was;
      this.lostAtMs = performance.now();
    } else {
      this.lostAt = wasLost;
    }
    this.debugSink?.markEvent('shared-reset');
    console.log('[Tracking] Rescanning — shared RESET from another player' +
      (this.lostAt ? ' (within reach of (' + Math.round(this.lostAt.x) + ',' + Math.round(this.lostAt.y) + '))' : ''));
    return true;
  }

  /** What every rescan the tracker is told to do starts from. */
  private restartScan(): void {
    this.state = TrackingState.SCANNING;
    this.lostAt = null;
    this.bystanders = [];
    this.bystanderBlobs = [];
    this.lastCleanReg = null;
    this.lastPixelPos = null;
    this.lockedTickCount = 0;
    this.scanFrameCount = 0;
    this.scanStartMs = performance.now();
    this.holdStartMs = 0;
    this.holdReason = null;
    this.velocityX = 0;
    this.velocityY = 0;
    this.wrongLock = emptyWrongLockEvidence();
    this.wrongLockTarget = null;
    this.resetOcclusion();
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

  private createMask(frame: CaptureFrame, region: { x: number; y: number; width: number; height: number }): Uint8Array {
    const { data, width } = frame;
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
  private filterIconBlobs(blobs: Blob[], mask: Uint8Array, w: number, h: number): Blob[] {
    const diam = this.expectedIconDiam;
    if (diam < 5) return blobs;

    const minSize = diam * 0.6;
    const maxSize = diam * 1.6;

    const out: Blob[] = [];
    for (const b of blobs) {
      if (!this.isIconSized(b, minSize, maxSize)) continue;
      if (b.fillRatio <= 0.40) { out.push(b); continue; }
      // Too filled for a bare ring — unless a ring runs round it: an icon
      // whose own art is teal (filledIconRing).
      const ring = filledIconRing(b, mask, w, h);
      if (ring) out.push({ ...b, cx: ring.cx, cy: ring.cy });
    }
    return out;
  }

  /** Every icon test but the fill ratio's upper bound. */
  private isIconSized(b: Blob, minSize: number, maxSize: number): boolean {
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
    // Minion groups: fillRatio > 0.40 (many pixels clumped together) —
    // the caller applies that bound, with its one exception.
    // Too sparse means noise, not a real border
    if (b.fillRatio < 0.08) return false;
    return true;
  }

  // --- Movement path line detection (white pixels near teal blobs) ---

  // Cached viewport mask (white pixels that are part of long straight runs)
  private viewportMask: Uint8Array | null = null;
  // Centre of the camera viewport rectangle in game coords (#36), refreshed
  // every tick while enabled. null when no plausible rectangle was found this
  // frame, or when camera tracking is off.
  private cameraTrackingEnabled = false;
  private cameraPosition: Position | null = null;
  // Why the last frame produced no camera centre, for the panel/log. A bare
  // "not readable" cannot distinguish a white-threshold problem from a
  // shape-plausibility one, and those need opposite fixes.
  private cameraMiss: ViewportMiss | null = null;
  private cameraMarkedPixels = 0;
  // The rectangle itself (region px) this frame, read whether or not voice on
  // camera is on: which teammate icon the player keeps on screen is how a
  // wrong lock is found (see CameraDwell). Nothing about it leaves the tracker.
  private cameraBox: ViewportBox | null = null;
  private cameraDwell = new CameraDwell();
  // When the last lock or camera-driven switch happened; the camera may not
  // move us again for CAMERA_SWITCH_COOLDOWN_MS after either.
  private lastLockChangeMs = 0;
  private lastDwellLogMs = 0;

  /**
   * Build a mask of white pixels, marking those that belong to the camera viewport
   * rectangle (long horizontal/vertical runs) so they can be excluded from path detection.
   * Viewport edges are long straight lines (15+ pixels); the movement path line is short/diagonal.
   */
  private buildWhiteMasks(
    frame: CaptureFrame,
    region: { x: number; y: number; width: number; height: number },
  ): { whiteMask: Uint8Array; viewportMask: Uint8Array } {
    const { data, width: imgW } = frame;
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
    frame?: CaptureFrame, region?: { x: number; y: number; width: number; height: number },
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
      } else if (frame && region) {
        // Show non-viewport white pixels as yellow (movement path line)
        const srcIdx = ((region.y + Math.floor(i / w)) * frame.width + (region.x + (i % w))) * 4;
        const r = frame.data[srcIdx];
        const g = frame.data[srcIdx + 1];
        const b = frame.data[srcIdx + 2];
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

  /**
   * One scan frame. Public, and returns its promise, so a caller can step the
   * pipeline deterministically a frame at a time (tests/cv); in the app the
   * interval installed by start() is the only caller and ignores the promise.
   */
  async tick(): Promise<void> {
    if (this.state === TrackingState.DEAD) {
      // Ahead of the tick guard and the dt bookkeeping on purpose: there is no
      // champion on screen to track — and the overlay still needs a position
      // every tick while you wait.
      if (this.deathPosition && this.onPositionUpdate) {
        this.onPositionUpdate(this.deathPosition);
      }
      await this.deadCameraTick();
      return;
    }

    // Drop tick if the previous one is still in flight (capture + CV + classifier
    // can exceed the interval at high scan rates). Better to skip than to pile up.
    if (this.tickRunning) return;
    this.tickRunning = true;

    const tickNow = performance.now();
    this.lastDtSec = (tickNow - this.lastTickMs) / 1000;
    this.lastTickMs = tickNow;

    try {
      const buffer = await this.frameSource.capture();
      try {
        this.processFrame(buffer);
      } catch (err) {
        // Kept separate from the capture failure below: "the backend couldn't
        // grab the screen" and "the frame it grabbed isn't one we can use"
        // have nothing in common except the symptom.
        this.logCaptureError('[Tracking] frame decode failed:', err);
      }
    } catch (err) {
      this.logCaptureError('[Tracking] capture_minimap failed:', err);
    } finally {
      this.tickRunning = false;
    }
  }

  /**
   * While dead, keep reading only the camera rectangle, a few times a second,
   * so "voice on camera" follows where the player is watching exactly as it
   * does while alive. Skipped entirely with the setting off, so a dead
   * champion otherwise still costs no capture. Without this the camera froze
   * at the moment of death for the whole timer.
   */
  private lastDeadCameraMs = 0;
  private async deadCameraTick(): Promise<void> {
    if (!this.cameraTrackingEnabled || !this.minimapRegion || this.tickRunning) return;
    const now = performance.now();
    if (now - this.lastDeadCameraMs < 200) return;
    this.lastDeadCameraMs = now;
    this.tickRunning = true;
    try {
      const frame = decodeCaptureFrame(await this.frameSource.capture());
      if (frame.width !== this.captureBounds.width || frame.height !== this.captureBounds.height) return;
      const { viewportMask } = this.buildWhiteMasks(frame, this.minimapRegion);
      this.updateCameraPosition(viewportMask, this.minimapRegion);
    } catch (err) {
      this.logCaptureError('[Tracking] capture while dead failed:', err);
    } finally {
      this.tickRunning = false;
    }
  }

  /**
   * The tick runs at up to 60 Hz and core/logging.ts turns every console.error
   * into a flushed file write, so a persistent failure (bounds off-screen, game
   * gone, a frame we can't use) must not be logged per frame.
   */
  private logCaptureError(label: string, err: unknown): void {
    const msg = label + ' ' + String(err);
    const now = performance.now();
    if (msg === this.lastCaptureError && now - this.lastCaptureErrorMs < 5000) return;
    this.lastCaptureError = msg;
    this.lastCaptureErrorMs = now;
    console.error(label, err);
  }

  /** Debug toggle lives on `window` — see core/window-globals.ts. */
  private debugOn(): boolean {
    return typeof window !== 'undefined' && window.__lolproxchat_debug_enabled === true;
  }

  private processFrame(buffer: ArrayBuffer): void {
    const frame = decodeCaptureFrame(buffer);

    // Every CV read is indexed against captureBounds, not against the frame, so
    // a frame of a different size would shear createMask's row stride: reads
    // run off the end of each row, the mask comes back all zeros, and tracking
    // sits in SCANNING with nothing to show for it. Refuse it instead, and
    // re-push the bounds once per distinct bad size — that is the only recovery
    // available from here, and doing it unconditionally would be a 30 Hz IPC loop.
    if (frame.width !== this.captureBounds.width || frame.height !== this.captureBounds.height) {
      const size = frame.width + 'x' + frame.height;
      if (this.lastFrameSizeResync !== size) {
        this.lastFrameSizeResync = size;
        this.initCaptureBounds().catch((err) => {
          this.logCaptureError('[Tracking] capture bounds resync failed:', err);
        });
      }
      throw new Error('capture frame is ' + size + ' but capture bounds are ' +
        this.captureBounds.width + 'x' + this.captureBounds.height);
    }
    this.lastFrameSizeResync = '';

    // Minimap region is set from game.cfg config (or manual calibration).
    // No CV-based auto-detection needed.
    if (!this.minimapRegion && this.userMinimapRegion) {
      this.minimapRegion = this.userMinimapRegion;
      this.expectedIconDiam = Math.round(this.minimapRegion.width * 0.087);
    }

    if (!this.minimapRegion) return;

    // Create filtered mask and find blobs
    const region = this.minimapRegion;
    this.debugSink?.onFrame(frame, region);
    let mask = this.createMask(frame, region);
    mask = this.dilate(mask, region.width, region.height);
    const allBlobs = this.findBlobs(mask, region.width, region.height);
    const iconBlobs = this.excludeTeammates(
      this.excludeBystanders(this.filterIconBlobs(allBlobs, mask, region.width, region.height)));
    this.occluderBlobs = allBlobs.filter(b => isPossibleOccluder(b, this.expectedIconDiam));
    this.stackBlobs = allBlobs.filter(b => isPossibleStack(b, this.expectedIconDiam));
    this.frameTealIcons = iconBlobs.filter(b => b.color === 'teal');
    this.minimapReadable = allBlobs.length > 0;

    // Regenerate the debug-mode filtered image at 5Hz (scan-rate independent).
    // This is what makes the debug overlay feel "live" without paying the
    // canvas-encode cost on every tick.
    //
    // Only while Debug is on: generateFilteredImage ends in a PNG encode, and
    // the orchestrator re-serialises whatever it produced over the Tauri event
    // bus at the scan rate, where overlay.ts drops it unless Debug is on.
    const nowMs = performance.now();
    if (this.debugOn()) {
      if (nowMs - this.lastDebugImageMs >= 200) {
        this.lastDebugImageMs = nowMs;
        this.filteredImageUrl = this.generateFilteredImage(mask, region.width, region.height, iconBlobs, frame, region);
      }
    } else if (this.filteredImageUrl !== null) {
      this.filteredImageUrl = null;
    }

    this.diagCounter++;

    // Build white pixel masks (separating movement path from viewport rectangle)
    const { whiteMask, viewportMask } = this.buildWhiteMasks(frame, region);

    // Camera viewport centre → game coords, for "voice on camera" (#36).
    // Cheap (two counting passes over a mask we already built) and
    // independent of lock state, so it keeps working while the tracker
    // is SCANNING.
    this.updateCameraPosition(viewportMask, region);
    const ownIcons = [...iconBlobs, ...this.bystanderBlobs, ...this.teammateBlobs].filter(b => b.color === 'teal');
    this.cameraDwell.update(ownIcons.map(b => ({ x: b.cx, y: b.cy })), this.cameraBox,
      nowMs, this.lastDtSec * 1000, this.expectedIconDiam);
    this.logCameraDwell(nowMs);

    // Run classifier at most every 500ms (scan-rate independent). Excluded
    // bystander icons are scored too: the classifier vouching for one is what
    // releases it (excludeBystanders).
    const tealBlobs = [...iconBlobs, ...this.bystanderBlobs, ...this.teammateBlobs].filter(b => b.color === 'teal');
    if (
      this.classifier &&
      tealBlobs.length > 0 &&
      !this.classifierRunning &&
      nowMs - this.lastClassifierRunMs >= 500
    ) {
      this.classifierRunning = true;
      this.lastClassifierRunMs = nowMs;
      this.updateClassifierScores(tealBlobs, frame, region).finally(() => {
        this.classifierRunning = false;
      });
    }

    if (this.state === TrackingState.SCANNING) {
      this.handleScanning(iconBlobs, whiteMask, viewportMask, region);
    } else if (this.state === TrackingState.LOCKED) {
      this.handleLocked(iconBlobs, whiteMask, viewportMask, region);
    }
  }

  /**
   * Scan: initial identification of the local player's teal blob.
   * Uses a unified composite score (classifier, movement path, ring quality).
   * Runs at game start, after respawn, after a hold outlasts
   * FORCED_REACQUIRE_HOLD_MS, and when the user resets the position.
   */
  private handleScanning(
    iconBlobs: Blob[],
    whiteMask: Uint8Array,
    viewportMask: Uint8Array,
    region: { x: number; y: number; width: number; height: number },
  ): void {
    if (!this.minimapRegion) return;

    let tealBlobs = iconBlobs.filter(b => b.color === 'teal');
    // A bystander with our movement path drawn from it is us after all: the
    // icon we lost reappeared within two icons of where we were, but beyond
    // the hold's near field. Exclusion is released only by the classifier
    // otherwise, and a silent classifier would never release it.
    const pathed = this.bystanderBlobs.filter(b =>
      b.color === 'teal' && this.whitePixelScore(b, whiteMask, viewportMask, region.width, region.height) > 0);
    if (pathed.length > 0) {
      this.bystanders = this.bystanders.filter(o => !pathed.some(b => b.cx === o.x && b.cy === o.y));
      this.bystanderBlobs = this.bystanderBlobs.filter(b => !pathed.includes(b));
      tealBlobs = [...tealBlobs, ...pathed];
      console.log('[Tracking] Movement path drawn from an icon set aside as a teammate\'s — considering it again');
    }
    if (tealBlobs.length === 0) return;
    let avoidedSomething = false;

    // After a user reset, leave out the blob we were locked on — the user just
    // told us it is not them — unless the classifier vouches for it, or it is
    // the only candidate there is.
    //
    // The avoided blob is followed while we scan, and the avoidance dropped the
    // moment it moves: what RESET is for is a lock stuck on something static
    // (a ward). A blob that walks away is a champion — quite possibly us, with
    // RESET pressed on a lock that was right — and the ordinary scan decides.
    if (this.avoidPoint && performance.now() < this.avoidUntilMs && this.avoidOrigin) {
      const radius = Math.max(5, this.expectedIconDiam * 0.6);
      // Follow it in small steps only: a champion moves under a pixel a frame,
      // and anything further is a different icon or a frame the avoided blob
      // was not seen on — neither of which says it moved.
      const still = Math.max(3, this.expectedIconDiam * WRONG_LOCK_STILL_FRACTION);
      let nearest: Blob | null = null;
      let nearestDist = still;
      for (const b of tealBlobs) {
        const d = Math.hypot(b.cx - this.avoidPoint.x, b.cy - this.avoidPoint.y);
        if (d <= nearestDist) { nearest = b; nearestDist = d; }
      }
      if (nearest) this.avoidPoint = { x: nearest.cx, y: nearest.cy };
      const moved = Math.hypot(this.avoidPoint.x - this.avoidOrigin.x, this.avoidPoint.y - this.avoidOrigin.y);
      if (moved > still) {
        console.log('[Tracking] The spot reset away from moved — it is a champion, not a marker; scanning normally');
        this.avoidPoint = null;
      } else if (performance.now() - (this.avoidUntilMs - RESET_AVOID_MS) < RESET_OBSERVE_MS) {
        // Still there and not moved yet: watch it a little longer before
        // locking anything, or a champion walking at ordinary speed would be
        // ruled out before it had covered the distance that clears it.
        return;
      } else {
        const avoid = this.avoidPoint;
        const others = tealBlobs.filter(b =>
          Math.hypot(b.cx - avoid.x, b.cy - avoid.y) > radius || this.getClassifierScore(b) >= 0.5);
        if (others.length > 0 && others.length < tealBlobs.length) {
          tealBlobs = others;
          avoidedSomething = true;
        }
      }
    }

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

    // The icon the player has kept on screen while the others were not is us,
    // whatever the classifier makes of it. Not one the user just reset away
    // from: they have told us that one is wrong.
    //
    // Within walking reach of where a hold ran out, like any icon nothing
    // else identifies: after a recall the player's camera is often still on
    // the lane, on whichever teammate is there, while their own icon sits in
    // the fountain where the camera is not.
    const favourite = cameraFavourite(this.cameraDwell.readings(performance.now()));
    if (favourite) {
      const near = computeNearFieldPx(this.expectedIconDiam);
      const resetRadius = Math.max(5, this.expectedIconDiam * 0.6);
      const avoided = this.avoidPoint && performance.now() < this.avoidUntilMs &&
        Math.hypot(favourite.x - this.avoidPoint.x, favourite.y - this.avoidPoint.y) <= resetRadius;
      const outOfReach = this.lostAt &&
        Math.hypot(favourite.x - this.lostAt.x, favourite.y - this.lostAt.y) >
          rescanReachPx(this.expectedIconDiam, performance.now() - this.lostAtMs);
      const pick = avoided || outOfReach ? null : this.nearestBlob(tealBlobs, favourite, near);
      if (pick) {
        this.lockOnBlob(pick, 'camera(on screen ' + Math.round(favourite.dwell * 100) + '% of the last ' +
          Math.round(favourite.readableMs / 1000) + 's)');
        return;
      }
    }

    let bestBlob = tealBlobs[0];
    let bestScore = -Infinity;
    // Per-term breakdown of the winner, for the lock-on log. Issue #13 is
    // diagnosed from user logs, and a composite alone cannot tell us whether
    // the classifier or the white-pixel heuristic chose the blob.
    let bestTerms = '';
    let bestWhite = 0;

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
      const whiteScore = this.whitePixelScore(b, whiteMask, viewportMask, region.width, region.height);
      const clsScore = clsScores[i];
      const ringScore = Math.min(1, b.pixels * (1 - b.fillRatio) / 200);

      // The divisions renormalize away a peer-avoidance term that held 0.20
      // (resp. 0.40) here and scored a constant 1.0 for every candidate, since
      // no peer coordinates have reached a client since the v0.2 server-side-
      // positions refactor — see computeBlobScore and docs/threat-model.md,
      // "Why clients are not told ally positions". Dividing rather than
      // pre-computing the decimals keeps the surviving weights in exactly the
      // ratios this scoring has always used.
      const score = classifierUsable
        ? (clsScore * 0.45 + whiteScore * 0.25 + ringScore * 0.10) / 0.80
        : (whiteScore * 0.35 + ringScore * 0.25) / 0.60;

      // Rescanning after a hold ran out: we were somewhere a moment ago, so an
      // icon nothing identifies — no classifier vouching for it, no movement
      // path — further away than we could have walked since is someone else.
      // Locking it anyway is how the v0.5.12 log put a player on top of their
      // teammate for most of a game. Such candidates are skipped; with none
      // left the tracker stays SCANNING (team-only) until something identifies
      // us or comes within reach. The reach grows at walking speed, so this
      // cannot stall for good.
      if (this.lostAt) {
        // The smoothed score is normalized to the best icon in view, so a
        // near-silent model makes one icon "identified" at 1.0; the raw output
        // has to say something too (the 2026-10-07 log's far re-locks).
        const identified = (classifierUsable && clsScore >= 0.5 &&
          this.getClassifierScore(b, this.rawClassifierScores) >= FAR_REACQUIRE_MIN_RAW) ||
          whiteScore > 0;
        const reach = rescanReachPx(this.expectedIconDiam, performance.now() - this.lostAtMs);
        if (!identified && Math.hypot(b.cx - this.lostAt.x, b.cy - this.lostAt.y) > reach) continue;
      }

      if (score > bestScore) {
        bestScore = score;
        bestBlob = b;
        bestWhite = whiteScore;
        bestTerms = 'cls=' + clsScore.toFixed(2) +
          ' white=' + whiteScore.toFixed(2) +
          ' ring=' + ringScore.toFixed(2);
      }
    }

    // v0.3.1: reverted the v0.3.0 shouldAcceptLocked classifier gate. It hard-
    // blocked this transition whenever classifier confidence was low, which is
    // the normal case for champions the 172-class classifier is weak on (e.g.
    // Teemo) — so the tracker refused to lock at all and never broadcast a
    // position. The classifier still contributes to the composite score above;
    // it's just no longer a veto. The whole classifier-confidence path is being
    // replaced by template matching in v0.4 (docs/plans/2026-06-03-cv-tracking-research.md).
    // A user reset that ruled out the old spot, with nothing that actually
    // identifies us — no classifier signal, no movement path — would lock on
    // whichever icon has the cleanest ring: an arbitrary ally, which Phase 1
    // then follows and nothing corrects. Wait instead (we are team-only while
    // scanning) until the player walks or the classifier speaks, for as long
    // as the reset's window lasts; after that, scan as usual.
    if (avoidedSomething && !classifierUsable && bestWhite <= 0) {
      return;
    }

    if (bestScore === -Infinity) return; // every candidate was out of reach

    this.lockOnBlob(bestBlob, 'composite(score=' + bestScore.toFixed(2) + ' ' + bestTerms + ')');
  }

  /** Lock onto a teal blob as the local player */
  private lockOnBlob(blob: Blob, reason: string): void {
    if (!this.minimapRegion) return;

    const cx = this.minimapRegion.x + blob.cx;
    const cy = this.minimapRegion.y + blob.cy;

    this.lastPixelPos = { x: cx, y: cy };
    this.setLastPosition(this.pixelToGamePosition(cx, cy, this.minimapRegion), 'lockOnBlob');
    this.state = TrackingState.LOCKED;
    this.lastLockChangeMs = performance.now();
    this.wrongLock = emptyWrongLockEvidence();
    this.wrongLockTarget = null;
    this.avoidPoint = null;
    this.lostAt = null;
    this.bystanders = [];
    this.bystanderBlobs = [];
    this.lastCleanReg = null;
    this.lockedTickCount = 0;
    this.scanFrameCount = 0;
    this.scanStartMs = performance.now();
    this.holdStartMs = 0;
    this.holdReason = null;
    this.resetOcclusion();
    // Treat the moment of lock as a "movement" so Phase 2 doesn't start in
    // stationary-stickiness mode before we've seen any real movement.
    this.lastMovementMs = performance.now();
    this.velocityX = 0;
    this.velocityY = 0;

    const bw = blob.maxX - blob.minX + 1;
    const bh = blob.maxY - blob.minY + 1;
    this.debugSink?.markEvent('lock');
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
      this.debugSink?.markEvent('hold-exceeded');
      console.warn('[Tracking] Hold exceeded ' + FORCED_REACQUIRE_HOLD_MS +
        'ms — forcing re-acquisition (back to SCANNING)');
      this.lostAt = {
        x: this.lastPixelPos.x - this.minimapRegion.x,
        y: this.lastPixelPos.y - this.minimapRegion.y,
      };
      this.lostAtMs = performance.now();
      this.markBystanders(iconBlobs.filter(b => b.color === 'teal'), this.lostAt);
      this.state = TrackingState.SCANNING;
      this.holdStartMs = 0;
      this.holdReason = null;
      this.resetOcclusion();
      this.scanFrameCount = 0;
      this.scanStartMs = performance.now();
      return;
    }

    const tealBlobs = iconBlobs.filter(b => b.color === 'teal');
    const redBlobs = this.occluderBlobs;
    const hasClassifier = !!(this.classifier && this.classifier.isLoaded());

    // The icon we follow is a teammate's, the skin match says (excludeTeammates
    // took it out of iconBlobs). Let it go now rather than through a 5s hold,
    // which would keep reporting the teammate's position as ours.
    //
    // Only when it IS the icon we follow: standing where we last were, within
    // a quarter icon. Not while our icon is covered, merged or held — then our
    // last position is where ours went out of sight, and a teammate walking
    // past it is just a teammate; dropping the lock there would cut a cover
    // hold short in the middle of a fight.
    if (!this.occluded && !this.stacked && this.holdStartMs === 0) {
      const at = { x: this.lastPixelPos.x - this.minimapRegion.x, y: this.lastPixelPos.y - this.minimapRegion.y };
      const same = Math.max(3, this.expectedIconDiam * WRONG_LOCK_STILL_FRACTION);
      const mate = this.nearestBlob(this.teammateBlobs, at, same);
      const ours = this.nearestBlob(tealBlobs, at, same);
      if (mate && (!ours || Math.hypot(mate.cx - at.x, mate.cy - at.y) < Math.hypot(ours.cx - at.x, ours.cy - at.y))) {
        this.debugSink?.markEvent('teammate');
        console.warn('[Tracking] The icon we were following is a teammate\'s (skin match) — rescanning');
        this.lostAt = at;
        this.lostAtMs = performance.now();
        this.state = TrackingState.SCANNING;
        this.holdStartMs = 0;
        this.holdReason = null;
        this.resetOcclusion();
        this.scanFrameCount = 0;
        this.scanStartMs = performance.now();
        return;
      }
    }

    // The classifier has been saying for several seconds that the blob we are
    // on is not us and another one is (weighWrongLock). Move to it.
    if (this.wrongLockTarget) {
      const target = this.wrongLockTarget;
      this.wrongLockTarget = null;
      let pick: Blob | null = null;
      let pickDist = computeNearFieldPx(this.expectedIconDiam);
      for (const b of tealBlobs) {
        const d = Math.hypot(b.cx - target.x, b.cy - target.y);
        if (d <= pickDist) { pick = b; pickDist = d; }
      }
      if (pick) {
        console.warn('[Tracking] Locked on a teal icon the classifier says is not us — moving to the one it says is');
        this.acquireViaClassifier(pick, this.getClassifierScore(pick));
        return;
      }
    }

    if (this.cameraSwitch(tealBlobs)) return;

    const lastRegion = {
      x: this.lastPixelPos.x - this.minimapRegion.x,
      y: this.lastPixelPos.y - this.minimapRegion.y,
    };

    if (this.stacked && !findStack(this.stackBlobs, lastRegion, this.expectedIconDiam)) {
      const left = this.resolveStackExit(tealBlobs, lastRegion);
      if (left) tealBlobs.splice(tealBlobs.indexOf(left), 1);
    }

    // No teal blobs at all — extrapolate position using decaying velocity,
    // unless an enemy icon sitting on us explains why ours is not visible.
    if (tealBlobs.length === 0) {
      if (this.stackStep(lastRegion)) return;
      if (this.occlusionStep(redBlobs, lastRegion)) return;
      if (this.lockedTickCount === 0) {
        this.debugSink?.markEvent('lost');
        console.log('[Tracking] Extrapolating position (no teal blobs) ' + this.describeLoss(tealBlobs, redBlobs, lastRegion));
      }
      // Our icon is missing with no other own-team icon in sight. If anything
      // else on the minimap is readable (enemy icons, structures), the capture
      // is fine and we are simply not there: a 'no-match', disowned after 2s.
      // Only a minimap showing nothing at all is the capture failing, which
      // earns the longer 5s wait. This used to be decided on own-team icons
      // alone, on the premise that a real game always draws four allies — not
      // true in a 1v1, where it made every recall take 5s to go quiet.
      //
      // Except with an enemy icon sitting right where we vanished: that is
      // most likely a cover the occlusion check did not catch (an enemy that
      // landed on us in one frame, or came in diagonally), and a recall under
      // an enemy's icon is the rarer case — so it keeps the longer wait.
      const enemyOnUs = !!findOccluder(redBlobs, lastRegion, this.expectedIconDiam);
      this.extrapolatePosition(region, this.minimapReadable && !enemyOnUs ? 'no-match' : 'no-blobs');
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
    };

    // Phase 1: nearest in-range blob with composite scoring. Blobs inside the
    // near-field radius are followed on continuity alone — the classifier only
    // gates candidates further out (see computeNearFieldPx).
    const phase1 = pickBestBlobInRange(
      tealBlobs, lastReg, predicted, maxJumpPx, hasClassifier, scoreFns,
      computeNearFieldPx(this.expectedIconDiam),
    );

    // Covered by an enemy icon: we have not gone anywhere, so do not go looking
    // for ourselves across the map. Real logs showed Phase 2 doing exactly that
    // mid-fight — a confident classifier hit on some other teal blob 3000-7000
    // units away, which put us out of range of the enemy we were standing on.
    if (!phase1 && this.stackStep(lastRegion)) return;
    if (!phase1 && this.occlusionStep(redBlobs, lastRegion)) return;

    // Phase 2: classifier-based long-range reacquire if Phase 1 found nothing
    if (!phase1 && hasClassifier) {
      if (this.holdStartMs === 0) this.holdStartMs = performance.now();
      this.holdReason = 'no-match';
      const stationarySec = this.lastMovementMs > 0 ? (now - this.lastMovementMs) / 1000 : 0;
      const reacquireThreshold = computeReacquireThreshold(stationarySec, holdSec);
      const phase2 = pickClassifierReacquisition(
        tealBlobs, this.reacquireThresholdFn(reacquireThreshold, holdSec, scoreFns.cls), scoreFns.cls);
      if (phase2) {
        this.acquireViaClassifier(phase2.blob, phase2.score);
        return;
      }
    }

    // Phase 3: no blob matched at all — extrapolate
    if (!phase1) {
      if (this.lockedTickCount === 0) {
        this.debugSink?.markEvent('lost');
        console.log('[Tracking] Extrapolating position (no match in range) ' +
          this.describeLoss(tealBlobs, redBlobs, lastReg, maxJumpPx));
        this.holdStartMs = performance.now();
      }
      this.extrapolatePosition(region, 'no-match');
      return;
    }

    this.finalizeLockedFrame(phase1.blob, lastReg, holdSec, redBlobs);
  }

  private nearestBlob(blobs: Blob[], at: { x: number; y: number }, radius: number): Blob | null {
    let pick: Blob | null = null;
    let pickDist = radius;
    for (const b of blobs) {
      const d = Math.hypot(b.cx - at.x, b.cy - at.y);
      if (d <= pickDist) { pick = b; pickDist = d; }
    }
    return pick;
  }

  /**
   * Move the lock to the icon the camera says is us (cameraSwitchTarget): the
   * one the player has kept on screen for most of the last 30s while the one
   * we follow was hardly ever in view. This is what corrects a lock on a
   * teammate the classifier cannot tell apart from us — in the 2026-10-08
   * test, a lock taken in the fountain followed the wrong teammate for four
   * minutes.
   *
   * Only while we are following something cleanly (no hold, nothing covering
   * or merged with our icon), not within CAMERA_SWITCH_COOLDOWN_MS of the last
   * lock change, and never away from an icon in a base: a player shopping or
   * waiting to respawn is looking at the rest of the map, not at themselves.
   */
  private cameraSwitch(tealBlobs: Blob[]): boolean {
    if (!this.lastPixelPos || !this.minimapRegion) return false;
    const now = performance.now();
    if (now - this.lastLockChangeMs < CAMERA_SWITCH_COOLDOWN_MS) return false;
    if (this.holdStartMs > 0 || this.occluded || this.stacked) return false;
    const region = this.minimapRegion;
    const at = { x: this.lastPixelPos.x - region.x, y: this.lastPixelPos.y - region.y };
    const here = this.pixelToGamePosition(this.lastPixelPos.x, this.lastPixelPos.y, region);
    if (isInBaseZone(here, MAP_DIMENSIONS[this.mapType])) return false;
    const near = computeNearFieldPx(this.expectedIconDiam);
    // The model recognising the icon we follow outranks where the camera has
    // been: then the player has simply been watching someone else.
    const followedBlob = this.nearestBlob(tealBlobs, at, near);
    if (followedBlob && this.getClassifierScore(followedBlob, this.rawClassifierScores) >= FAR_REACQUIRE_MIN_RAW) return false;
    const readings = this.cameraDwell.readings(now);
    const followed = readingNear(readings, at, near);
    const target = cameraSwitchTarget(readings, followed);
    if (!target || Math.hypot(target.x - at.x, target.y - at.y) <= near) return false;
    const pick = this.nearestBlob(tealBlobs, target, near);
    if (!pick) return false;
    console.warn('[Tracking] Following a teal icon the camera has hardly shown (' +
      Math.round((followed?.dwell ?? 0) * 100) + '% of the last ' + Math.round((followed?.readableMs ?? 0) / 1000) +
      's) — moving to the one it keeps on screen (' + Math.round(target.dwell * 100) + '%)');
    this.acquireViaClassifier(pick, 0, 'camera');
    return true;
  }

  /** Every 30s with two or more own-team icons in view: each one's dwell. */
  private logCameraDwell(now: number): void {
    if (now - this.lastDwellLogMs < 30_000) return;
    const readings = this.cameraDwell.readings(now);
    if (readings.length < 2 || !this.minimapRegion) return;
    this.lastDwellLogMs = now;
    const at = this.lastPixelPos && this.state === TrackingState.LOCKED
      ? { x: this.lastPixelPos.x - this.minimapRegion.x, y: this.lastPixelPos.y - this.minimapRegion.y }
      : null;
    const followed = at ? readingNear(readings, at, computeNearFieldPx(this.expectedIconDiam)) : null;
    console.log('[Tracking] Camera dwell (on screen / readable of seen): ' + readings.map(r =>
      '(' + Math.round(r.x) + ',' + Math.round(r.y) + ')' + (r === followed ? '*' : '') + '=' +
      Math.round(r.dwell * 100) + '%/' + Math.round(r.readableMs / 1000) + 's of ' + Math.round(r.seenMs / 1000) + 's' +
      (r.rejected ? ' (reset away)' : '')).join(' '));
  }

  /**
   * Per-blob Phase-2 threshold: an icon further than we could have travelled
   * since we were last seen needs the classifier to be all but certain (see
   * reacquireThresholdAt). Logs the first refusal of each hold.
   */
  private reacquireThresholdFn(
    ordinary: number,
    holdSec: number,
    cls: (b: Blob) => number,
  ): (b: Blob) => number {
    const region = this.minimapRegion;
    const lastSeen = this.lastSeenPosition;
    if (!region || !lastSeen) return () => ordinary;
    const map = MAP_DIMENSIONS[this.mapType];
    return (b) => {
      const at = this.pixelToGamePosition(region.x + b.cx, region.y + b.cy, region);
      let threshold = reacquireThresholdAt(ordinary, at, lastSeen, holdSec, map);
      const score = cls(b);
      const raw = this.getClassifierScore(b, this.rawClassifierScores);
      // The smoothed score is normalized to the best blob in view, so it climbs
      // to 1.0 on whichever icon a near-silent model ranks first; a far jump
      // also needs the model itself to say something.
      if (threshold > ordinary && raw < FAR_REACQUIRE_MIN_RAW) threshold = Infinity;
      if (threshold > ordinary && score >= ordinary &&
          this.farRefusalLoggedHold !== this.holdStartMs &&
          performance.now() - this.farRefusalLoggedMs >= 5000) {
        if (score < threshold) {
          this.farRefusalLoggedHold = this.holdStartMs;
          this.farRefusalLoggedMs = performance.now();
          this.debugSink?.markEvent('far-refused');
          console.log('[Tracking] Not re-acquiring at game(' + Math.round(at.x) + ',' + Math.round(at.y) +
            '): ' + Math.round(Math.hypot(at.x - lastSeen.x, at.y - lastSeen.y)) +
            ' units from where we were seen ' + holdSec.toFixed(1) + 's ago needs cls>=' +
            FAR_REACQUIRE_THRESHOLD.toFixed(2) + ' and raw>=' + FAR_REACQUIRE_MIN_RAW.toFixed(2) +
            ', got cls=' + score.toFixed(2) + ' raw=' + raw.toFixed(3));
        }
      }
      return threshold;
    };
  }

  private farRefusalLoggedHold = -1;
  // Short holds come one after another while a far icon is refused; one line
  // per hold logged twenty in five seconds (the 2026-10-08 Ekko log).
  private farRefusalLoggedMs = -Infinity;

  /** Phase 2 success path: snap position, reset velocity, log, fire callback. */
  private acquireViaClassifier(blob: Blob, clsScore: number, via?: string): void {
    if (!this.minimapRegion) return;
    this.lastLockChangeMs = performance.now();
    const cx = this.minimapRegion.x + blob.cx;
    const cy = this.minimapRegion.y + blob.cy;
    this.lastPixelPos = { x: cx, y: cy };
    const newPos = this.pixelToGamePosition(cx, cy, this.minimapRegion);
    this.setLastPosition(newPos, 'classifier-reacquire');
    this.resetOcclusion();
    this.bystanders = [];
    this.bystanderBlobs = [];
    this.lastCleanReg = null;
    this.wrongLock = emptyWrongLockEvidence();
    this.wrongLockTarget = null;
    this.velocityX = 0;
    this.velocityY = 0;
    this.lockedTickCount++;
    this.debugSink?.markEvent(via ? 'camera-switch' : 'reacquired');
    console.log('[Tracking] Re-acquired via ' + (via ?? 'classifier (cls=' + clsScore.toFixed(2) + ')') +
      ': pixel(' + cx + ',' + cy + ')' +
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
    redBlobs: Blob[],
  ): void {
    if (!this.minimapRegion) return;
    if (this.lockedTickCount > 0) {
      console.log('[Tracking] Resumed tracking after hold (' + holdSec.toFixed(2) + 's)');
    }

    const occluder = findOccluder(redBlobs, { x: blob.cx, y: blob.cy }, this.expectedIconDiam);
    const centre = occluder ? this.coverCorrectedCentre(blob, occluder, redBlobs) : { x: blob.cx, y: blob.cy };
    // Our icon on its own — one icon's size, nothing over it: remember where,
    // which is how stackStep knows our side of a pair we merge into next.
    if (!occluder && blob.maxX - blob.minX + 1 <= this.expectedIconDiam * 1.2 &&
        blob.maxY - blob.minY + 1 <= this.expectedIconDiam * 1.2) {
      this.lastCleanReg = { x: blob.cx, y: blob.cy };
      this.lastCleanMs = performance.now();
    }
    const cx = this.minimapRegion.x + centre.x;
    const cy = this.minimapRegion.y + centre.y;

    // Velocity EMA — preserve per-frame-at-8-FPS behavior across scan rates.
    // weight_old = 0.5^(TUNED_FPS * dt); at 8 FPS dt=0.125 → weight_old = 0.5.
    const velWeightOld = Math.pow(0.5, TrackingService.TUNED_FPS * this.lastDtSec);
    const velWeightNew = 1 - velWeightOld;
    this.velocityX = this.velocityX * velWeightOld + (centre.x - lastReg.x) * velWeightNew;
    this.velocityY = this.velocityY * velWeightOld + (centre.y - lastReg.y) * velWeightNew;

    // Track real movement so Phase 2 can prefer stationary "stickiness".
    const moveDx = centre.x - lastReg.x;
    const moveDy = centre.y - lastReg.y;
    if (moveDx * moveDx + moveDy * moveDy > 9 /* 3px */) {
      this.lastMovementMs = performance.now();
    }

    this.lastPixelPos = { x: cx, y: cy };
    this.setLastPosition(this.pixelToGamePosition(cx, cy, this.minimapRegion), 'locked-track');
    this.lockedTickCount = 0;
    this.holdStartMs = 0;
    this.holdReason = null;
    if (this.stacked) {
      console.log('[Tracking] Own icon separate from the teammate\'s again after ' +
        ((performance.now() - this.stackedSinceMs) / 1000).toFixed(2) + 's');
    }
    this.endOcclusion();
    // After endOcclusion, which clears the coverage flag this sets.
    this.noteIconCoverage(blob, !!occluder);

    if (this.onPositionUpdate && this.lastPosition) {
      this.onPositionUpdate(this.lastPosition);
    }
  }

  /**
   * Record how much of our icon is showing, on every frame we find it.
   *
   * A covered icon disappears gradually: as an enemy icon slides over it, the
   * visible part of our ring shrinks for a few frames before the blob detector
   * loses it. A recall or teleport removes a full-size icon in one frame. That
   * difference is the evidence occlusionStep() needs; an enemy merely being
   * near the spot where we vanished is not — it was what the first version of
   * this used, and adversarial review showed it re-owning recalled positions.
   */
  private noteIconCoverage(blob: Blob, overlapping: boolean): void {
    this.lastSeenPixels = blob.pixels;
    // Learn our icon's usual size only from blobs that look like ONE whole
    // icon: not overlapped, not clipped by the minimap's edge (the fountain sits
    // in a corner), and no bigger than an icon (an ally merged with ours).
    //
    // The pixel baseline is the median of recent samples, one every 250ms over
    // ~10s. Real icons vary a lot with what is behind them — a v0.5.9 game
    // logged 106 to 338 pixels for the same unobstructed icon, terrain pixels
    // joining the ring after dilation — and the previous EMA with a 1.3x cap
    // on growth sank to 130 and refused every larger sample from then on, which
    // made a real cover almost impossible to recognise. A median rides out a
    // brief stacked ally without needing a cap.
    const bw = blob.maxX - blob.minX + 1;
    const bh = blob.maxY - blob.minY + 1;
    const region = this.minimapRegion;
    const atEdge = !!region && (blob.minX <= 1 || blob.minY <= 1 ||
      blob.maxX >= region.width - 2 || blob.maxY >= region.height - 2);
    const singleIcon = !atEdge &&
      bw <= this.expectedIconDiam * 1.2 && bh <= this.expectedIconDiam * 1.2;
    if (!overlapping && singleIcon) {
      const ema = (v: number, x: number) => (v > 0 ? v * 0.9 + x * 0.1 : x);
      this.fullIconW = ema(this.fullIconW, bw);
      this.fullIconH = ema(this.fullIconH, bh);
      const now = performance.now();
      if (this.iconPixelSamples.length === 0 || now - this.lastIconSampleMs >= 250) {
        this.lastIconSampleMs = now;
        this.iconPixelSamples.push(blob.pixels);
        if (this.iconPixelSamples.length > 40) this.iconPixelSamples.shift();
        const sorted = [...this.iconPixelSamples].sort((a, b) => a - b);
        this.fullIconPixels = sorted[Math.floor(sorted.length / 2)];
      }
    }
    this.lastSeenPartlyCovered = overlapping && this.fullIconPixels > 0 &&
      blob.pixels < this.fullIconPixels * COVERED_PIXEL_FRACTION;
  }

  /**
   * What the tracker could see when it lost us, for the log. One line per
   * hold, only at its start. Real logs said only "no match in range", which
   * left a 6-second dropout in a v0.5.9 test game unexplained: nothing
   * recorded whether our icon was covered, too far to accept, or gone.
   */
  private describeLoss(
    tealBlobs: Blob[], redBlobs: Blob[], lastReg: { x: number; y: number }, maxJumpPx?: number,
  ): string {
    const near = (b: Blob) => Math.hypot(b.cx - lastReg.x, b.cy - lastReg.y);
    const fmt = (b: Blob) => '(' + b.cx.toFixed(0) + ',' + b.cy.toFixed(0) + ' d=' + near(b).toFixed(0) +
      ' ' + (b.maxX - b.minX + 1) + 'x' + (b.maxY - b.minY + 1) + ' px=' + b.pixels + ')';
    const closest = (bs: Blob[]) => [...bs].sort((a, b) => near(a) - near(b)).slice(0, 3).map(fmt).join(' ') || 'none';
    return '| last=(' + lastReg.x.toFixed(0) + ',' + lastReg.y.toFixed(0) + ')' +
      (maxJumpPx !== undefined ? ' jump=' + maxJumpPx : '') +
      ' iconDiam=' + this.expectedIconDiam +
      ' lastSeen: px=' + (this.lastSeenPixels ?? '?') + '/' + this.fullIconPixels.toFixed(0) +
      (this.lastSeenPartlyCovered ? ' partly-covered' : '') +
      ' | teal: ' + closest(tealBlobs) + ' | red: ' + closest(redBlobs);
  }

  /**
   * Where our icon's centre really is, when an enemy icon covers part of it.
   *
   * The blob is only the uncovered part of our ring, so its centroid sits on
   * the side away from the enemy — measured on the real minimap at up to ~270
   * game units. The other client makes the same error the other way, so a pair
   * actually ~650 apart read as ~1200 and dropped to half volume just before
   * their icons overlapped fully. The side facing away from the enemy is the
   * part still showing, so per axis, if the blob has lost width (or height),
   * measure one full icon in from that far edge instead. Capped at half an
   * icon of correction.
   *
   * Left alone, per axis, whenever which side is covered is not clear —
   * review showed the correction then doubling the error instead of removing
   * it: the occluder point is within 2px of our centroid on that axis (the
   * case for two merged enemy icons), another enemy icon within reach sits on
   * the other side (it may be drawn UNDER ours, and the nearest red blob is
   * not necessarily the one on top), or our icon touches the minimap border,
   * which clips it for a reason that has nothing to do with cover.
   *
   * Limit: an enemy approaching diagonally eats the ring's corner first, and
   * the bounding box only loses width or height late, so this corrects little
   * of a diagonal approach — no worse than uncorrected, but not much better.
   */
  private coverCorrectedCentre(
    blob: Blob, occluder: { x: number; y: number }, redBlobs: Blob[],
  ): { x: number; y: number } {
    const reach = this.expectedIconDiam * 1.6;
    const nearby = redBlobs.filter(b => Math.hypot(b.cx - blob.cx, b.cy - blob.cy) <= reach);
    const region = this.minimapRegion!;
    const axis = (
      lo: number, hi: number, c: number, full: number, towards: number,
      others: number[], limit: number,
    ): number => {
      const size = hi - lo + 1;
      if (full <= 0 || size >= full * 0.9) return c;
      if (lo <= 1 || hi >= limit - 2) return c;
      if (Math.abs(towards - c) < 2) return c;
      const side = Math.sign(towards - c);
      if (others.some(o => Math.sign(o - c) === -side && Math.abs(o - c) >= 2)) return c;
      const fromFarEdge = side > 0 ? lo + (full - 1) / 2 : hi - (full - 1) / 2;
      const maxShift = full / 2;
      return Math.max(c - maxShift, Math.min(c + maxShift, fromFarEdge));
    };
    return {
      x: axis(blob.minX, blob.maxX, blob.cx, this.fullIconW, occluder.x, nearby.map(b => b.cx), region.width),
      y: axis(blob.minY, blob.maxY, blob.cy, this.fullIconH, occluder.y, nearby.map(b => b.cy), region.height),
    };
  }

  /**
   * Handle a frame where our icon was not found, if the reason is that an
   * enemy icon is drawn over it. Returns true if it did.
   *
   * An episode STARTS only on the first frame our icon is missing, only if the
   * last frame we saw it showed it partly covered (noteIconCoverage), and only
   * once between sightings. Never partway through a hold: by then the hold may
   * be a recall the orchestrator has already disowned.
   *
   * It CONTINUES while an enemy icon stays within one icon of the anchor —
   * where the covering icon was at the start — tolerating OCCLUDER_GRACE_MS of
   * frames with no enemy icon there (two red icons touching merge into one blob
   * the detector rejects), up to MAX_OCCLUDED_MS for the whole episode.
   */
  private occlusionStep(redBlobs: Blob[], lastReg: { x: number; y: number }): boolean {
    const now = performance.now();

    if (!this.occluded) {
      const firstLostFrame = this.holdStartMs === 0 && this.lockedTickCount === 0;
      if (!firstLostFrame || this.occludedSinceMs > 0 || !this.lastSeenPartlyCovered) return false;
      const occluder = findOccluder(redBlobs, lastReg, this.expectedIconDiam);
      if (!occluder) return false;
      this.occluded = true;
      this.occludedSinceMs = now;
      this.occluderLastSeenMs = now;
      this.occlusionAnchor = occluder;
      console.log('[Tracking] Own icon covered by an enemy icon — holding there until ours reappears');
    } else {
      if (now - this.occludedSinceMs > MAX_OCCLUDED_MS) {
        return this.stopOccluded('the ' + (MAX_OCCLUDED_MS / 1000) + 's cap');
      }
      if (findOccluder(redBlobs, this.occlusionAnchor!, this.expectedIconDiam)) {
        this.occluderLastSeenMs = now;
      } else if (now - this.occluderLastSeenMs > OCCLUDER_GRACE_MS) {
        return this.stopOccluded('no enemy icon left on the spot');
      }
    }
    this.holdOccluded();
    return true;
  }

  /** End an occlusion episode without our icon having come back. */
  private stopOccluded(why: string): false {
    this.occluded = false;
    console.log('[Tracking] Stopped treating own icon as covered (' + why + ') — holding as lost');
    return false;
  }

  /**
   * Our icon is hidden under an enemy's: report the anchor as our position.
   *
   * Deliberately NOT a hold. A hold is the tracker admitting it does not know
   * where we are, and the orchestrator disowns our position two seconds into
   * one — which is right after a recall and exactly wrong here, where it cut
   * the two players in a fight out of each other's audio every time their
   * icons overlapped. Clearing holdStartMs keeps the disown clock, and the
   * forced re-acquisition at FORCED_REACQUIRE_HOLD_MS, from running.
   *
   * The anchor does not move. Following the covering icon instead was tried
   * and, when we had in fact recalled or teleported from under it, carried our
   * reported position across the map with that enemy for the full cap.
   */
  private holdOccluded(): void {
    if (!this.minimapRegion || !this.occlusionAnchor) return;
    // Counts as a held frame for logging, so reappearing logs "Resumed".
    this.lockedTickCount++;
    this.holdStartMs = 0;
    this.holdReason = null;
    this.velocityX = 0;
    this.velocityY = 0;

    const cx = this.minimapRegion.x + this.occlusionAnchor.x;
    const cy = this.minimapRegion.y + this.occlusionAnchor.y;
    this.lastPixelPos = { x: cx, y: cy };
    this.setLastPosition(this.pixelToGamePosition(cx, cy, this.minimapRegion), 'occluded');
    if (this.onPositionUpdate && this.lastPosition) {
      this.onPositionUpdate(this.lastPosition);
    }
  }

  private endOcclusion(): void {
    if (this.occluded) {
      console.log('[Tracking] Own icon uncovered after ' +
        ((performance.now() - this.occludedSinceMs) / 1000).toFixed(2) + 's');
    }
    this.resetOcclusion();
  }

  /** Forget any occlusion state — on a fresh lock, re-acquire, respawn or rescan. */
  private resetOcclusion(): void {
    this.occluded = false;
    this.occludedSinceMs = 0;
    this.occlusionAnchor = null;
    this.lastSeenPartlyCovered = false;
    this.stacked = false;
    this.stackedSinceMs = 0;
    this.stackPartner = null;
    this.stackOffset = null;
    this.stackPeakPixels = 0;
    this.stackWasWide = false;
  }

  /**
   * The merged blob we were following has come apart. If our icon is there on
   * our side of where the pair was, carry on as normal (separation, or the
   * teammate recalling). If only the teammate's is left, on their side, ours
   * vanished out of the pair — a recall, a teleport, a death — and following
   * the nearest blob on continuity would hand the lock to the teammate. That
   * icon becomes a bystander instead (excludeBystanders); the tracker then
   * holds, and disowns us, as for any recall.
   *
   * Returns the blob it marked, if any.
   */
  private resolveStackExit(tealBlobs: Blob[], lastReg: { x: number; y: number }): Blob | null {
    const partner = this.stackPartner;
    this.stacked = false;
    this.stackPartner = null;
    this.stackOffset = null;
    const half = this.expectedIconDiam * 0.5;
    const near = (p: { x: number; y: number }) => {
      let best: Blob | null = null;
      let bestD = half;
      for (const b of tealBlobs) {
        const d = Math.hypot(b.cx - p.x, b.cy - p.y);
        if (d <= bestD) { best = b; bestD = d; }
      }
      return best;
    };
    if (near(lastReg) || !partner) return null;
    const theirs = near(partner);
    if (!theirs) return null;
    this.bystanders.push({ x: theirs.cx, y: theirs.cy, vouched: 0, lastRunMs: this.lastClassifierRunMs });
    console.log('[Tracking] Own icon gone from beside a teammate\'s — not taking theirs for ours');
    return theirs;
  }

  /**
   * A hold ran out: any icon standing within two icons of where we were is
   * someone else (ours is not visible, or we would not be here). Without this
   * the rescan, which accepts an unidentified icon that close (rescanReachPx),
   * would lock the teammate we were standing beside when we recalled.
   */
  private markBystanders(tealBlobs: Blob[], at: { x: number; y: number }): void {
    for (const b of tealBlobs) {
      if (Math.hypot(b.cx - at.x, b.cy - at.y) > this.expectedIconDiam * 2) continue;
      if (this.bystanders.some(o => Math.hypot(o.x - b.cx, o.y - b.cy) < 1)) continue;
      this.bystanders.push({ x: b.cx, y: b.cy, vouched: 0, lastRunMs: this.lastClassifierRunMs });
    }
  }

  /**
   * Drop bystander icons from this frame's candidates, following each as it
   * walks (a quarter icon a frame at most). One stops being excluded when it
   * can no longer be followed, or when the classifier vouches for it (>= 0.5)
   * on BYSTANDER_VOUCH_RUNS runs in a row. Fewer is not enough: the first
   * score an icon gets is not smoothed, so one noisy run (normalization turns a
   * stray raw score into 1.0 when few icons are on screen) reads 1.0 and then
   * 0.6 on the next silent run — two runs over the bar from a single spike. Cleared when we are found again, on
   * RESET and on respawn; there is no timer, because a timer is what let the
   * rescan lock the teammate as soon as it ran out.
   */
  /**
   * Set aside the own-team icons the skin match calls a teammate's
   * (TeammateVerdicts): never a candidate to lock on — while scanning, one
   * verdict is enough — and one we are locked on is let go (handleLocked).
   */
  private excludeTeammates(blobs: Blob[]): Blob[] {
    const now = performance.now();
    const minRuns = this.state === TrackingState.SCANNING ? 1 : TEAMMATE_VERDICT_RUNS;
    this.teammateBlobs = blobs.filter(b =>
      b.color === 'teal' && this.teammateVerdicts.isTeammate(b.cx, b.cy, now, this.expectedIconDiam, minRuns));
    if (this.teammateBlobs.length === 0) return blobs;
    return blobs.filter(b => !this.teammateBlobs.includes(b));
  }

  private excludeBystanders(blobs: Blob[]): Blob[] {
    this.bystanderBlobs = [];
    if (this.bystanders.length === 0) return blobs;
    const step = Math.max(3, this.expectedIconDiam * WRONG_LOCK_STILL_FRACTION);
    const kept: typeof this.bystanders = [];
    const excluded = new Set<Blob>();
    for (const o of this.bystanders) {
      let match: Blob | null = null;
      let matchD = step;
      for (const b of blobs) {
        if (b.color !== 'teal' || excluded.has(b)) continue;
        const d = Math.hypot(b.cx - o.x, b.cy - o.y);
        if (d <= matchD) { match = b; matchD = d; }
      }
      if (!match) continue;
      if (this.lastClassifierRunMs !== o.lastRunMs) {
        o.lastRunMs = this.lastClassifierRunMs;
        o.vouched = this.getClassifierScore(match) >= 0.5 ? o.vouched + 1 : 0;
      }
      if (o.vouched >= BYSTANDER_VOUCH_RUNS) continue;
      o.x = match.cx;
      o.y = match.cy;
      kept.push(o);
      excluded.add(match);
    }
    this.bystanders = kept;
    this.bystanderBlobs = [...excluded];
    return blobs.filter(b => !excluded.has(b));
  }

  /**
   * Our icon has merged with a teammate's into one blob too big to pass as an
   * icon (isPossibleStack). We are in it: follow it, on our side of the pair,
   * without starting a hold — a hold would disown us after 2s and, at 5s,
   * rescan the minimap, where the teammate's icon is the cleanest candidate
   * left (what the v0.5.12 log showed, repeatedly).
   *
   * Starts only on the first frame our icon is missing, never partway through
   * a hold: by then the hold may be a recall the orchestrator has already
   * disowned, and teammates walking over the spot must not re-own it.
   *
   * Our side: at the start, the last place we saw our icon on its own (if
   * within 10s), clamped into the blob, as an offset from its centroid; from
   * then on we keep that offset, so we move with the pair and stay on our
   * side as it changes shape. The blob's shape changes are not fed into the
   * velocity, which only decays.
   *
   * A two-icon merge needs no cap: if ours leaves it, what is left is one
   * icon, and resolveStackExit handles it. Once the blob has been wider than
   * about two icons, though, what is left after we leave can still be a
   * merged pair, which findStack matches as before. So the episode ends — a
   * hold, which disowns us as for any recall — when the blob loses about an
   * icon's worth of pixels from its peak, and in any case after
   * MAX_STACKED_MS.
   */
  private stackStep(lastReg: { x: number; y: number }): boolean {
    if (!this.minimapRegion) return false;
    const now = performance.now();
    const diam = this.expectedIconDiam;
    const stack = findStack(this.stackBlobs, lastReg, diam);
    if (!stack) return false;
    if (!this.stacked) {
      const firstLostFrame = this.holdStartMs === 0 && this.lockedTickCount === 0;
      if (!firstLostFrame || this.stackedSinceMs > 0) return false;
      this.stacked = true;
      this.stackedSinceMs = now;
      const clean = this.lastCleanReg && now - this.lastCleanMs <= 10_000 ? this.lastCleanReg : lastReg;
      const start = positionInStack(stack, clean, diam);
      this.stackOffset = { x: start.x - stack.cx, y: start.y - stack.cy };
      this.stackPeakPixels = stack.pixels;
      this.stackWasWide = Math.max(stack.maxX - stack.minX + 1, stack.maxY - stack.minY + 1) > diam * 2.1;
      console.log('[Tracking] Own icon merged with a teammate\'s — following the pair until they separate');
    } else {
      const span = Math.max(stack.maxX - stack.minX + 1, stack.maxY - stack.minY + 1);
      if (span > diam * 2.1) this.stackWasWide = true;
      this.stackPeakPixels = Math.max(this.stackPeakPixels, stack.pixels);
      if (this.stackWasWide) {
        const iconPx = this.fullIconPixels > 0 ? this.fullIconPixels : stack.pixels / 2;
        let shrank = stack.pixels < this.stackPeakPixels - iconPx * 0.6;
        // A teammate walking out of the group shows up as an icon beside it;
        // ours vanishing (a recall) leaves nothing. The first is no reason to
        // stop following the rest.
        if (shrank && this.frameTealIcons.some(b =>
          b.cx >= stack.minX - diam * 1.5 && b.cx <= stack.maxX + diam * 1.5 &&
          b.cy >= stack.minY - diam * 1.5 && b.cy <= stack.maxY + diam * 1.5)) {
          shrank = false;
          this.stackPeakPixels = stack.pixels;
        }
        const capped = now - this.stackedSinceMs > MAX_STACKED_MS;
        if (shrank || capped) {
          this.stacked = false;
          this.stackOffset = null;
          console.log(shrank
            ? '[Tracking] An icon left the merged teammate icons we were following — holding as lost'
            : '[Tracking] Stopped following merged teammate icons (the ' + (MAX_STACKED_MS / 1000) + 's cap) — holding as lost');
          return false;
        }
      }
    }

    const off = this.stackOffset ?? { x: 0, y: 0 };
    const p = positionInStack(stack, { x: stack.cx + off.x, y: stack.cy + off.y }, diam);
    this.stackOffset = { x: p.x - stack.cx, y: p.y - stack.cy };
    this.stackPartner = { x: 2 * stack.cx - p.x, y: 2 * stack.cy - p.y };
    const velWeightOld = Math.pow(0.5, TrackingService.TUNED_FPS * this.lastDtSec);
    this.velocityX *= velWeightOld;
    this.velocityY *= velWeightOld;
    // Counts as a held frame for logging and for weighWrongLock (which leaves
    // an ambiguous frame alone), but is not a hold: no disown clock.
    this.lockedTickCount++;
    this.holdStartMs = 0;
    this.holdReason = null;
    this.occluded = false;

    const cx = this.minimapRegion.x + p.x;
    const cy = this.minimapRegion.y + p.y;
    this.lastPixelPos = { x: cx, y: cy };
    this.setLastPosition(this.pixelToGamePosition(cx, cy, this.minimapRegion), 'stacked');
    if (this.onPositionUpdate && this.lastPosition) {
      this.onPositionUpdate(this.lastPosition);
    }
    return true;
  }

  /**
   * Extrapolate position using decaying velocity when tracking is lost.
   * Velocity fades out over ~1 second of wall-clock time, regardless of scan rate.
   * Position is clamped to minimap bounds to prevent drifting off-map.
   */
  private extrapolatePosition(
    region: { x: number; y: number; width: number; height: number },
    reason: Exclude<HoldReason, null>,
  ): void {
    this.lockedTickCount++;
    if (this.holdStartMs === 0) this.holdStartMs = performance.now();
    // 'no-match' is the stronger signal and wins for the rest of the hold: if
    // icons came back and still none of them was us, we moved, whatever the
    // first frame of the hold looked like.
    if (reason === 'no-match' || this.holdReason === null) this.holdReason = reason;

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
