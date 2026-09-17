export interface MinimapBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A rectangle in screen (virtual-desktop) coordinates. x/y are negative for a
 * monitor left of / above the primary one, which is why every geometry helper
 * here takes an origin instead of assuming (0, 0).
 */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Fraction of the game window's height captured as the minimap search square.
 * This covers MinimapScale up to ~2.4 at every resolution; anything larger does
 * not fit and is rejected rather than read out of bounds — see
 * `minimapRegionFitsCapture`.
 */
export const MINIMAP_CAPTURE_FACTOR = 0.35;

/**
 * Capture square for a game window, in screen coordinates. The minimap sits in
 * the bottom-right corner of the game window's CLIENT area — not of a monitor —
 * so this is anchored to the rect's bottom-right, origin included.
 */
export function getCaptureBoundsForRect(rect: ScreenRect): MinimapBounds {
  const captureSize = Math.round(rect.height * MINIMAP_CAPTURE_FACTOR);
  return {
    x: rect.x + rect.width - captureSize,
    y: rect.y + rect.height - captureSize,
    width: captureSize,
    height: captureSize,
  };
}

export function getMinimapBounds(screenWidth: number, screenHeight: number): MinimapBounds {
  return getCaptureBoundsForRect({ x: 0, y: 0, width: screenWidth, height: screenHeight });
}

/**
 * Minimap edge length for League's MinimapScale config value.
 * Calibrated from real measurements:
 *   1080p: scale 0 → 200px, scale 3 → 420px
 *   1440p: scale 0 → 280px, scale 3 → 560px
 */
export function minimapSizeForHeight(height: number, scale: number): number {
  const base = height * 2 / 9 - 40;   // size at scale 0
  const rate = height / 18 + 40 / 3;  // additional size per scale unit
  return Math.round(base + scale * rate);
}

/**
 * The minimap's position within a capture frame, i.e. relative to `capture`'s
 * origin rather than to the screen.
 *
 * Note that `rect.x` and `rect.y` cancel against the same terms inside
 * `capture`, so the result depends only on the window's SIZE. That is what
 * makes negative screen origins structurally safe downstream: the origin
 * matters only in the absolute capture bounds handed to the Rust side.
 */
export function getMinimapRegionForRect(
  rect: ScreenRect,
  scale: number,
  capture: MinimapBounds,
): MinimapBounds {
  const size = minimapSizeForHeight(rect.height, scale);
  return {
    x: (rect.x + rect.width - size) - capture.x,
    y: (rect.y + rect.height - size) - capture.y,
    width: size,
    height: size,
  };
}

/**
 * Whether a minimap region lies wholly inside the captured frame.
 *
 * A minimap bigger than the capture square gives the region a negative origin,
 * and the mask builder indexes the frame as `((y + region.y) * width + ...)`
 * with no clamping — negative offsets wrap into the previous scanline instead
 * of failing. Callers must refuse such a region rather than scan it.
 */
export function minimapRegionFitsCapture(region: MinimapBounds, capture: MinimapBounds): boolean {
  return region.x >= 0
    && region.y >= 0
    && region.x + region.width <= capture.width
    && region.y + region.height <= capture.height;
}
