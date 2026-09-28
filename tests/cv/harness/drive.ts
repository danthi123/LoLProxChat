// Drives the real TrackingService a frame at a time and records what it
// reported, so a scenario can be stated as "the icon walked here; the tracker
// should have said this".

import { Position } from '../../../src/core/types';
import { BlobScorer } from '../../../src/services/champion-classifier';
import { TrackingService, TrackingState } from '../../../src/services/tracking';
import { HoldReason } from '../../../src/services/tracking-helpers';
import {
  GAME_RECT,
  MAP,
  MINIMAP_SCALE,
  Point,
  RenderedScene,
  ScriptedFrameSource,
  gameToTruth,
} from './scenes';

/** Frames are 125ms apart: 8 FPS, the rate every per-frame constant is tuned against. */
export const FRAME_MS = 125;

export interface TrackerHarness {
  svc: TrackingService;
  source: ScriptedFrameSource;
  /** Every position handed to the start() callback, in order. */
  emitted: Position[];
}

export interface TrackerOptions {
  classifier?: BlobScorer;
  cameraTracking?: boolean;
  fps?: number;
}

/**
 * A tracker wired to a scripted frame source and warmed up the way start()
 * warms one up.
 *
 * start() immediately followed by stop() is deliberate: start() is the only
 * thing that seeds scanStartMs / lastTickMs / lastClassifierRunMs, and without
 * those the classifier warmup and the velocity EMA run in a timing regime
 * production never sees. Stopping again leaves no live interval competing with
 * driveTracker for frames.
 */
export function newTracker(frames: ArrayBuffer[], opts: TrackerOptions = {}): TrackerHarness {
  const source = new ScriptedFrameSource(frames);
  const svc = new TrackingService(GAME_RECT, MAP, source);
  svc.setMinimapScaleFromConfig(MINIMAP_SCALE);
  if (opts.classifier) svc.setClassifier(opts.classifier);
  if (opts.cameraTracking) svc.setCameraTracking(true);

  const emitted: Position[] = [];
  svc.start((pos) => { emitted.push({ ...pos }); }, opts.fps ?? 8);
  svc.stop();

  return { svc, source, emitted };
}

/** Let the classifier's fire-and-forget scoring land before the next frame. */
export async function flushMicrotasks(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

export interface FrameRecord {
  i: number;
  state: TrackingState;
  /** Reported position in game units, or null before the first lock. */
  game: Position | null;
  /** The same position back in region-relative pixels, for readable errors. */
  px: Point | null;
  truth: Point | null;
  holdSec: number;
  /** Why the tracker is holding this frame, or null if it is not. */
  holdReason: HoldReason;
  /** Positions emitted during this frame (usually 0 or 1). */
  emits: number;
}

/**
 * Step the tracker over a scripted sequence. Time advances BEFORE each frame,
 * so frame i happens at (i + 1) * dtMs on the fake clock and every frame sees a
 * full inter-frame dt — including the first, whose dt the velocity EMA uses.
 */
export async function driveTracker(
  h: TrackerHarness,
  scenes: RenderedScene[],
  dtMs: number = FRAME_MS,
): Promise<FrameRecord[]> {
  const records: FrameRecord[] = [];
  for (let i = 0; i < scenes.length; i++) {
    jest.advanceTimersByTime(dtMs);
    const before = h.emitted.length;
    await h.svc.tick();
    await flushMicrotasks();
    const game = h.svc.getLastPosition();
    records.push({
      i,
      state: h.svc.getState(),
      game: game ? { ...game } : null,
      px: game ? gameToTruth(game) : null,
      truth: scenes[i].truth,
      holdSec: h.svc.getHoldDurationSec(),
      holdReason: h.svc.getHoldReason(),
      emits: h.emitted.length - before,
    });
  }
  return records;
}

export interface DriveMetrics {
  /** Index of the first frame that ended LOCKED, or -1. */
  lockFrame: number;
  maxErrorPx: number;
  meanErrorPx: number;
  /** LOCKED -> SCANNING transitions: forced re-acquisitions. */
  scanningReentries: number;
  /**
   * Longest run of consecutive frames where the reported position did not move
   * while the ground truth did — the shape of the v0.5.8 freeze.
   */
  longestFrozenRun: number;
}

export function metrics(records: FrameRecord[]): DriveMetrics {
  const lockFrame = records.findIndex(r => r.state === TrackingState.LOCKED);

  const errors: number[] = [];
  for (const r of records) {
    if (r.i < lockFrame || lockFrame < 0) continue;
    if (!r.px || !r.truth) continue;
    errors.push(Math.hypot(r.px.x - r.truth.x, r.px.y - r.truth.y));
  }

  let scanningReentries = 0;
  for (let i = 1; i < records.length; i++) {
    if (records[i - 1].state === TrackingState.LOCKED && records[i].state === TrackingState.SCANNING) {
      scanningReentries++;
    }
  }

  let longestFrozenRun = 0;
  let run = 0;
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1];
    const cur = records[i];
    // A frame pair only says something about freezing once there is a reported
    // position to compare: before the first lock there is nothing to move.
    if (!prev.px || !cur.px || !prev.truth || !cur.truth) {
      run = 0;
      continue;
    }
    const truthMoved = Math.hypot(cur.truth.x - prev.truth.x, cur.truth.y - prev.truth.y) > 0.5;
    const reportMoved = Math.hypot(cur.px.x - prev.px.x, cur.px.y - prev.px.y) > 0.5;
    if (truthMoved && !reportMoved) {
      run++;
      if (run > longestFrozenRun) longestFrozenRun = run;
    } else {
      run = 0;
    }
  }

  return {
    lockFrame,
    maxErrorPx: errors.length ? Math.max(...errors) : Infinity,
    meanErrorPx: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : Infinity,
    scanningReentries,
    longestFrozenRun,
  };
}
