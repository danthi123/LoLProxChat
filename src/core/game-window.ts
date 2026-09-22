import { ScreenRect } from './map-calibration';

/**
 * Pure judgement layer over the `get_game_window_info` Tauri command.
 *
 * The Rust side reports raw facts only. Deciding whether a rect is usable, what
 * to fall back to, and what to tell the user lives here so jest can cover it —
 * CI runs no cargo step and the crate only builds on Windows.
 */

/** Payload of `get_game_window_info`. Mirrors `src-tauri/src/game_window.rs`. */
export interface GameWindowInfoDto {
  found: boolean;
  rect: ScreenRect | null;
  matchedBy: string | null;
  windowTitle: string | null;
  processName: string | null;
  virtualScreen: ScreenRect;
  primaryScreen: ScreenRect;
  error: string | null;
}

export interface ResolvedGameRect {
  rect: ScreenRect;
  source: 'game-window' | 'primary-screen';
  /** Panel-facing text, or null when the game window was used as-is. */
  warning: string | null;
}

export interface GameRectDecision {
  action: 'keep' | 'apply';
  rect?: ScreenRect;
  warning: string | null;
}

/** Below this League cannot be running — it rejects dialogs and splash windows. */
export const MIN_GAME_WIDTH = 640;
export const MIN_GAME_HEIGHT = 480;

/** Ignore sub-pixel jitter in the window rect across polls. */
export const RECT_DEAD_ZONE_PX = 4;

// The panel is a ~240px column, so these stay short; the full geometry goes to
// the log instead.
export const WARN_NOT_FOUND = "Can't find the League window — use Borderless, not fullscreen.";
export const WARN_IMPLAUSIBLE = 'League window looks wrong — using primary monitor.';
export const WARN_QUERY_FAILED = "Couldn't read the League window — using primary monitor.";

export function rectsIntersect(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.width
    && b.x < a.x + a.width
    && a.y < b.y + b.height
    && b.y < a.y + a.height;
}

export function isPlausibleGameRect(rect: ScreenRect | null, virtualScreen: ScreenRect): boolean {
  if (!rect) return false;
  return rect.width >= MIN_GAME_WIDTH
    && rect.height >= MIN_GAME_HEIGHT
    && rectsIntersect(rect, virtualScreen);
}

/** True when every edge of `next` is within `RECT_DEAD_ZONE_PX` of `current`. */
export function rectsAreClose(current: ScreenRect, next: ScreenRect): boolean {
  return Math.abs(next.x - current.x) <= RECT_DEAD_ZONE_PX
    && Math.abs(next.y - current.y) <= RECT_DEAD_ZONE_PX
    && Math.abs(next.width - current.width) <= RECT_DEAD_ZONE_PX
    && Math.abs(next.height - current.height) <= RECT_DEAD_ZONE_PX;
}

/**
 * Pick the rect all capture geometry derives from, at session start.
 * Falls back to the primary monitor — which is what every build before this one
 * always used — so a lookup failure degrades to the old behavior plus a warning
 * rather than to no tracking at all.
 */
export function resolveGameRect(info: GameWindowInfoDto): ResolvedGameRect {
  if (info.found && isPlausibleGameRect(info.rect, info.virtualScreen)) {
    return { rect: info.rect as ScreenRect, source: 'game-window', warning: null };
  }
  return {
    rect: info.primaryScreen,
    source: 'primary-screen',
    warning: info.found ? WARN_IMPLAUSIBLE : WARN_NOT_FOUND,
  };
}

/**
 * Decide what the periodic geometry poll should do with a fresh reading.
 *
 * `warning` is authoritative on every call — a successful, plausible read
 * clears it whether or not the rect moved. Without that, a session that started
 * before the game window existed keeps showing "can't find the League window"
 * for its whole scan phase on a single-monitor machine, where the fallback rect
 * happens to equal the real one and the rect-change branch never fires.
 *
 * `found === false` never rebuilds: an alt-tabbed or minimizing game must not
 * tear down a locked session.
 */
export function decideGameRectUpdate(
  current: ScreenRect,
  info: GameWindowInfoDto | null,
): GameRectDecision {
  if (!info) return { action: 'keep', warning: WARN_QUERY_FAILED };
  if (!info.found) return { action: 'keep', warning: WARN_NOT_FOUND };
  if (!isPlausibleGameRect(info.rect, info.virtualScreen)) {
    return { action: 'keep', warning: WARN_IMPLAUSIBLE };
  }
  const rect = info.rect as ScreenRect;
  if (rectsAreClose(current, rect)) return { action: 'keep', warning: null };
  return { action: 'apply', rect, warning: null };
}
