import { TrackingState, TrackingService } from '../../src/services/tracking';
import type { Blob } from '../../src/services/blob-types';

/** A borderless 1080p game window on the primary monitor. */
const FULL_HD = { x: 0, y: 0, width: 1920, height: 1080 };

// Mock DOM APIs needed by TrackingService constructor
const mockCtx = {} as CanvasRenderingContext2D;
const mockCanvas = {
  width: 0,
  height: 0,
  getContext: jest.fn().mockReturnValue(mockCtx),
} as unknown as HTMLCanvasElement;

(globalThis as any).document = {
  createElement: jest.fn().mockReturnValue(mockCanvas),
};

describe('TrackingState enum', () => {
  test('SCANNING = "scanning"', () => {
    expect(TrackingState.SCANNING).toBe('scanning');
  });

  test('LOCKED = "locked"', () => {
    expect(TrackingState.LOCKED).toBe('locked');
  });

  test('DEAD = "dead"', () => {
    expect(TrackingState.DEAD).toBe('dead');
  });
});

describe('TrackingService state transitions', () => {
  let svc: TrackingService;

  beforeEach(() => {
    svc = new TrackingService(FULL_HD, 'summoners_rift');
  });

  test('starts in SCANNING state', () => {
    expect(svc.getState()).toBe(TrackingState.SCANNING);
  });

  test('onDeath transitions to DEAD', () => {
    svc.onDeath();
    expect(svc.getState()).toBe(TrackingState.DEAD);
  });

  test('onRespawn transitions from DEAD to SCANNING', () => {
    svc.onDeath();
    svc.onRespawn();
    expect(svc.getState()).toBe(TrackingState.SCANNING);
  });

  test('onDeath is idempotent when already DEAD', () => {
    svc.onDeath();
    svc.onDeath(); // should not throw
    expect(svc.getState()).toBe(TrackingState.DEAD);
  });

  test('onRespawn is no-op when not DEAD', () => {
    svc.onRespawn(); // should not transition (already SCANNING)
    expect(svc.getState()).toBe(TrackingState.SCANNING);
  });

  test('getLastPosition returns null initially', () => {
    expect(svc.getLastPosition()).toBeNull();
  });
});

describe('setLastPosition jump warning', () => {
  let svc: TrackingService;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    svc = new TrackingService(FULL_HD, 'summoners_rift');
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // setLastPosition is private — call via reflection. Same trick the
  // tracking module uses internally; tests should mirror its boundary.
  const setLastPosition = (s: TrackingService, pos: { x: number; y: number }, source: string) =>
    (s as any).setLastPosition(pos, source);
  const peekLastPosition = (s: TrackingService) => s.getLastPosition();
  const setLastUpdateMs = (s: TrackingService, ms: number) => { (s as any).lastPositionUpdateMs = ms; };

  test('first call sets position without warning (no prior position to compare)', () => {
    setLastPosition(svc, { x: 1000, y: 1000 }, 'test');
    expect(peekLastPosition(svc)).toEqual({ x: 1000, y: 1000 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('plausible movement does not warn', () => {
    setLastPosition(svc, { x: 1000, y: 1000 }, 'test-1');
    // Pretend last update was 1 second ago; champion moves ~500 game units (slow)
    setLastUpdateMs(svc, performance.now() - 1000);
    setLastPosition(svc, { x: 1500, y: 1000 }, 'test-2');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('CV pixel jitter at high scan rate does NOT warn (small distance gate)', () => {
    // 150-unit jitter in 50ms = 3000 u/s. Speed exceeds the speed gate but
    // distance is below MIN_JUMP_UNITS (500). Was spamming the log pre-v0.1.30.
    setLastPosition(svc, { x: 7400, y: 7200 }, 'locked-track');
    setLastUpdateMs(svc, performance.now() - 50);
    setLastPosition(svc, { x: 7540, y: 7220 }, 'locked-track');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('large jump at impossible speed warns (both gates passed)', () => {
    setLastPosition(svc, { x: 1000, y: 1000 }, 'test-1');
    // 0.05s later, position jumps 5000 game units → 100k u/s, dist > 500.
    setLastUpdateMs(svc, performance.now() - 50);
    setLastPosition(svc, { x: 6000, y: 1000 }, 'classifier-reacquire');
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0].join(' ');
    expect(msg).toContain('[Tracking] WARN');
    expect(msg).toContain('classifier-reacquire');
  });

  test('large distance but at normal walking speed does NOT warn (speed gate)', () => {
    // 600-unit move over 1.5s = 400 u/s — distance passes but speed doesn't.
    setLastPosition(svc, { x: 0, y: 0 }, 'test-1');
    setLastUpdateMs(svc, performance.now() - 1500);
    setLastPosition(svc, { x: 600, y: 0 }, 'test-2');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('position still updates after a warning (warn is not a guard)', () => {
    setLastPosition(svc, { x: 1000, y: 1000 }, 'test-1');
    setLastUpdateMs(svc, performance.now() - 50);
    setLastPosition(svc, { x: 14000, y: 14000 }, 'extrapolate');
    expect(peekLastPosition(svc)).toEqual({ x: 14000, y: 14000 });
  });
});

describe('pixelToGamePosition', () => {
  let svc: TrackingService;

  beforeEach(() => {
    svc = new TrackingService(FULL_HD, 'summoners_rift');
  });

  test('converts origin pixel to top-left game coords', () => {
    const region = { x: 0, y: 0, width: 100, height: 100 };
    const pos = svc.pixelToGamePosition(0, 0, region);
    expect(pos.x).toBeCloseTo(0);
    expect(pos.y).toBeCloseTo(14980); // Y flipped
  });

  test('converts center pixel to center game coords', () => {
    const region = { x: 0, y: 0, width: 100, height: 100 };
    const pos = svc.pixelToGamePosition(50, 50, region);
    expect(pos.x).toBeCloseTo(14870 / 2);
    expect(pos.y).toBeCloseTo(14980 / 2);
  });

  test('clamps out-of-bounds pixels', () => {
    const region = { x: 0, y: 0, width: 100, height: 100 };
    const pos = svc.pixelToGamePosition(-10, 200, region);
    expect(pos.x).toBe(0);
    expect(pos.y).toBe(0); // Y flipped: relY=1 → y=0
  });
});

describe('handleScanning composite scoring', () => {
  const REGION = { x: 0, y: 0, width: 200, height: 200 };

  function mkTealBlob(cx: number, cy: number): Blob {
    return {
      color: 'teal',
      pixels: 100,
      cx, cy,
      minX: cx - 5, maxX: cx + 5,
      minY: cy - 5, maxY: cy + 5,
      fillRatio: 0.8,
    };
  }

  /** Mark `count` white pixels in the ring just outside a blob's bbox. */
  function whiteAround(mask: Uint8Array, blob: Blob, count: number): void {
    let placed = 0;
    for (let x = blob.minX - 5; placed < count; x++) {
      mask[(blob.minY - 5) * REGION.width + x] = 1;
      placed++;
    }
  }

  let svc: TrackingService;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    svc = new TrackingService(FULL_HD, 'summoners_rift');
    svc.setMinimapRegion(REGION);
    // Past the SCANNING warmup, which otherwise returns before any scoring.
    (svc as any).scanStartMs = performance.now() - 5000;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => { /* swallow */ });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  const scan = (blobs: Blob[], whiteMask: Uint8Array) =>
    (svc as any).handleScanning(blobs, whiteMask, new Uint8Array(200 * 200), REGION);

  // The white-pixel term is the only one that differs between these two
  // candidates, so the blob with the champion-mark pixels around it must win
  // regardless of where it sits in the input array.
  test.each([
    ['blob-with-white first', true],
    ['blob-with-white last', false],
  ])('locks onto the higher white-score blob (%s)', (_label, whiteFirst) => {
    const withWhite = mkTealBlob(50, 50);
    const plain = mkTealBlob(150, 150);
    const whiteMask = new Uint8Array(200 * 200);
    whiteAround(whiteMask, withWhite, 8);

    scan(whiteFirst ? [withWhite, plain] : [plain, withWhite], whiteMask);

    expect(svc.getState()).toBe(TrackingState.LOCKED);
    // pixelToGamePosition(50, 50) in a 200px region: x = 0.25 * 14870,
    // y flipped = 0.75 * 14980.
    const pos = svc.getLastPosition();
    expect(pos?.x).toBeCloseTo(14870 * 0.25, 0);
    expect(pos?.y).toBeCloseTo(14980 * 0.75, 0);
  });

  // Issue #13 is diagnosed from user logs; the composite alone cannot say
  // which signal chose the blob. Fails if the per-term breakdown is dropped.
  test('lock-on log carries the winning blob\'s per-term breakdown', () => {
    const whiteMask = new Uint8Array(200 * 200);
    const blob = mkTealBlob(50, 50);
    whiteAround(whiteMask, blob, 4);

    scan([blob], whiteMask);

    const lockLine = logSpy.mock.calls
      .map((c) => c.join(' '))
      .find((m) => m.includes('SCANNING -> LOCKED'));
    expect(lockLine).toBeDefined();
    expect(lockLine).toContain('cls=0.00');
    expect(lockLine).toContain('white=0.50'); // 4 white pixels / 8
    expect(lockLine).toContain('ring=0.10');  // 100 px * (1 - 0.8) / 200
  });

  // Without the classifier the composite is (white * 0.35 + ring * 0.25) / 0.60,
  // which is 1.0 for an all-1 candidate. The removed peer term used to supply a
  // constant 0.40 of that budget; if the divisor were dropped the same blob
  // would score 0.60.
  test('a candidate maxing every surviving term scores 1.0', () => {
    const whiteMask = new Uint8Array(200 * 200);
    const blob = mkTealBlob(50, 50);
    blob.pixels = 1000;
    blob.fillRatio = 0.6; // ring = min(1, 1000 * 0.4 / 200) = 1
    whiteAround(whiteMask, blob, 8); // white = min(1, 8 / 8) = 1

    scan([blob], whiteMask);

    const lockLine = logSpy.mock.calls
      .map((c) => c.join(' '))
      .find((m) => m.includes('SCANNING -> LOCKED'));
    expect(lockLine).toContain('score=1.00');
  });
});

describe('TrackingService game-window geometry', () => {
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => { /* swallow */ });
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => { /* swallow */ });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  // The whole point of the rect constructor: the minimap anchors to the GAME
  // WINDOW's bottom-right corner, not the primary monitor's. On a display left
  // of the primary one that screen X is negative — which the old
  // (screenWidth, screenHeight) constructor could not express at all, since it
  // always implied an origin of (0, 0).
  test('a game window left of the primary monitor yields negative screen bounds', () => {
    const svc = new TrackingService({ x: -1920, y: 0, width: 1920, height: 1080 }, 'summoners_rift');
    svc.setMinimapScaleFromConfig(1);

    const bounds = svc.getDetectedMinimapScreenBounds()!;
    // minimapSizeForHeight(1080, 1) = round(200 + 73.333) = 273
    expect(bounds.screenWidth).toBe(273);
    expect(bounds.screenHeight).toBe(273);
    expect(bounds.screenX).toBe(-273); // -1920 + 1920 - 273
    expect(bounds.screenY).toBe(807);  //     0 + 1080 - 273
  });

  // ...while the capture-RELATIVE region is identical to the primary-monitor
  // case, because the origin cancels. If it did not, every tracked position on
  // a secondary monitor would be offset by the monitor's origin.
  test('the capture-relative region does not depend on which monitor it is on', () => {
    const onPrimary = new TrackingService(FULL_HD, 'summoners_rift');
    const offLeft = new TrackingService({ x: -1920, y: 0, width: 1920, height: 1080 }, 'summoners_rift');
    onPrimary.setMinimapScaleFromConfig(1);
    offLeft.setMinimapScaleFromConfig(1);

    expect((offLeft as any).minimapRegion).toEqual((onPrimary as any).minimapRegion);
    // ...and the absolute capture bounds do.
    expect(offLeft.captureBounds.x).toBe(-378);
    expect(onPrimary.captureBounds.x).toBe(1542);
  });

  // A minimap larger than the capture square gives the region a negative
  // origin, and createMask indexes the frame unclamped — the reads would wrap
  // into the previous scanline. Without the guard this leaves a usable-looking
  // region of {x: -42, y: -42, width: 420, height: 420}.
  test('refuses a MinimapScale whose minimap exceeds the capture square', () => {
    const svc = new TrackingService(FULL_HD, 'summoners_rift');
    svc.setMinimapScaleFromConfig(3); // 420px minimap vs a 378px capture square

    expect((svc as any).minimapRegion).toBeNull();
    expect(svc.getDetectedMinimapScreenBounds()).toBeNull();
    expect(errSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('capture square');
  });

  test('getGameRect reports the rect the service was built from', () => {
    const rect = { x: 1920, y: -400, width: 2560, height: 1440 };
    expect(new TrackingService(rect, 'summoners_rift').getGameRect()).toEqual(rect);
  });
});
