// The anti-sand test.
//
// tests/cv/tracking-simulation.test.ts is only worth anything if the frames it
// feeds the tracker really do contain the icons it claims. A synthesizer that
// draws nothing detectable produces a suite that passes for the wrong reason —
// no blobs, no candidates, no assertions that can fail. Everything below pins
// the drawing constants against the real detector, so a drift in either shows
// up here rather than as silent green in the scenarios.

import { decodeCaptureFrame } from '../../src/core/capture-frame';
import type { Blob } from '../../src/services/blob-types';
import { TrackingService } from '../../src/services/tracking';
import { computeViewportCenter } from '../../src/services/tracking-helpers';
import {
  blankFrame,
  brokenRing,
  encodeFrame,
  ovalRing,
  portraitArt,
  ring,
  setPixel,
  SynthFrame,
  TEAL,
} from './harness/frames';
import {
  CAPTURE_SIZE,
  ICON_DIAM,
  GAME_RECT,
  MAP,
  MINIMAP_SCALE,
  Point,
  REGION,
  SceneSpec,
  renderScene,
} from './harness/scenes';

/** The reference scene every assertion here is stated against. */
const SELF: Point = { x: 60, y: 200 };
const ALLIES: Point[] = [{ x: 40, y: 45 }, { x: 250, y: 245 }];
const ENEMIES: Point[] = [{ x: 105, y: 35 }, { x: 250, y: 160 }];
const MINIONS: Point[] = [{ x: 215, y: 205 }];
const TURRETS: Point[] = [{ x: 30, y: 245 }];
const CAMERA = { x: 140, y: 30, w: 110, h: 80 };

const REFERENCE: SceneSpec = {
  self: SELF,
  selfTrail: { x: -2, y: 1 },
  allies: ALLIES,
  enemies: ENEMIES,
  minions: MINIONS,
  turrets: TURRETS,
  camera: CAMERA,
};

interface Inspection {
  allBlobs: Blob[];
  iconBlobs: Blob[];
  whiteMask: Uint8Array;
  viewportMask: Uint8Array;
  whiteScore(b: Blob): number;
}

/**
 * Run the real front half of the pipeline (mask -> dilate -> findBlobs ->
 * filterIconBlobs) over a scene. Reaches through `private` deliberately: the
 * point is to measure what the production code sees, not a re-implementation
 * of it.
 */
function inspect(spec: SceneSpec): Inspection {
  return inspectEncoded(renderScene(spec).frame);
}

/** The same, for a frame composed pixel by pixel rather than from a SceneSpec. */
function inspectFrame(f: SynthFrame): Inspection {
  return inspectEncoded(encodeFrame(f));
}

function inspectEncoded(encoded: ArrayBuffer): Inspection {
  const svc = newService();
  const inner = svc as unknown as {
    createMask(f: unknown, r: unknown): Uint8Array;
    dilate(m: Uint8Array, w: number, h: number): Uint8Array;
    findBlobs(m: Uint8Array, w: number, h: number): Blob[];
    filterIconBlobs(b: Blob[]): Blob[];
    buildWhiteMasks(f: unknown, r: unknown): { whiteMask: Uint8Array; viewportMask: Uint8Array };
    whitePixelScore(b: Blob, w: Uint8Array, v: Uint8Array, rw: number, rh: number): number;
  };

  const frame = decodeCaptureFrame(encoded);
  const mask = inner.dilate(inner.createMask(frame, REGION), REGION.width, REGION.height);
  const allBlobs = inner.findBlobs(mask, REGION.width, REGION.height);
  const { whiteMask, viewportMask } = inner.buildWhiteMasks(frame, REGION);

  return {
    allBlobs,
    iconBlobs: inner.filterIconBlobs(allBlobs),
    whiteMask,
    viewportMask,
    whiteScore: (b) => inner.whitePixelScore(b, whiteMask, viewportMask, REGION.width, REGION.height),
  };
}

/** A frame holding nothing but what the caller draws into it. */
function bare(draw: (f: SynthFrame) => void): Inspection {
  const f = blankFrame(CAPTURE_SIZE, CAPTURE_SIZE);
  draw(f);
  return inspectFrame(f);
}

function bboxOf(b: Blob): { w: number; h: number; aspect: number } {
  const w = b.maxX - b.minX + 1;
  const h = b.maxY - b.minY + 1;
  return { w, h, aspect: w / h };
}

function newService(): TrackingService {
  const svc = new TrackingService(GAME_RECT, MAP, { capture: () => Promise.reject(new Error('unused')) });
  svc.setMinimapScaleFromConfig(MINIMAP_SCALE);
  return svc;
}

function near(b: Blob, p: Point, tolerance = 1): boolean {
  return Math.abs(b.cx - p.x) <= tolerance && Math.abs(b.cy - p.y) <= tolerance;
}

function findAt(blobs: Blob[], p: Point): Blob | undefined {
  return blobs.find(b => near(b, p, 2));
}

describe('harness geometry matches the production calibration', () => {
  test('a 1080p window at MinimapScale 1.0 puts the minimap where the harness says', () => {
    // If this fails, every ground-truth coordinate in tests/cv is mislabelled:
    // the scenes are drawn against these numbers, not against whatever
    // map-calibration currently computes.
    expect(newService().getDetectedMinimapScreenBounds()).toEqual({
      screenX: 1647,
      screenY: 807,
      screenWidth: REGION.width,
      screenHeight: REGION.height,
    });
    expect(newService().captureBounds.width).toBe(CAPTURE_SIZE);
  });

  test('the expected icon diameter is the one the scenes draw', () => {
    const diam = (newService() as unknown as { expectedIconDiam: number }).expectedIconDiam;
    expect(diam).toBe(ICON_DIAM);
  });
});

describe('the reference scene contains exactly the icons it claims', () => {
  test('five champion icons survive filterIconBlobs, at their ground-truth centres', () => {
    const { iconBlobs } = inspect(REFERENCE);
    expect(iconBlobs).toHaveLength(5);

    const teal = iconBlobs.filter(b => b.color === 'teal');
    const red = iconBlobs.filter(b => b.color === 'red');
    expect(teal).toHaveLength(3);
    expect(red).toHaveLength(2);

    for (const p of [SELF, ...ALLIES]) {
      expect(teal.some(b => near(b, p))).toBe(true);
    }
    for (const p of ENEMIES) {
      expect(red.some(b => near(b, p))).toBe(true);
    }
  });

  test('the minion wave and the turret are detected, then rejected on fill ratio', () => {
    const { allBlobs, iconBlobs } = inspect(REFERENCE);

    // Present as blobs — the filter is doing work, rather than the synthesizer
    // having drawn nothing.
    const minion = findAt(allBlobs, MINIONS[0]);
    const turret = findAt(allBlobs, TURRETS[0]);
    expect(minion).toBeDefined();
    expect(turret).toBeDefined();

    // ...and rejected for the reason a real one would be: dense, not a ring.
    // Both are inside the accepted size band, so fillRatio is the only thing
    // keeping them out.
    for (const b of [minion!, turret!]) {
      const bw = b.maxX - b.minX + 1;
      expect(bw).toBeGreaterThanOrEqual(ICON_DIAM * 0.6);
      expect(bw).toBeLessThanOrEqual(ICON_DIAM * 1.6);
      expect(b.fillRatio).toBeGreaterThan(0.40);
    }

    expect(findAt(iconBlobs, MINIONS[0])).toBeUndefined();
    expect(findAt(iconBlobs, TURRETS[0])).toBeUndefined();
  });

  test('the camera rectangle is all viewport and no champion', () => {
    const { iconBlobs, viewportMask } = inspect(REFERENCE);

    // Its corners are further from any icon than the icon filter's size band,
    // so a blob there could only be the rectangle itself.
    expect(iconBlobs.some(b => b.cx > CAMERA.x && b.cx < CAMERA.x + CAMERA.w
      && b.cy > CAMERA.y && b.cy < CAMERA.y + CAMERA.h)).toBe(false);

    for (let i = 0; i < CAMERA.w; i++) {
      expect(viewportMask[CAMERA.y * REGION.width + CAMERA.x + i]).toBe(1);
      expect(viewportMask[(CAMERA.y + CAMERA.h - 1) * REGION.width + CAMERA.x + i]).toBe(1);
    }
    for (let i = 0; i < CAMERA.h; i++) {
      expect(viewportMask[(CAMERA.y + i) * REGION.width + CAMERA.x]).toBe(1);
      expect(viewportMask[(CAMERA.y + i) * REGION.width + CAMERA.x + CAMERA.w - 1]).toBe(1);
    }

    const centre = computeViewportCenter(viewportMask, REGION.width, REGION.height);
    expect(centre).not.toBeNull();
    expect(centre!.cx).toBeCloseTo(CAMERA.x + (CAMERA.w - 1) / 2, 0);
    expect(centre!.cy).toBeCloseTo(CAMERA.y + (CAMERA.h - 1) / 2, 0);
  });

  test('only the icon with a movement trail scores white pixels', () => {
    const { iconBlobs, whiteScore } = inspect(REFERENCE);

    const self = findAt(iconBlobs, SELF)!;
    expect(whiteScore(self)).toBe(1);

    // The trap this test exists for: countWhiteNearBlob skips everything inside
    // the blob's own bounding box, so a trail drawn against the portrait scores
    // zero for the self icon too, every teal candidate ties, and SCANNING locks
    // onto whichever ally comes first in raster order.
    for (const p of ALLIES) {
      expect(whiteScore(findAt(iconBlobs, p)!)).toBe(0);
    }
  });

  test('the camera rectangle is not counted as movement-path evidence', () => {
    // An ally parked on the rectangle's edge must not inherit the self icon's
    // strongest signal. Only the viewport exclusion in countWhiteNearBlob keeps
    // that from happening.
    const onEdge: Point = { x: CAMERA.x + 40, y: CAMERA.y + CAMERA.h + 10 };
    const { iconBlobs, whiteScore } = inspect({ ...REFERENCE, allies: [...ALLIES, onEdge] });
    expect(whiteScore(findAt(iconBlobs, onEdge)!)).toBe(0);
  });
});

describe('icon ring thickness is load-bearing', () => {
  function fillRatioFor(thickness: number): { fill: number; accepted: boolean } {
    const svc = newService();
    const inner = svc as unknown as {
      createMask(f: unknown, r: unknown): Uint8Array;
      dilate(m: Uint8Array, w: number, h: number): Uint8Array;
      findBlobs(m: Uint8Array, w: number, h: number): Blob[];
      filterIconBlobs(b: Blob[]): Blob[];
    };
    const f = blankFrame(CAPTURE_SIZE, CAPTURE_SIZE);
    ring(f, REGION.x + SELF.x, REGION.y + SELF.y, ICON_DIAM, TEAL, thickness);
    const frame = decodeCaptureFrame(encodeFrame(f));
    const mask = inner.dilate(inner.createMask(frame, REGION), REGION.width, REGION.height);
    const blobs = inner.findBlobs(mask, REGION.width, REGION.height);
    expect(blobs).toHaveLength(1);
    return { fill: blobs[0].fillRatio, accepted: inner.filterIconBlobs(blobs).length === 1 };
  }

  test('the default thickness clears the 0.40 fill cap, and thickness 3 does not', () => {
    // dilate() fattens every border by a pixel on each side before detection,
    // so a ring drawn one pixel thicker than it looks is a ring that vanishes.
    // At ICON_DIAM=24: 1 -> 0.263, 2 -> 0.340, 3 -> 0.417 (rejected).
    const t1 = fillRatioFor(1);
    const t2 = fillRatioFor(2);
    const t3 = fillRatioFor(3);

    expect(t1.fill).toBeLessThan(0.40);
    expect(t1.accepted).toBe(true);
    expect(t2.fill).toBeLessThan(0.40);
    expect(t2.accepted).toBe(true);
    expect(t3.fill).toBeGreaterThan(0.40);
    expect(t3.accepted).toBe(false);
  });
});

describe('teal shapes that are not champion icons', () => {
  // The reference scene above only ever asks filterIconBlobs to reject DENSE
  // teal (the minion wave, the turret), so fillRatio was the only gate under
  // test and the size and aspect gates could both be deleted with the whole
  // suite staying green. These are the shapes that exercise the other two.
  const AT: Point = { x: 120, y: 120 };
  const frameAt = (p: Point) => ({ x: REGION.x + p.x, y: REGION.y + p.y });

  test('a ping ring is icon-shaped and icon-hollow, and rejected on size alone', () => {
    // An ally ping part-way through its expansion: a round teal outline about
    // twice an icon across. Only the size band stands between it and a lock.
    const { allBlobs, iconBlobs } = bare(f => {
      const c = frameAt(AT);
      ring(f, c.x, c.y, Math.round(ICON_DIAM * 2.2), TEAL, 1);
    });

    expect(allBlobs).toHaveLength(1);
    const box = bboxOf(allBlobs[0]);
    expect(box.aspect).toBeGreaterThan(0.6);
    expect(box.aspect).toBeLessThan(1.7);
    expect(allBlobs[0].fillRatio).toBeGreaterThan(0.08);
    expect(allBlobs[0].fillRatio).toBeLessThan(0.40);
    expect(allBlobs[0].pixels).toBeGreaterThan(15);
    expect(box.w).toBeGreaterThan(ICON_DIAM * 1.6);

    expect(iconBlobs).toHaveLength(0);
  });

  test('an elongated outline is icon-sized and icon-hollow, and rejected on aspect alone', () => {
    // Two adjacent icons whose borders dilate() has bridged, or a ping caught
    // mid-animation: inside the size band, inside the ring fill band, far too
    // wide to be a circle.
    const { allBlobs, iconBlobs } = bare(f => {
      const c = frameAt(AT);
      // Derived from ICON_DIAM so the shape keeps straddling the gates if the
      // calibration ever moves: ~1.4 icons wide, ~0.55 of one tall.
      ovalRing(f, c.x, c.y, Math.round(ICON_DIAM * 0.71), Math.round(ICON_DIAM * 0.25), TEAL);
    });

    expect(allBlobs).toHaveLength(1);
    const box = bboxOf(allBlobs[0]);
    expect(box.w).toBeGreaterThanOrEqual(ICON_DIAM * 0.6);
    expect(box.w).toBeLessThanOrEqual(ICON_DIAM * 1.6);
    expect(box.h).toBeGreaterThanOrEqual(ICON_DIAM * 0.6);
    expect(box.h).toBeLessThanOrEqual(ICON_DIAM * 1.6);
    expect(allBlobs[0].fillRatio).toBeGreaterThan(0.08);
    expect(allBlobs[0].fillRatio).toBeLessThan(0.40);
    expect(box.aspect).toBeGreaterThan(1.7);

    expect(iconBlobs).toHaveLength(0);
  });

  test('a stray teal pixel never becomes a blob at all', () => {
    // Compression noise or a single cyan terrain pixel. findBlobs' 10-pixel
    // floor is the only thing keeping it out of the candidate list: even after
    // dilate() a lone pixel is a 5-pixel cross.
    const { allBlobs } = bare(f => {
      const c = frameAt(AT);
      setPixel(f, c.x, c.y, TEAL);
    });
    expect(allBlobs).toHaveLength(0);
  });
});

describe('the frames are not easier than a real minimap', () => {
  const AT: Point = { x: 120, y: 120 };
  const frameAt = (p: Point) => ({ x: REGION.x + p.x, y: REGION.y + p.y });

  test('the 1px border every scene draws is the fragile end of the detector', () => {
    // Scenes draw icons with a one-pixel border, because the fill cap rejects
    // three (see above) — but that is also the border least able to survive
    // the anti-aliasing and terrain occlusion a real capture has. Losing one
    // border pixel in twelve is the whole budget: at one in six the ring
    // fragments and the surviving arc's centroid lands 4px off the icon, which
    // is outside the 3px accuracy band every scenario in
    // tests/cv/tracking-simulation.test.ts asserts against.
    const thin = (dropEvery: number) => bare(f => {
      const c = frameAt(AT);
      brokenRing(f, c.x, c.y, ICON_DIAM, TEAL, dropEvery, 1);
    });

    const intact = thin(12);
    expect(intact.iconBlobs).toHaveLength(1);
    expect(near(intact.iconBlobs[0], AT, 1)).toBe(true);

    const fragmented = thin(6);
    expect(fragmented.allBlobs.length).toBeGreaterThan(1);
    expect(fragmented.iconBlobs).toHaveLength(1);
    expect(near(fragmented.iconBlobs[0], AT, 2)).toBe(false);

    // A two-pixel border — what League actually draws at this minimap size —
    // takes a third of its pixels missing and still centres exactly. The
    // detector is not the fragile part; the harness's choice of border is.
    const thick = bare(f => {
      const c = frameAt(AT);
      brokenRing(f, c.x, c.y, ICON_DIAM, TEAL, 3, 2);
    });
    expect(thick.allBlobs).toHaveLength(1);
    expect(thick.iconBlobs).toHaveLength(1);
    expect(near(thick.iconBlobs[0], AT, 1)).toBe(true);
  });

  test('champion art inside the border is tolerated only up to about a tenth cyan', () => {
    // Scenes here draw hollow rings on flat fog. A real icon is a portrait, and
    // every portrait pixel classifyPixel calls teal joins the border's blob —
    // then dilate() spreads each one into a five-pixel cross — so the interior
    // drives fillRatio at the 0.40 cap far faster than its pixel count suggests.
    const withArt = (cyanFraction: number) => bare(f => {
      const c = frameAt(AT);
      portraitArt(f, c.x, c.y, ICON_DIAM, cyanFraction, 7);
      ring(f, c.x, c.y, ICON_DIAM, TEAL, 1);
    });

    const typical = withArt(0.10);
    expect(typical.iconBlobs).toHaveLength(1);
    expect(near(typical.iconBlobs[0], AT, 2)).toBe(true);
    expect(typical.iconBlobs[0].fillRatio).toBeLessThan(0.40);

    // HONEST LIMIT: past roughly a tenth, the icon stops existing as far as the
    // tracker is concerned — detected as a blob, rejected as too dense, never
    // offered to the scorer. Nothing in this repo measures how many of the 172
    // champion icons land on the wrong side of that line; only a real capture
    // can, and this suite's green run is not evidence about it either way.
    const cyanHeavy = withArt(0.20);
    expect(cyanHeavy.iconBlobs).toHaveLength(0);
    expect(cyanHeavy.allBlobs[0].fillRatio).toBeGreaterThan(0.40);
  });
});
