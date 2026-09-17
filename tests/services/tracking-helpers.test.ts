import {
  computeMaxJumpPx,
  computeReacquireThreshold,
  computeBlobScore,
  pickBestBlobInRange,
  pickClassifierReacquisition,
  CLS_FOLLOW_THRESHOLD,
  shouldForceReacquisition,
  FORCED_REACQUIRE_HOLD_MS,
  nextClassifierEma,
  computeNearFieldPx,
  computeViewportCenter,
} from '../../src/services/tracking-helpers';
import type { Blob } from '../../src/services/blob-types';

function mkBlob(cx: number, cy: number): Blob {
  return {
    color: 'teal',
    pixels: 100,
    cx, cy,
    minX: cx - 5, maxX: cx + 5,
    minY: cy - 5, maxY: cy + 5,
    fillRatio: 0.8,
  };
}

describe('computeMaxJumpPx', () => {
  test('returns 2x icon-diameter base when not in hold', () => {
    expect(computeMaxJumpPx(12, /*holdStartMs*/ 0, /*now*/ 1000)).toBe(24);
  });

  test('enforces minimum of 20 even for tiny icons', () => {
    expect(computeMaxJumpPx(5, 0, 1000)).toBe(20);
  });

  test('expands by ~1 icon-diameter per second of hold', () => {
    // hold for 2 seconds, icon = 12 → base 24 + (12 * 2) = 48
    expect(computeMaxJumpPx(12, /*hold start*/ 1000, /*now*/ 3000)).toBe(48);
  });

  test('zero hold equals no expansion', () => {
    expect(computeMaxJumpPx(12, 1000, 1000)).toBe(24);
  });
});

describe('computeReacquireThreshold', () => {
  test('default 0.5 when fresh + brief hold', () => {
    expect(computeReacquireThreshold(/*stationary*/ 0, /*hold*/ 0)).toBe(0.5);
  });

  test('relaxes to 0.35 after >1s of hold', () => {
    expect(computeReacquireThreshold(0, 2)).toBe(0.35);
  });

  test('tightens to 0.85 if stationary for >3s (likely render glitch, not teleport)', () => {
    expect(computeReacquireThreshold(5, 0)).toBe(0.85);
    // Stationary check wins even if hold has been short
    expect(computeReacquireThreshold(5, 2)).toBe(0.85);
  });
});

describe('computeBlobScore', () => {
  test('with classifier: pos + cls dominate, weights sum ~1.0', () => {
    const s = computeBlobScore({ posScore: 1, clsScore: 1, whiteScore: 1, peerScore: 1 }, true);
    expect(s).toBeCloseTo(1.0, 5);
  });

  test('without classifier: clsScore is ignored entirely', () => {
    // cls=0 (modified) and cls=1 should both produce the same score when no classifier
    const a = computeBlobScore({ posScore: 0.5, clsScore: 0, whiteScore: 0.5, peerScore: 0.5 }, false);
    const b = computeBlobScore({ posScore: 0.5, clsScore: 1, whiteScore: 0.5, peerScore: 0.5 }, false);
    expect(a).toBe(b);
  });

  test('higher posScore strictly wins (ceteris paribus)', () => {
    const lo = computeBlobScore({ posScore: 0.2, clsScore: 0.5, whiteScore: 0.5, peerScore: 0.5 }, true);
    const hi = computeBlobScore({ posScore: 0.8, clsScore: 0.5, whiteScore: 0.5, peerScore: 0.5 }, true);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe('pickBestBlobInRange', () => {
  const noScores = {
    cls: () => 0.5,
    white: () => 0.5,
    peer: () => 0.5,
  };

  test('picks the blob closest to the predicted position', () => {
    const blobs = [mkBlob(100, 100), mkBlob(105, 100), mkBlob(150, 100)];
    const result = pickBestBlobInRange(
      blobs,
      /*lastReg*/ { x: 95, y: 100 },
      /*predicted*/ { x: 105, y: 100 },
      /*maxJumpPx*/ 60,
      /*hasClassifier*/ false,
      noScores,
    );
    expect(result?.blob.cx).toBe(105);
  });

  test('excludes blobs outside jump radius', () => {
    const blobs = [mkBlob(200, 100)]; // 100px away from lastReg
    const result = pickBestBlobInRange(
      blobs,
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      30,
      false,
      noScores,
    );
    expect(result).toBeNull();
  });

  test('with classifier, drops FAR-FIELD blobs below CLS_FOLLOW_THRESHOLD', () => {
    // 25px from the prediction with a 12px near-field radius — the classifier
    // still has to vouch for it, which is what stops long holds from snapping
    // the dot onto a minion wave (#13).
    const blob = mkBlob(125, 100);
    const lowClsFns = { ...noScores, cls: () => CLS_FOLLOW_THRESHOLD - 0.01 };
    const result = pickBestBlobInRange(
      [blob],
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      30,
      true,
      lowClsFns,
      /*nearFieldPx*/ 12,
    );
    expect(result).toBeNull();
  });

  test('with classifier, follows a NEAR-FIELD blob the classifier scores at zero', () => {
    const blob = mkBlob(102, 100);
    const zeroClsFns = { ...noScores, cls: () => 0 };
    const result = pickBestBlobInRange(
      [blob],
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      30,
      true,
      zeroClsFns,
      /*nearFieldPx*/ 12,
    );
    expect(result?.blob).toBe(blob);
  });

  test('near field is measured from lastReg too, so a stale velocity EMA cannot veto', () => {
    // Champion standing still; velocity EMA still points 20px away, so the
    // prediction is off but the blob has not moved from lastReg.
    const blob = mkBlob(100, 100);
    const zeroClsFns = { ...noScores, cls: () => 0 };
    const result = pickBestBlobInRange(
      [blob],
      /*lastReg*/ { x: 100, y: 100 },
      /*predicted*/ { x: 120, y: 100 },
      /*maxJumpPx*/ 60,
      true,
      zeroClsFns,
      /*nearFieldPx*/ 12,
    );
    expect(result?.blob).toBe(blob);
  });

  // Regression for the lock → hold → forced-reacquire → lock cycle in
  // NotOtakuu's 2026-09-12 log (v0.5.7). Real values from that session:
  // single teal blob at region (28,308), iconDiam 30, classifier raw=0.000 /
  // ema=0.00 on every frame, velocity reset to 0 by the lock one tick earlier.
  // Before the near-field exemption, Phase 1 rejected the blob it had just
  // locked onto and the broadcast position froze at the fountain — which is
  // what made every enemy fall outside MAX_HEARING_RANGE.
  test('regression: follows the just-locked blob when the classifier scores it 0', () => {
    const blob = mkBlob(28, 308);
    const lastReg = { x: 28, y: 308 };
    const predicted = { x: 28, y: 308 };
    const maxJumpPx = computeMaxJumpPx(30, /*holdStartMs*/ 0, /*now*/ 1000);
    const deadClassifier = { cls: () => 0.0, white: () => 0.8, peer: () => 1.0 };

    const phase1 = pickBestBlobInRange(
      [blob], lastReg, predicted, maxJumpPx, /*hasClassifier*/ true, deadClassifier,
      computeNearFieldPx(30),
    );

    expect(phase1).not.toBeNull();
    expect(phase1?.blob.cx).toBe(28);
  });

  test('without classifier, low cls scores do not exclude blobs', () => {
    const blob = mkBlob(100, 100);
    const lowClsFns = { ...noScores, cls: () => 0.0 };
    const result = pickBestBlobInRange(
      [blob],
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      30,
      false,
      lowClsFns,
    );
    expect(result?.blob).toBe(blob);
  });

  test('empty input returns null', () => {
    expect(pickBestBlobInRange([], { x: 0, y: 0 }, { x: 0, y: 0 }, 30, false, noScores)).toBeNull();
  });
});

describe('pickClassifierReacquisition', () => {
  test('returns highest-confidence blob above threshold', () => {
    const blobs = [mkBlob(0, 0), mkBlob(50, 50), mkBlob(200, 200)];
    const scores = new Map<Blob, number>([
      [blobs[0], 0.4],   // below threshold (0.5)
      [blobs[1], 0.7],
      [blobs[2], 0.9],
    ]);
    const result = pickClassifierReacquisition(blobs, 0.5, (b) => scores.get(b) ?? 0);
    expect(result?.blob).toBe(blobs[2]);
    expect(result?.score).toBe(0.9);
  });

  test('returns null when no blob clears the threshold', () => {
    const blobs = [mkBlob(0, 0), mkBlob(50, 50)];
    const result = pickClassifierReacquisition(blobs, 0.8, () => 0.5);
    expect(result).toBeNull();
  });

  test('threshold of 0 returns highest-scoring blob (no exclusion)', () => {
    const blobs = [mkBlob(0, 0), mkBlob(50, 50)];
    const scores = new Map<Blob, number>([[blobs[0], 0.1], [blobs[1], 0.3]]);
    const result = pickClassifierReacquisition(blobs, 0, (b) => scores.get(b) ?? 0);
    expect(result?.blob).toBe(blobs[1]);
  });

  test('empty input returns null', () => {
    expect(pickClassifierReacquisition([], 0.5, () => 1.0)).toBeNull();
  });
});

// ---------- v0.3 tracking tweaks (issue #7 root-cause fixes) ----------

describe('shouldForceReacquisition', () => {
  test('returns false when no hold is active (holdStartMs === 0)', () => {
    expect(shouldForceReacquisition(0, 1_000_000)).toBe(false);
  });
  test('returns false for hold below the threshold', () => {
    expect(shouldForceReacquisition(1000, 1000 + FORCED_REACQUIRE_HOLD_MS - 1)).toBe(false);
  });
  test('returns true at exactly the threshold', () => {
    expect(shouldForceReacquisition(1000, 1000 + FORCED_REACQUIRE_HOLD_MS)).toBe(true);
  });
  test('returns true for hold far past threshold (44-second IXAM-log case)', () => {
    expect(shouldForceReacquisition(1000, 1000 + 44_000)).toBe(true);
  });
});

describe('nextClassifierEma (symmetric EMA — v0.3.0 snap-up reverted in v0.3.1)', () => {
  test('decays toward 0 on a 0 sample', () => {
    // 0.5 * 0.7 + 0 * 0.3 = 0.35
    expect(nextClassifierEma(0.5, 0, 0.7)).toBeCloseTo(0.35, 5);
  });
  test('rises gradually toward a higher raw — does NOT snap (anti-clinging)', () => {
    // A single false-high raw must not latch the EMA to 1.0 (the v0.3.0
    // snap-up bug that made the tracker cling to minions/structures).
    // 0 * 0.7 + 0.8 * 0.3 = 0.24, not 0.8.
    expect(nextClassifierEma(0, 0.8, 0.7)).toBeCloseTo(0.24, 5);
  });
  test('standard EMA when raw is below current', () => {
    // 0.6 * 0.7 + 0.4 * 0.3 = 0.42 + 0.12 = 0.54
    expect(nextClassifierEma(0.6, 0.4, 0.7)).toBeCloseTo(0.54, 5);
  });
  test('a sustained high raw still climbs over a few frames', () => {
    let ema = 0;
    for (let i = 0; i < 5; i++) ema = nextClassifierEma(ema, 0.9, 0.7);
    expect(ema).toBeGreaterThan(0.6); // recovers without single-frame latching
  });
});

describe('computeViewportCenter (#36 voice on camera)', () => {
  const W = 340, H = 340;

  /** Draw a rectangle OUTLINE into a fresh mask, the way the minimap shows it. */
  function mkMask(
    left: number, top: number, right: number, bottom: number,
    w = W, h = H,
  ): Uint8Array {
    const mask = new Uint8Array(w * h);
    for (let x = left; x <= right; x++) {
      mask[top * w + x] = 1;
      mask[bottom * w + x] = 1;
    }
    for (let y = top; y <= bottom; y++) {
      mask[y * w + left] = 1;
      mask[y * w + right] = 1;
    }
    return mask;
  }

  test('finds the centre of a plausible camera rectangle', () => {
    // ~66x37px box, the rough shape of a 1920x1080 camera on a 340px minimap.
    const c = computeViewportCenter(mkMask(100, 150, 166, 187), W, H);
    expect(c).toEqual({ cx: 133, cy: 168.5 });
  });

  test('a stray long run elsewhere does not drag the centre off the box', () => {
    // A rectangle plus an unrelated 20px horizontal streak in the far corner.
    // A raw bounding box would put the centre between the two; using rows and
    // columns that carry a full edge's worth of pixels ignores the streak.
    const mask = mkMask(100, 150, 166, 187);
    for (let x = 300; x < 320; x++) mask[330 * W + x] = 1;
    const c = computeViewportCenter(mask, W, H);
    expect(c).toEqual({ cx: 133, cy: 168.5 });
  });

  test('rejects a box spanning most of the minimap (mask noise, not a camera)', () => {
    expect(computeViewportCenter(mkMask(5, 5, 334, 334), W, H)).toBeNull();
  });

  test('rejects a box too small to be the camera', () => {
    expect(computeViewportCenter(mkMask(100, 100, 108, 108), W, H)).toBeNull();
  });

  test('returns null for an empty mask (no rectangle visible)', () => {
    expect(computeViewportCenter(new Uint8Array(W * H), W, H)).toBeNull();
  });

  test('returns null when only one vertical edge is on screen', () => {
    // Camera panned into the map edge — the box is clipped, so a centre would
    // be off by half its width. Caller falls back to the champion position.
    const mask = new Uint8Array(W * H);
    for (let y = 150; y <= 187; y++) mask[y * W + 100] = 1;
    for (let x = 100; x <= 166; x++) { mask[150 * W + x] = 1; mask[187 * W + x] = 1; }
    expect(computeViewportCenter(mask, W, H)).toBeNull();
  });

  test('handles a 2px-thick (anti-aliased) rectangle outline', () => {
    const mask = mkMask(100, 150, 166, 187);
    // Second pixel of each edge, the way an anti-aliased box renders.
    for (let x = 100; x <= 166; x++) { mask[151 * W + x] = 1; mask[186 * W + x] = 1; }
    for (let y = 150; y <= 187; y++) { mask[y * W + 101] = 1; mask[y * W + 165] = 1; }
    const c = computeViewportCenter(mask, W, H);
    // The centre lands within a pixel of the true one — well under the ~44
    // game units a single minimap pixel is worth at this scale.
    expect(c).not.toBeNull();
    expect(Math.abs(c!.cx - 133)).toBeLessThanOrEqual(1);
    expect(Math.abs(c!.cy - 168.5)).toBeLessThanOrEqual(1);
  });

  test('guards against a mask smaller than the stated region', () => {
    expect(computeViewportCenter(new Uint8Array(10), W, H)).toBeNull();
    expect(computeViewportCenter(new Uint8Array(0), 0, 0)).toBeNull();
  });
});
