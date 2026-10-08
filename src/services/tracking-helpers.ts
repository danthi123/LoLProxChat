// Pure helpers extracted from TrackingService.handleLocked. Each is a
// stateless function with deterministic output for a given input — easy to
// unit-test in isolation. State mutation and side effects (callback firing,
// logging, position updates) stay in TrackingService itself.

import type { Blob } from './blob-types';
import type { Position } from '../core/types';

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

// ---------- how far a re-acquisition may move us ----------

/**
 * Classifier confidence a Phase-2 re-acquisition needs when it would move us
 * further than a champion can travel. The ordinary thresholds (0.35-0.5 after
 * a short hold) were set for finding ourselves again nearby; applied across
 * the map they let a weak score teleport us. In the 2026-10-07 test a Darius in
 * top lane was re-acquired on a teammate's icon in bot lane at 0.64 and then
 * 0.85 — 13,000 units in 0.6 s — so the enemy bot laner heard him and he heard
 * them. Every correct re-acquisition in that log scored 0.99-1.00.
 */
export const FAR_REACQUIRE_THRESHOLD = 0.9;

/**
 * ...and the model's own, un-normalized output for that icon on its latest
 * run. The smoothed score is relative to the best icon in view, so a model
 * that recognises nobody (the median best raw score across that test's logs
 * was 0.002) still drives one icon to 1.0. Across those logs only 10% of runs
 * scored any icon above 0.14.
 */
export const FAR_REACQUIRE_MIN_RAW = 0.3;

/**
 * Game units we may plausibly have covered since we were last seen: an icon's
 * width of measurement slack plus Flash and a dash, then a fast champion's
 * run speed with a margin.
 */
export const REACQUIRE_REACH_BASE_UNITS = 2500;
export const REACQUIRE_REACH_UNITS_PER_SEC = 700;

/** A recall lands in a fountain: within this fraction of the map's width of
 *  either base corner, a long jump is a recall, not a mis-track. */
export const BASE_ZONE_FRACTION = 0.2;

export function reacquireReachUnits(elapsedSec: number): number {
  return REACQUIRE_REACH_BASE_UNITS + REACQUIRE_REACH_UNITS_PER_SEC * Math.max(0, elapsedSec);
}

export function isInBaseZone(p: Position, map: { width: number; height: number }): boolean {
  const r = BASE_ZONE_FRACTION * map.width;
  return Math.hypot(p.x, p.y) <= r || Math.hypot(map.width - p.x, map.height - p.y) <= r;
}

/**
 * The threshold for re-acquiring at `candidate`: the ordinary one when it is
 * within reach of where we were last seen (or in a base), otherwise
 * FAR_REACQUIRE_THRESHOLD. Turning a far candidate down leaves us holding —
 * the 2 s disown then fades enemies out rather than putting us beside the
 * wrong ones.
 */
export function reacquireThresholdAt(
  ordinary: number,
  candidate: Position,
  lastSeen: Position | null,
  elapsedSec: number,
  map: { width: number; height: number },
): number {
  if (!lastSeen) return ordinary;
  const dist = Math.hypot(candidate.x - lastSeen.x, candidate.y - lastSeen.y);
  if (dist <= reacquireReachUnits(elapsedSec)) return ordinary;
  if (isInBaseZone(candidate, map)) return ordinary;
  return Math.max(ordinary, FAR_REACQUIRE_THRESHOLD);
}

export interface BlobScoreInputs {
  /** 1 = on the predicted point, decays toward 0 at max-jump edge. */
  posScore: number;
  /** 0..1 classifier confidence for this blob being the local champion. */
  clsScore: number;
  /** 0..1 heuristic on how many "white" (champion-mark) pixels surround the blob. */
  whiteScore: number;
}

/**
 * Composite score for a candidate blob. When the classifier is loaded we
 * weight its confidence heavily; without it, position dominates.
 *
 * The trailing division renormalizes away a fourth term — a peer-avoidance
 * penalty against known ally positions — that scored a constant 1.0 for every
 * candidate from the v0.2 server-side-positions refactor onward, because no
 * peer coordinates have reached a client since. They are not coming back:
 * docs/threat-model.md, "Why clients are not told ally positions", records why
 * the server must not hand them out. Spelled as a division rather than
 * pre-divided decimals so the surviving weights keep their ratios to each
 * other exactly, which is what makes the removal leave every ranking alone.
 */
export function computeBlobScore(s: BlobScoreInputs, hasClassifier: boolean): number {
  return hasClassifier
    ? (s.posScore * 0.35 + s.clsScore * 0.30 + s.whiteScore * 0.20) / 0.85
    : (s.posScore * 0.45 + s.whiteScore * 0.25) / 0.70;
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
      { posScore, clsScore, whiteScore: scoreFns.white(b) },
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
  threshold: number | ((b: Blob) => number),
  clsScoreFn: (b: Blob) => number,
): ScoredBlob | null {
  let best: ScoredBlob | null = null;
  for (const b of tealBlobs) {
    const clsScore = clsScoreFn(b);
    if (clsScore < (typeof threshold === 'number' ? threshold : threshold(b))) continue;
    if (!best || clsScore > best.score) best = { blob: b, score: clsScore };
  }
  return best;
}

// ---------- an enemy icon drawn over ours ----------

/**
 * How close an enemy icon's centre has to be to our icon for the two to be
 * overlapping: one icon diameter.
 *
 * Measured from where we last SAW ours, which is not our icon's centre. While
 * an enemy icon slides over ours, what the tracker follows on the last visible
 * frames is the uncovered crescent, whose centroid sits on the far side from
 * the enemy — in simulation the enemy's centre was ~0.6 of an icon away when
 * ours finally vanished.
 *
 * An icon is ~1300 game units across at common minimap scales, so proximity
 * alone is weak evidence; what gates an occlusion is our icon having visibly
 * shrunk under the enemy's before it vanished (COVERED_PIXEL_FRACTION).
 */
export function computeOcclusionRadiusPx(expectedIconDiam: number): number {
  return Math.max(10, Math.round(expectedIconDiam));
}

/**
 * Our icon counts as partly covered when an enemy icon overlaps it and fewer
 * than this fraction of its usual pixels are showing. An enemy icon centred a
 * full 0.8 icon away hides about a fifth of our ring, so 0.7 needs a real
 * overlap, not two icons touching.
 */
export const COVERED_PIXEL_FRACTION = 0.7;

/**
 * How long an occlusion survives frames with no enemy icon on the anchor.
 * Two red icons that touch merge into one blob wider than the icon filter
 * allows, so in a 2v1 the covering icon can drop out of detection for a few
 * frames while nothing has actually changed.
 */
export const OCCLUDER_GRACE_MS = 500;

/**
 * The longest one occlusion may keep our position alive. An enemy standing on
 * us for this long in a real fight is rare; an enemy standing on the spot we
 * teleported away from while we were covered is the case this bounds.
 * It is a single budget per lost-icon episode, not per enemy.
 */
export const MAX_OCCLUDED_MS = 10_000;

/**
 * The enemy icon most likely to be drawn over ours, or null if none is close
 * enough to be.
 *
 * When two champions are in melee range their minimap icons overlap, and the
 * one drawn on top hides the other's border. If ours is underneath, the
 * tracker sees no teal blob where we were — which looks exactly like the
 * champion having gone somewhere else, and used to be treated that way: two
 * seconds of it and the orchestrator disowned our position, cutting us out of
 * the audio of the very enemy we were fighting. A red icon sitting on our last
 * position is the positive evidence that we are still there, underneath it.
 */
export function findOccluder(
  enemyBlobs: Blob[],
  at: { x: number; y: number },
  expectedIconDiam: number,
): { x: number; y: number } | null {
  const radius = computeOcclusionRadiusPx(expectedIconDiam);
  const singleMax = expectedIconDiam * 1.6;
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  for (const b of enemyBlobs) {
    const bw = b.maxX - b.minX + 1;
    const bh = b.maxY - b.minY + 1;
    let point: { x: number; y: number };
    let dist: number;
    if (bw <= singleMax && bh <= singleMax) {
      // One icon: overlapping means centres within one diameter.
      point = { x: b.cx, y: b.cy };
      dist = Math.hypot(b.cx - at.x, b.cy - at.y);
      if (dist > radius) continue;
    } else {
      // Two or more enemy icons touching, merged into one blob (a 2v1). Its
      // centroid can sit between them, so measure to the blob's extent
      // instead, and treat the nearest part of it as the covering icon. The
      // extent alone is not enough: a diagonal pair's bounding box has an
      // empty corner that reaches ~2 icons from either of them, so the
      // centroid must also be close — within 1.5 icons, which a pair with one
      // of its icons actually on us always is.
      point = {
        x: Math.max(b.minX, Math.min(b.maxX, at.x)),
        y: Math.max(b.minY, Math.min(b.maxY, at.y)),
      };
      dist = Math.hypot(point.x - at.x, point.y - at.y);
      if (dist > radius / 2) continue;
      if (Math.hypot(b.cx - at.x, b.cy - at.y) > expectedIconDiam * 1.5) continue;
    }
    if (dist < bestDist) {
      best = point;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Red blobs that could be enemy icons covering ours: the icon filter's ring
 * test, but admitting blobs up to ~2.6 icons across. Two enemy icons that
 * touch merge into one such blob, which filterIconBlobs rejects as too big —
 * so without this a 2v1 dive, the commonest way to be covered, got no
 * protection at all. Filled shapes (structures, minion clumps) still fail the
 * fill-ratio test.
 */
export function isPossibleOccluder(b: Blob, expectedIconDiam: number): boolean {
  if (b.color !== 'red' || b.pixels < 15) return false;
  if (b.fillRatio > 0.40 || b.fillRatio < 0.08) return false;
  const bw = b.maxX - b.minX + 1;
  const bh = b.maxY - b.minY + 1;
  const lo = expectedIconDiam * 0.6;
  const hi = expectedIconDiam * 2.6;
  return bw >= lo && bh >= lo && bw <= hi && bh <= hi;
}

// ---------- our icon merged with a teammate's ----------

/**
 * A teal blob too big to be one icon but small enough to be two or three
 * touching: our icon merged with a teammate's. filterIconBlobs drops these —
 * past 1.6 icons across they are not an icon — so without this a player
 * standing beside a teammate simply vanished from the tracker. In a v0.5.12
 * two-player log the pair laned together, the tracker gave up on the player
 * every time their icons overlapped, and the rescan then locked onto the
 * teammate's icon, the only clean one left.
 */
export function isPossibleStack(b: Blob, expectedIconDiam: number): boolean {
  if (b.color !== 'teal' || b.pixels < 15) return false;
  if (b.fillRatio > 0.40 || b.fillRatio < 0.08) return false;
  const bw = b.maxX - b.minX + 1;
  const bh = b.maxY - b.minY + 1;
  const single = expectedIconDiam * 1.6;
  if (bw <= single && bh <= single) return false;
  // Three in a row reach ~2.7 icons, and one of them walking off diagonally
  // stretches the box further before it comes away; anything under 3.2 icons
  // keeps a group we are following matched while it does.
  const hi = expectedIconDiam * 3.2;
  return bw >= expectedIconDiam * 0.6 && bh >= expectedIconDiam * 0.6 && bw <= hi && bh <= hi;
}

/**
 * The merged blob we are part of, if any: one whose extent reaches our last
 * position (within half an icon) and whose centroid is within 1.5 icons —
 * the same pair of tests findOccluder uses for merged enemy icons, and for the
 * same reason (a diagonal pair's bounding box has an empty corner).
 */
export function findStack(stacks: Blob[], at: { x: number; y: number }, expectedIconDiam: number): Blob | null {
  const pad = expectedIconDiam * 0.5;
  let best: Blob | null = null;
  let bestDist = Infinity;
  for (const b of stacks) {
    if (at.x < b.minX - pad || at.x > b.maxX + pad || at.y < b.minY - pad || at.y > b.maxY + pad) continue;
    const d = Math.hypot(b.cx - at.x, b.cy - at.y);
    if (d > expectedIconDiam * 1.5 || d >= bestDist) continue;
    best = b;
    bestDist = d;
  }
  return best;
}

/**
 * Where in a merged blob we are: the point nearest `toward` (our predicted
 * position) at which an icon centre could sit, i.e. at least half an icon in
 * from the blob's edges. Keeps us on our own side of the pair, and moves with
 * the pair when it walks.
 */
export function positionInStack(b: Blob, toward: { x: number; y: number }, expectedIconDiam: number): { x: number; y: number } {
  const r = expectedIconDiam / 2;
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  return {
    x: clamp(toward.x, b.minX + r, b.maxX + 1 - r),
    y: clamp(toward.y, b.minY + r, b.maxY + 1 - r),
  };
}

/**
 * How long we follow a merged blob wider than about two icons (three or more
 * teammates) before treating it as lost: it may be teammates we left.
 */
export const MAX_STACKED_MS = 15_000;

/** Consecutive classifier runs at >= 0.5 that release an excluded bystander icon. */
export const BYSTANDER_VOUCH_RUNS = 3;

/**
 * How far from where we were lost (region px) a rescan may lock an icon that
 * nothing identifies: two icons, plus walking speed for the time since. A
 * champion moves about 6px/s on a 1.92-scale minimap; 8px/s leaves margin and
 * covers the whole minimap within about 40s, so a champion the classifier
 * never recognises is not left unlocked for good.
 */
export function rescanReachPx(expectedIconDiam: number, elapsedMs: number): number {
  return expectedIconDiam * 2 + 8 * Math.max(0, elapsedMs) / 1000;
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
/**
 * Why the tracker is holding instead of following a blob frame to frame.
 *
 * 'no-blobs' — nothing at all was readable on the minimap: no icon or
 *   structure of either colour. That says the capture failed or something
 *   covered the minimap, NOT that we moved.
 * 'no-match' — the minimap was readable and our icon was not on it. This one
 *   does say we moved; a recall is the case that matters. (Until v0.5.10 a
 *   frame with enemy icons and structures but no own-team icon counted as
 *   'no-blobs', on the premise that a real game always draws four allies —
 *   which made every recall in a 1v1 take 5s to go quiet.)
 *
 * `null` means not holding.
 */
export type HoldReason = 'no-blobs' | 'no-match' | null;

/**
 * How long a hold may run before the position we are still broadcasting stops
 * being worth anything to our peers, by hold reason.
 *
 * These are deliberately different. Disowning our coordinates cuts us out of
 * every cross-team peer's audio instantly, so the cost of being too eager is
 * a player going silent mid-sentence while standing right next to someone —
 * which is what real logs showed: four disowns in forty seconds, each cutting
 * 1-4s of audio, every one of them a 'no-blobs' hold the tracker recovered
 * from on its own. The cost of being too patient is a few extra seconds of
 * audio after a recall. For a voice app the second is much the cheaper
 * mistake, but only where the position is actually likely to still be right.
 */
export const DISOWN_AFTER_SEC: Record<Exclude<HoldReason, null>, number> = {
  // Held position is probably still correct — wait until the tracker itself
  // gives up (FORCED_REACQUIRE_HOLD_MS) rather than cutting audio early.
  'no-blobs': 5,
  // We have positive evidence we are not where we say we are. Cut fast.
  'no-match': 2,
};

/** Seconds of hold after which we stop vouching for our last position. */
export function disownAfterSec(reason: HoldReason): number {
  // No reason recorded (a hold that predates the distinction, or a tracker
  // state we do not model) falls back to the cautious value.
  return reason ? DISOWN_AFTER_SEC[reason] : DISOWN_AFTER_SEC['no-match'];
}

export const FORCED_REACQUIRE_HOLD_MS = 5000;

export function shouldForceReacquisition(holdStartMs: number, nowMs: number): boolean {
  if (holdStartMs === 0) return false;
  return (nowMs - holdStartMs) >= FORCED_REACQUIRE_HOLD_MS;
}

// ---------- locked onto something that is not us ----------

/**
 * How many classifier runs, and how much time, it takes to decide the locked
 * blob is not us. Runs land every 500ms, so six of them span at least 2.5s;
 * the time floor makes it 4s whatever the run rate.
 */
export const WRONG_LOCK_RUNS = 6;
export const WRONG_LOCK_MIN_MS = 4000;
/**
 * How long a scan after a user reset may keep steering away from where we were
 * and waiting for something that identifies us. The avoidance ends at the next
 * lock, which is usually much sooner.
 */
export const RESET_AVOID_MS = 10_000;
/** How long that scan watches the abandoned blob for movement before locking. */
export const RESET_OBSERVE_MS = 1500;

/**
 * A gap this long between supporting runs drops the evidence. The case this
 * exists for is a model that says the same thing on run after run; a stray
 * noise hit every few seconds must never add up to a switch.
 */
export const WRONG_LOCK_STALE_MS = 3000;

/**
 * How far the followed blob may drift (as a fraction of an icon) and still
 * count as not moving. A ward's centroid jitters by a pixel or two; a champion
 * walking at ordinary speed leaves this radius within about a second.
 */
export const WRONG_LOCK_STILL_FRACTION = 0.25;

export interface WrongLockEvidence {
  /** Region px: where the followed blob was when the evidence started. */
  anchor: { x: number; y: number } | null;
  /** Region px: where the preferred blob was on the latest supporting run. */
  best: { x: number; y: number } | null;
  runs: number;
  firstMs: number;
  lastMs: number;
}

export function emptyWrongLockEvidence(): WrongLockEvidence {
  return { anchor: null, best: null, runs: 0, firstMs: 0, lastMs: 0 };
}

export interface WrongLockRun {
  /** The teal blob the lock is on, region px, or null if none matched this run. */
  followed: { x: number; y: number } | null;
  /** Its normalized classifier score this run (0..1). */
  followedScore: number;
  /** The highest-scoring other teal blob, or null. */
  best: { x: number; y: number; score: number } | null;
  /** Whether this run said anything: some raw score cleared the minimum. */
  discriminating: boolean;
}

/**
 * Fold one classifier run into the evidence that the lock is on the wrong blob.
 * Returns the blob to move to once the evidence is sufficient, else null.
 *
 * Phase 1 follows whatever teal blob is nearest on continuity alone (see
 * computeNearFieldPx). In a v0.5.10 log, the player's icon was briefly covered
 * by an enemy's beside something static and teal — a ward, most likely — and
 * the lock came out of it on the ward. The ward stayed visible, so the lock
 * stayed with it; the classifier, on the runs where it recognised anything,
 * rated the ward 0.00 and the real icon 1.00, and nothing listened. The other
 * player was scored against the ward and heard nothing for minutes.
 *
 * What counts as evidence is deliberately narrow, because the classifier is
 * weak on some champions — its raw scores for the champion in that log were
 * 0.000 to 0.03, barely above the normalization floor — and a confident wrong
 * switch onto an ally is worse than staying put:
 *  - silent runs (nothing cleared the raw floor) are neutral;
 *  - a supporting run has the followed blob at <= 0.1 and a distinct blob the
 *    clear favourite; any other discriminating run resets everything;
 *  - it must be the SAME preferred blob each time (it may drift, as a walking
 *    champion does); noise spread over several allies never adds up;
 *  - supporting runs must come close together (WRONG_LOCK_STALE_MS);
 *  - the followed blob must stay essentially still (WRONG_LOCK_STILL_FRACTION
 *    of an icon). A ward does not move; a champion we are following does.
 *
 * Not protected: a champion standing still, or shuffling within a quarter
 * icon of one spot (last-hitting), while a weak classifier is consistently,
 * densely sure it is one particular ally for 4s.
 */
export function nextWrongLockEvidence(
  ev: WrongLockEvidence,
  run: WrongLockRun,
  nowMs: number,
  iconDiam: number,
): { evidence: WrongLockEvidence; switchTo: { x: number; y: number } | null } {
  const none = { evidence: emptyWrongLockEvidence(), switchTo: null };
  if (ev.runs > 0 && nowMs - ev.lastMs > WRONG_LOCK_STALE_MS) ev = emptyWrongLockEvidence();
  if (!run.discriminating) return { evidence: ev, switchTo: null };
  if (!run.followed) return none;

  const best = run.best;
  const supports = run.followedScore <= 0.1 && !!best && best.score >= 0.99 &&
    Math.hypot(best.x - run.followed.x, best.y - run.followed.y) > iconDiam;
  if (!supports || !best) return none;

  const still = Math.max(3, iconDiam * WRONG_LOCK_STILL_FRACTION);
  if (ev.anchor && Math.hypot(run.followed.x - ev.anchor.x, run.followed.y - ev.anchor.y) > still) {
    ev = emptyWrongLockEvidence();
  }
  if (ev.best && Math.hypot(best.x - ev.best.x, best.y - ev.best.y) > iconDiam) {
    ev = emptyWrongLockEvidence();
  }
  const next: WrongLockEvidence = {
    anchor: ev.anchor ?? { x: run.followed.x, y: run.followed.y },
    best: { x: best.x, y: best.y },
    runs: ev.runs + 1,
    firstMs: ev.runs > 0 ? ev.firstMs : nowMs,
    lastMs: nowMs,
  };
  if (next.runs >= WRONG_LOCK_RUNS && nowMs - next.firstMs >= WRONG_LOCK_MIN_MS) {
    return { evidence: emptyWrongLockEvidence(), switchTo: { x: best.x, y: best.y } };
  }
  return { evidence: next, switchTo: null };
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

// ---------- v0.5.8: camera viewport centre (issue #36, "voice on camera") ----------

/**
 * Locate the centre of League's camera-viewport rectangle on the minimap, in
 * region-relative pixels. Returns null when no plausible rectangle is visible.
 *
 * Input is the `viewportMask` built by TrackingService.buildWhiteMasks — white
 * pixels that belong to long straight runs, which on the minimap is the camera
 * rectangle (the short diagonal movement-path line is deliberately excluded).
 *
 * Method: a rectangle outline puts a lot of marked pixels in exactly four
 * lines — its top and bottom rows, and its left and right columns. So rows
 * holding at least `minRunPx` marked pixels are the horizontal edges, columns
 * holding at least `minRunPx` are the vertical edges, and the centre is the
 * midpoint between the outermost of each. Taking edges this way rather than a
 * raw bounding box keeps a stray run elsewhere on the minimap from dragging the
 * centre off the rectangle.
 *
 * Both edge pairs must be present and separated by a plausible fraction of the
 * minimap, so a rectangle clipped by the edge of the map (camera panned into a
 * corner) reports null instead of a centre that is off by half its width. The
 * caller falls back to the champion's own position in that case.
 */
/**
 * Why a frame produced no camera centre. A bare null tells a bug report nothing:
 * "the rectangle was not readable" covers both "no bright pixels survived the
 * white threshold at all" and "the rectangle was found but looked implausible",
 * which need opposite fixes.
 */
export type ViewportMiss =
  | 'no-marked-pixels'
  | 'no-opposing-edges'
  | 'span-too-large'
  | 'edges-disagree';

export interface ViewportResult {
  centre: { cx: number; cy: number } | null;
  /** The rectangle's edges (region px), present whenever `centre` is. */
  box?: ViewportBox;
  miss?: ViewportMiss;
  /** Marked pixels seen, so a threshold problem is distinguishable from a shape one. */
  markedPixels: number;
}

export function computeViewportCenter(
  viewportMask: Uint8Array,
  width: number,
  height: number,
  minRunPx = 12,
): { cx: number; cy: number } | null {
  return describeViewportCenter(viewportMask, width, height, minRunPx).centre;
}

export function describeViewportCenter(
  viewportMask: Uint8Array,
  width: number,
  height: number,
  minRunPx = 12,
): ViewportResult {
  if (width <= 0 || height <= 0 || viewportMask.length < width * height) {
    return { centre: null, miss: 'no-marked-pixels', markedPixels: 0 };
  }

  const rowCounts = new Uint32Array(height);
  const colCounts = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      if (viewportMask[rowBase + x] === 1) {
        rowCounts[y]++;
        colCounts[x]++;
      }
    }
  }

  // A real camera box covers a meaningful slice of the map but never most of
  // it. Anything outside this band is noise (or the whole minimap border got
  // marked) and reports null so the caller falls back to the champion position.
  const MIN_SPAN_FRACTION = 0.04;
  const MAX_SPAN_FRACTION = 0.70;

  let markedPixels = 0;
  for (let y = 0; y < height; y++) markedPixels += rowCounts[y];
  if (markedPixels === 0) return { centre: null, miss: 'no-marked-pixels', markedPixels };

  const rows = findOpposingEdges(rowCounts, minRunPx, height * MIN_SPAN_FRACTION);
  const cols = findOpposingEdges(colCounts, minRunPx, width * MIN_SPAN_FRACTION);
  if (!rows || !cols) return { centre: null, miss: 'no-opposing-edges', markedPixels };

  const spanX = cols.far - cols.near;
  const spanY = rows.far - rows.near;
  if (spanX > width * MAX_SPAN_FRACTION || spanY > height * MAX_SPAN_FRACTION) {
    return { centre: null, miss: 'span-too-large', markedPixels };
  }

  // Consistency: the horizontal edges should be about as long as the box is
  // wide, and the vertical edges about as tall as it is high. A pairing that
  // fails this is two unrelated runs, not one rectangle.
  if (!spansAgree(rows.strength, spanX) || !spansAgree(cols.strength, spanY)) {
    return { centre: null, miss: 'edges-disagree', markedPixels };
  }

  return {
    centre: { cx: (cols.near + cols.far) / 2, cy: (rows.near + rows.far) / 2 },
    box: { x0: cols.near, y0: rows.near, x1: cols.far, y1: rows.far },
    markedPixels,
  };
}

/**
 * Given per-row (or per-column) counts of marked pixels, find the two opposing
 * edges of the rectangle: the strongest line, and the strongest line at least
 * `minSeparation` away from it.
 *
 * Picking by strength rather than by "outermost line over the threshold" is
 * what keeps an unrelated straight run elsewhere on the minimap from being
 * mistaken for an edge — the rectangle's own edges are far denser than stray
 * marks. The second edge additionally has to be comparable in length to the
 * first, since both sides of a rectangle are the same length.
 */
function findOpposingEdges(
  counts: Uint32Array,
  minRunPx: number,
  minSeparation: number,
): { near: number; far: number; strength: number } | null {
  let primary = -1;
  for (let i = 0; i < counts.length; i++) {
    if (primary < 0 || counts[i] > counts[primary]) primary = i;
  }
  if (primary < 0 || counts[primary] < minRunPx) return null;

  let secondary = -1;
  for (let i = 0; i < counts.length; i++) {
    if (Math.abs(i - primary) < minSeparation) continue;
    if (counts[i] < minRunPx) continue;
    if (secondary < 0 || counts[i] > counts[secondary]) secondary = i;
  }
  if (secondary < 0) return null;

  // Opposite edges of a rectangle are equal length; allow half, for an edge
  // partially hidden behind an icon or clipped by the minimap border.
  if (counts[secondary] * 2 < counts[primary]) return null;

  return {
    near: Math.min(primary, secondary),
    far: Math.max(primary, secondary),
    strength: counts[secondary],
  };
}

/** Whether an edge's pixel length is consistent with the box's opposite span. */
function spansAgree(edgeLength: number, span: number): boolean {
  if (span <= 0) return false;
  const ratio = edgeLength / span;
  return ratio >= 0.5 && ratio <= 2.0;
}

// ---------- Camera dwell: which teammate icon is the one we keep on screen ----------

export interface ViewportBox { x0: number; y0: number; x1: number; y1: number }

/**
 * How far back camera dwell looks. Long enough that glancing at a teammate's
 * lane, or holding F2-F5 on one for a few seconds, is a minority of the window;
 * short enough to correct a wrong lock within a minute.
 */
export const CAMERA_DWELL_WINDOW_MS = 30_000;
/** Readable-camera time an icon needs in the window before its dwell counts. */
export const CAMERA_DWELL_MIN_READABLE_MS = 10_000;
/** A candidate on screen at least this much of the time is a camera favourite... */
export const CAMERA_DWELL_HIGH = 0.6;
/** ...and an icon on screen at most this much is one the player is not watching. */
export const CAMERA_DWELL_LOW = 0.2;
/** After any lock or camera switch, how long before the camera may move us. */
export const CAMERA_SWITCH_COOLDOWN_MS = 15_000;
/**
 * A track not matched to any icon for this long is forgotten. Icons drop out
 * of detection for seconds at a time in fights (merged with an enemy's, or
 * covered) — in the 2026-10-08 games a mid laner's was missing from about a
 * third of the snapshots — and forgetting them sooner kept wiping the history
 * the switch needs.
 */
const CAMERA_TRACK_TTL_MS = 5_000;

interface DwellSample { t: number; dt: number; readable: boolean; inView: boolean }
interface DwellTrack { x: number; y: number; lastMs: number; samples: DwellSample[]; rejectedUntilMs: number }

export interface DwellReading {
  x: number;
  y: number;
  /** Share of the readable time this icon spent inside the rectangle. */
  dwell: number;
  /** Time this icon was seen with the rectangle readable... */
  readableMs: number;
  /** ...out of all the time it was seen, in the window. */
  seenMs: number;
  /** The user reset away from this icon recently; never a camera pick. */
  rejected: boolean;
}

/**
 * The rectangle has to have been readable for at least this share of the time
 * an icon was seen for its dwell to mean anything. It reads as nothing when
 * clipped by the map's edge, so a top or bot laner's camera on themselves in
 * that corner goes uncounted while every glance elsewhere counts: their own
 * icon would score near 0% on the frames that remain.
 */
export const CAMERA_DWELL_MIN_READABLE_SHARE = 0.5;
/** How long an icon the user reset away from stays out of the camera's picks. */
export const CAMERA_REJECT_MS = 60_000;

/**
 * Which own-team icon the player keeps on screen.
 *
 * The champion classifier cannot tell some teammates apart at all (the
 * 2026-10-08 test: Gwen 0%, Kayn under 5%), and a wrong pick — usually made in
 * the fountain, where every icon starts together — then stuck for minutes. The
 * camera says something the classifier cannot: players keep their own
 * champion on screen most of the time, locked camera or not, while any one
 * teammate is only in view now and then. In those games the rectangle was
 * readable in 65-90% of frames, and centred within an icon of the player when
 * they were not looking elsewhere.
 *
 * So each icon is followed frame to frame, and every frame the rectangle is
 * readable records whether it was inside it. An icon's dwell is the fraction
 * of that readable time it spent in view over the last CAMERA_DWELL_WINDOW_MS.
 * Nothing here decides anything; TrackingService compares dwells.
 *
 * Free-camera players are why this is "inside the rectangle" rather than
 * "near its centre": they keep themselves on screen without centring.
 */
export class CameraDwell {
  private tracks: DwellTrack[] = [];

  reset(): void { this.tracks = []; }

  /**
   * One frame: the own-team icons (region px) and the camera rectangle, or
   * null when it could not be read this frame (the frame then counts for no
   * icon, in view or out).
   */
  update(icons: Array<{ x: number; y: number }>, box: ViewportBox | null, now: number, dtMs: number, iconDiam: number): void {
    const matched = new Set<DwellTrack>();
    for (const icon of icons) {
      let best: DwellTrack | null = null;
      let bestD = Infinity;
      for (const t of this.tracks) {
        if (matched.has(t)) continue;
        // An icon walks about a third of its own width a second; one unseen
        // for a while may turn up that much further away.
        const reach = Math.max(4, iconDiam * (1 + 0.3 * (now - t.lastMs) / 1000));
        const d = Math.hypot(t.x - icon.x, t.y - icon.y);
        if (d <= reach && d < bestD) { best = t; bestD = d; }
      }
      if (!best) {
        best = { x: icon.x, y: icon.y, lastMs: now, samples: [], rejectedUntilMs: 0 };
        this.tracks.push(best);
      }
      matched.add(best);
      best.x = icon.x;
      best.y = icon.y;
      best.lastMs = now;
      const m = iconDiam * 0.25;
      const inView = !!box && icon.x >= box.x0 - m && icon.x <= box.x1 + m && icon.y >= box.y0 - m && icon.y <= box.y1 + m;
      best.samples.push({ t: now, dt: Math.min(dtMs, 500), readable: !!box, inView });
    }
    const horizon = now - CAMERA_DWELL_WINDOW_MS;
    this.tracks = this.tracks.filter(t => now - t.lastMs <= CAMERA_TRACK_TTL_MS);
    for (const t of this.tracks) {
      let drop = 0;
      while (drop < t.samples.length && t.samples[drop].t <= horizon) drop++;
      if (drop > 0) t.samples.splice(0, drop);
    }
  }

  /** Every followed icon's dwell, as of the last update. */
  readings(now = Infinity): DwellReading[] {
    return this.tracks.map((t) => {
      let seen = 0;
      let readable = 0;
      let inView = 0;
      for (const s of t.samples) {
        seen += s.dt;
        if (s.readable) readable += s.dt;
        if (s.inView) inView += s.dt;
      }
      return {
        x: t.x, y: t.y, dwell: readable > 0 ? inView / readable : 0,
        readableMs: readable, seenMs: seen, rejected: now < t.rejectedUntilMs,
      };
    });
  }

  /** Keep the icon nearest `at` (within `radius`) out of camera picks until `untilMs`. */
  reject(at: { x: number; y: number }, radius: number, untilMs: number): void {
    let best: DwellTrack | null = null;
    let bestD = radius;
    for (const t of this.tracks) {
      const d = Math.hypot(t.x - at.x, t.y - at.y);
      if (d <= bestD) { best = t; bestD = d; }
    }
    if (best) best.rejectedUntilMs = untilMs;
  }

}

/**
 * The reading nearest `at` within `radius`, or null. Takes the list rather than
 * a CameraDwell so the result is one of its elements: readings() builds new
 * objects on every call, and cameraSwitchTarget tells the followed icon from
 * the rest by identity.
 */
export function readingNear(readings: DwellReading[], at: { x: number; y: number }, radius: number): DwellReading | null {
  let best: DwellReading | null = null;
  let bestD = radius;
  for (const r of readings) {
    const d = Math.hypot(r.x - at.x, r.y - at.y);
    if (d <= bestD) { best = r; bestD = d; }
  }
  return best;
}

/**
 * The icon the camera says is us, if the evidence is clear: on screen at least
 * CAMERA_DWELL_HIGH of a full window, and every other icon with enough data at
 * most CAMERA_DWELL_LOW. Two teammates who stay together are both in view and
 * neither wins — the camera cannot separate them, and does not try.
 */
/** Enough readable history, and readable enough of the time, to count. */
function dwellCounts(r: DwellReading): boolean {
  return r.readableMs >= CAMERA_DWELL_MIN_READABLE_MS &&
    r.readableMs >= CAMERA_DWELL_MIN_READABLE_SHARE * r.seenMs;
}

export function cameraFavourite(readings: DwellReading[]): DwellReading | null {
  const ready = readings.filter(dwellCounts);
  const high = ready.filter(r => r.dwell >= CAMERA_DWELL_HIGH);
  if (high.length !== 1 || high[0].rejected) return null;
  const others = ready.filter(r => r !== high[0]);
  if (others.some(r => r.dwell > CAMERA_DWELL_LOW)) return null;
  return high[0];
}

/**
 * The icon to move a lock to on camera evidence alone, or null. The icon we
 * follow has to be one the player has not been watching (at most
 * CAMERA_DWELL_LOW over a full window) and exactly one other icon one they
 * have (at least CAMERA_DWELL_HIGH). Unlike cameraFavourite, a third icon the
 * player also watches does not block it: that is a duo lane, and the icon we
 * follow is neither of the two.
 */
export function cameraSwitchTarget(readings: DwellReading[], followed: DwellReading | null): DwellReading | null {
  if (followed && !readings.includes(followed)) throw new Error('cameraSwitchTarget: followed is not one of readings');
  if (!followed || !dwellCounts(followed) || followed.dwell > CAMERA_DWELL_LOW) return null;
  const high = readings.filter(r => r !== followed && dwellCounts(r) && r.dwell >= CAMERA_DWELL_HIGH);
  return high.length === 1 && !high[0].rejected ? high[0] : null;
}
