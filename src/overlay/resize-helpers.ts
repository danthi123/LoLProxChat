/**
 * Compute the desired Tauri window height for the overlay panel from its
 * measured `panel.scrollHeight`. Pure for testability — the DOM measurement
 * happens at the call site in overlay.ts.
 *
 * - Adds 4px breathing room so content doesn't sit flush against the bottom edge.
 * - Floors at 120px (collapsed-state header height) so a transient zero-height
 *   measurement during DOM transitions doesn't collapse the window to nothing.
 * - Ceilings at 1200px (sanity cap) so we don't try to size larger than the
 *   smallest plausible game resolution height.
 */
const BREATHING_ROOM_PX = 4;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 1200;

export function computeDesiredHeight(scrollHeight: number): number {
  const raw = scrollHeight + BREATHING_ROOM_PX;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, raw));
}

/**
 * Minimum change (in physical px) before a new size is worth an IPC round trip
 * to Rust. Also the width of the dead band that breaks resize feedback loops:
 * `resize_overlay` changes the window, which can nudge the measured panel by a
 * pixel or two, which would otherwise compute a "new" height and resize again,
 * forever.
 */
export const RESIZE_HYSTERESIS_PX = 3;

/**
 * Whether a freshly measured size should be pushed to the Rust side.
 *
 * v0.5.8: the overlay used to send `resizeOverlay` on every rAF in which a
 * ResizeObserver had fired, with no comparison against what it last sent. Since
 * `broadcastOverlayState()` rewrites the panel DOM at the tracking scan rate
 * (30 FPS), that meant ~30 window resizes per second for the whole match.
 * NotOtakuu's 2026-09-12 log is almost entirely these lines — 2 MB in about a
 * minute, which truncated the part of the log that was actually being asked
 * for, on top of the CPU it burned in the debug mode we ask users to run in.
 *
 * `last === null` (nothing sent yet) always sends.
 */
export function shouldSendSize(
  last: number | null,
  next: number,
  hysteresisPx: number = RESIZE_HYSTERESIS_PX,
): boolean {
  if (last === null) return true;
  return Math.abs(next - last) >= hysteresisPx;
}
