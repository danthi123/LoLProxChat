import {
  getCaptureBoundsForRect,
  getMinimapBounds,
  getMinimapRegionForRect,
  minimapRegionFitsCapture,
  minimapSizeForHeight,
  MINIMAP_CAPTURE_FACTOR,
} from '../../src/core/map-calibration';

describe('getMinimapBounds', () => {
  it('returns bounds in bottom-right of screen for 1920x1080', () => {
    const bounds = getMinimapBounds(1920, 1080);
    // captureSize = round(1080 * 0.35) = 378
    // x = 1920 - 378 = 1542, y = 1080 - 378 = 702
    expect(bounds.x).toBe(1542);
    expect(bounds.y).toBe(702);
    expect(bounds.width).toBe(378);
    expect(bounds.height).toBe(378);
  });

  // The origin-less entry point must stay a pure delegate, so nothing that
  // still calls it can drift away from the rect-based math.
  it('is the origin-(0,0) case of getCaptureBoundsForRect', () => {
    expect(getMinimapBounds(2560, 1440))
      .toEqual(getCaptureBoundsForRect({ x: 0, y: 0, width: 2560, height: 1440 }));
  });
});

describe('getCaptureBoundsForRect', () => {
  // Each of these is a game window the previous, origin-less API could not
  // express: it always anchored the capture square to the primary monitor's
  // bottom-right corner, i.e. to (0, 0) + primary size.
  it('anchors to a monitor RIGHT of the primary one', () => {
    // 2560x1440 at x=1920: captureSize = round(1440 * 0.35) = 504
    expect(getCaptureBoundsForRect({ x: 1920, y: 0, width: 2560, height: 1440 }))
      .toEqual({ x: 3976, y: 936, width: 504, height: 504 });
  });

  it('anchors to a monitor LEFT of the primary one (negative x)', () => {
    expect(getCaptureBoundsForRect({ x: -1920, y: 0, width: 1920, height: 1080 }))
      .toEqual({ x: -378, y: 702, width: 378, height: 378 });
  });

  it('anchors to a monitor ABOVE the primary one (negative y)', () => {
    expect(getCaptureBoundsForRect({ x: 0, y: -1080, width: 1920, height: 1080 }))
      .toEqual({ x: 1542, y: -378, width: 378, height: 378 });
  });

  it('anchors to a monitor both left of and above the primary one', () => {
    // captureSize = round(1440 * 0.35) = 504
    expect(getCaptureBoundsForRect({ x: -2560, y: -400, width: 2560, height: 1440 }))
      .toEqual({ x: -504, y: 536, width: 504, height: 504 });
  });

  it('anchors to a WINDOWED client rect inside the primary monitor', () => {
    // captureSize = round(720 * 0.35) = 252
    expect(getCaptureBoundsForRect({ x: 100, y: 80, width: 1280, height: 720 }))
      .toEqual({ x: 1128, y: 548, width: 252, height: 252 });
  });
});

describe('minimapSizeForHeight', () => {
  // The four measured calibration points the formula was fitted to. These pin
  // it now that it lives outside tracking.ts, where it was previously inline.
  it.each([
    [1080, 0, 200],
    [1080, 3, 420],
    [1440, 0, 280],
    [1440, 3, 560],
  ])('height %i at scale %f is %ipx', (height, scale, expected) => {
    expect(minimapSizeForHeight(height, scale)).toBe(expected);
  });
});

describe('getMinimapRegionForRect', () => {
  // rect.x/rect.y cancel against the same terms inside the capture bounds, so
  // the capture-relative region depends only on the window's SIZE. A "fix" that
  // added the origin a second time would break this and silently offset every
  // tracked position on a secondary monitor.
  it('is invariant to the window origin', () => {
    const size = { width: 1920, height: 1080 };
    const onPrimary = { x: 0, y: 0, ...size };
    const offLeft = { x: -1920, y: -1080, ...size };

    expect(getMinimapRegionForRect(onPrimary, 1, getCaptureBoundsForRect(onPrimary)))
      .toEqual(getMinimapRegionForRect(offLeft, 1, getCaptureBoundsForRect(offLeft)));
  });

  it('places the minimap in the bottom-right of the capture square', () => {
    const rect = { x: -1920, y: 0, width: 1920, height: 1080 };
    const capture = getCaptureBoundsForRect(rect); // 378px
    const region = getMinimapRegionForRect(rect, 1, capture); // 273px minimap

    expect(region).toEqual({ x: 105, y: 105, width: 273, height: 273 });
    // The minimap's bottom-right corner is the capture square's bottom-right.
    expect(region.x + region.width).toBe(capture.width);
    expect(region.y + region.height).toBe(capture.height);
  });
});

describe('minimapRegionFitsCapture', () => {
  const heights = [720, 1080, 1440, 2160];

  // The geometry invariant: the minimap must fit inside the capture square, or
  // the region gets a negative origin and the mask builder — which indexes
  // ((region.y + y) * width + region.x + x) with no clamping — wraps into the
  // previous scanline. 0.35 * height covers MinimapScale up to ~2.4.
  it.each(heights)('a scale of 2.3 fits at %ip', (height) => {
    const rect = { x: 0, y: 0, width: Math.round(height * 16 / 9), height };
    const capture = getCaptureBoundsForRect(rect);
    expect(minimapSizeForHeight(height, 2.3)).toBeLessThanOrEqual(capture.width);
    expect(minimapRegionFitsCapture(getMinimapRegionForRect(rect, 2.3, capture), capture)).toBe(true);
  });

  // The documented top of the calibration range does NOT fit: at 1080p the
  // formula asks for 420px against a 378px capture square. The guard must catch
  // it — without it, region.x is -42.
  it('rejects the scale-3 minimap at 1080p', () => {
    const rect = { x: 0, y: 0, width: 1920, height: 1080 };
    const capture = getCaptureBoundsForRect(rect);
    const region = getMinimapRegionForRect(rect, 3, capture);

    expect(minimapSizeForHeight(1080, 3)).toBeGreaterThan(Math.round(1080 * MINIMAP_CAPTURE_FACTOR));
    expect(region.x).toBe(-42);
    expect(minimapRegionFitsCapture(region, capture)).toBe(false);
  });

  it('accepts a region exactly filling the capture square', () => {
    const capture = { x: 0, y: 0, width: 378, height: 378 };
    expect(minimapRegionFitsCapture({ x: 0, y: 0, width: 378, height: 378 }, capture)).toBe(true);
    expect(minimapRegionFitsCapture({ x: 0, y: 0, width: 379, height: 378 }, capture)).toBe(false);
  });
});
