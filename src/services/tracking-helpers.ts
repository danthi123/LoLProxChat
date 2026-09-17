// Pure helpers extracted from TrackingService.handleLocked. Each is a
// stateless function with deterministic output for a given input — easy to
// unit-test in isolation. State mutation and side effects (callback firing,
// logging, position updates) stay in TrackingService itself.

import type { Blob } from './blob-types';

/**
 * Maximum allowed per-frame jump distance, in minimap pixels. Allows normal
 * frame-to-frame movement plus a growing search radius while holding position
 * so we can re-acquire a blob that moved during the hold.
 */
export function computeMaxJumpPx(
  expectedIconDiam: number,
  holdStartMs: number,
  nowMs: number,
): number {
  const base = Math.max(20, Math.round(expectedIconDiam * 2.0));
  const holdSec = holdStartMs > 0 ? (nowMs - holdStartMs) / 1000 : 0;
  const holdExpansion = holdSec > 0 ? Math.round(expectedIconDiam * holdSec) : 0;
  return base + holdExpansion;
}

/**
 * Classifier confidence threshold for Phase-2 long-distance re-acquisition.
 * After standing still for a while, raise the bar dramatically — a lost icon
 * is more likely a render glitch than a teleport, and we don't want to lock
 * onto a minion wave. After a brief hold (>1s), lower the threshold for
 * faster recovery from genuine teleports.
 */
export function computeReacquireThreshold(
  stationarySec: number,
  holdSec: number,
): number {
  if (stationarySec > 3) return 0.85;
  if (holdSec > 1.0) return 0.35;
  return 0.5;
}

export interface BlobScoreInputs {
  /** 1 = on the predicted point, decays toward 0 at max-jump edge. */
  posScore: number;
  /** 0..1 classifier confidence for this blob being the local champion. */
  clsScore: number;
  /** 0..1 heuristic on how many "white" (champion-mark) pixels surround the blob. */
  whiteScore: number;
  /** 0..1, lower if the blob is suspiciously close to a known ally peer. */
  peerScore: number;
}

/**
 * Composite score for a candidate blob. When the classifier is loaded we
 * weight its confidence heavily; without it, position dominates.
 */
export function computeBlobScore(s: BlobScoreInputs, hasClassifier: boolean): number {
  return hasClassifier
    ? s.posScore * 0.35 + s.clsScore * 0.30 + s.whiteScore * 0.20 + s.peerScore * 0.15
    : s.posScore * 0.45 + s.peerScore * 0.30 + s.whiteScore * 0.25;
}

/** Minimum classifier confidence to follow a blob during Phase 1 tracking. */
export const CLS_FOLLOW_THRESHOLD = 0.2;

/**
 * Radius (in minimap px) around the predicted position inside which frame-to-frame
 * *continuity* outranks classifier identity — the classifier follow-threshold is
 * not applied to a blob this close.
 *
 * Why this exists (v0.5.8, NotOtakuu's 2026-09-12 log): the 172-class classifier
 * returns raw≈0 for some champions at some minimap scales (his Twisted Fate scored
 * 0.000 every frame). The Phase-1 veto below then rejected the very blob we had
 * locked onto one tick earlier, sitting 0 px from the prediction, so the tracker
 * fell into a permanent lock → hold → forced-reacquire → lock cycle and the
 * broadcast position froze at the lock point. That froze his coords at the
 * fountain, which made every enemy fall outside MAX_HEARING_RANGE — the
 * user-visible symptom was "allies are perfect, enemies are way too quiet".
 *
 * A blob one icon-diameter from where we predicted the icon would be IS the icon;
 * no classifier opinion should override that. Identity still gates the far field,
 * where a wrong pick means clinging to a minion wave or a turret (issue #13).
 *
 * This completes Phase A item 2 of docs/plans/2026-06-03-cv-tracking-research.md
 * ("loosen the over-strict v0.3 gates that gate on classifier confidence"). The
 * sibling gate on the SCANNING→LOCKED transition was already reverted in v0.3.1;
 * this one was missed.
 */
export function computeNearFieldPx(expectedIconDiam: number): number {
  return Math.max(10, Math.round(expectedIconDiam));
}

export interface ScoreFns {
  cls: (b: Blob) => number;
  white: (b: Blob) => number;
  peer: (b: Blob) => number;
}

export interface ScoredBlob {
  blob: Blob;
  score: number;
}

/**
 * Phase 1: pick the best teal blob within jump range of the predicted
 * position.
 *
 * The classifier follow-threshold gates the FAR field only. A blob within
 * `nearFieldPx` of either the predicted position or our last known position is
 * followed on positional continuity alone, whatever the classifier thinks of it
 * (see computeNearFieldPx). Beyond that radius the classifier still has to vouch
 * for the blob, which is what keeps a long hold from snapping the dot onto a
 * minion wave.
 *
 * Returns null when no candidate is in range, or when every in-range candidate
 * is in the far field and below the follow threshold.
 */
export function pickBestBlobInRange(
  tealBlobs: Blob[],
  lastReg: { x: number; y: number },
  predicted: { x: number; y: number },
  maxJumpPx: number,
  hasClassifier: boolean,
  scoreFns: ScoreFns,
  nearFieldPx = 0,
): ScoredBlob | null {
  const maxJumpSq = maxJumpPx * maxJumpPx;
  const nearFieldSq = nearFieldPx * nearFieldPx;
  let best: ScoredBlob | null = null;

  for (const b of tealBlobs) {
    const dxLast = b.cx - lastReg.x;
    const dyLast = b.cy - lastReg.y;
    const distLastSq = dxLast * dxLast + dyLast * dyLast;
    if (distLastSq > maxJumpSq) continue;

    const dxPred = b.cx - predicted.x;
    const dyPred = b.cy - predicted.y;
    const distPredSq = dxPred * dxPred + dyPred * dyPred;
    const posScore = 1 - distPredSq / maxJumpSq;

    // Near field is measured against whichever reference is more forgiving:
    // `predicted` covers smooth movement, `lastReg` covers a standing champion
    // whose velocity EMA hasn't decayed to zero yet.
    // Strict `<` so the default nearFieldPx=0 disables the exemption entirely.
    const isNearField = Math.min(distPredSq, distLastSq) < nearFieldSq;

    const clsScore = scoreFns.cls(b);
    if (hasClassifier && !isNearField && clsScore < CLS_FOLLOW_THRESHOLD) continue;

    const score = computeBlobScore(
      { posScore, clsScore, whiteScore: scoreFns.white(b), peerScore: scoreFns.peer(b) },
      hasClassifier,
    );
    if (!best || score > best.score) best = { blob: b, score };
  }
  return best;
}

/**
 * Phase 2: pick the teal blob with the highest classifier confidence above
 * the (adaptive) reacquire threshold, regardless of distance. Handles
 * teleport, respawn, camera pan, blob-overlap recovery.
 */
export function pickClassifierReacquisition(
  tealBlobs: Blob[],
  threshold: number,
  clsScoreFn: (b: Blob) => number,
): ScoredBlob | null {
  let best: ScoredBlob | null = null;
  for (const b of tealBlobs) {
    const clsScore = clsScoreFn(b);
    if (clsScore < threshold) continue;
    if (!best || clsScore > best.score) best = { blob: b, score: clsScore };
  }
  return best;
}

// ---------- v0.3 tracking tweaks (driven by IXAM's v0.1.33 issue #7 logs) ----------

/**
 * After this many ms of continuous hold, extrapolated position is essentially
 * noise — the player could be anywhere. Force a drop back to SCANNING-style
 * classifier-driven full-minimap search rather than continuing to extend the
 * search box. IXAM's v0.1.33 logs showed 44-second holds during which the
 * orchestrator was sending phantom coords; 5s is the budget for "tracking
 * should have recovered by now or it's time to start over."
 */
export const FORCED_REACQUIRE_HOLD_MS = 5000;

export function shouldForceReacquisition(holdStartMs: number, nowMs: number): boolean {
  if (holdStartMs === 0) return false;
  return (nowMs - holdStartMs) >= FORCED_REACQUIRE_HOLD_MS;
}

/**
 * Standard exponential moving average for classifier confidence. `decay` is
 * the weight kept on the current value; `1 - decay` is the weight of the new
 * raw sample.
 *
 * v0.3.0 added a "snap up to raw on any increase" branch to recover from a
 * stuck-at-0 EMA (IXAM v0.1.33). That root cause was actually the Nunu/Dr.
 * Mundo label-mismatch bug (fixed in v0.2.1 — the classifier was returning 0
 * for every blob), NOT the EMA. The snap-up's real-world effect was harmful:
 * a single false-high raw on a wrong blob (a minion, a structure) latched the
 * EMA to 1.0, making the tracker confidently follow it — the "clinging to
 * minions and structures" failure. Reverted to symmetric EMA in v0.3.1; the
 * whole classifier-confidence path is replaced by template matching in v0.4
 * (see docs/plans/2026-06-03-cv-tracking-research.md).
 */
export function nextClassifierEma(currentEma: number, raw: number, decay: number): number {
  return currentEma * decay + raw * (1 - decay);
}
