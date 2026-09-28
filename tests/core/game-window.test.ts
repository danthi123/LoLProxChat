import {
  GameWindowInfoDto,
  decideGameRectUpdate,
  isPlausibleGameRect,
  rectsAreClose,
  rectsIntersect,
  resolveGameRect,
  WARN_IMPLAUSIBLE,
  WARN_NOT_FOUND,
  WARN_QUERY_FAILED,
} from '../../src/core/game-window';

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 };
/** Primary at (0,0) with a second 1920x1080 monitor to its LEFT. */
const VIRTUAL = { x: -1920, y: 0, width: 3840, height: 1080 };
const ON_SECOND_MONITOR = { x: -1920, y: 0, width: 1920, height: 1080 };

function info(over: Partial<GameWindowInfoDto> = {}): GameWindowInfoDto {
  return {
    found: true,
    rect: ON_SECOND_MONITOR,
    matchedBy: 'class',
    windowTitle: 'League of Legends (TM) Client',
    processName: 'League of Legends.exe',
    virtualScreen: VIRTUAL,
    primaryScreen: PRIMARY,
    error: null,
    ...over,
  };
}

describe('rectsIntersect', () => {
  it('is false for rectangles that only touch along an edge', () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 },
                          { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 },
                          { x: 9, y: 0, width: 10, height: 10 })).toBe(true);
  });

  it('is true for containment, in both directions', () => {
    const outer = { x: -100, y: -100, width: 400, height: 400 };
    const inner = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsIntersect(outer, inner)).toBe(true);
    expect(rectsIntersect(inner, outer)).toBe(true);
  });
});

describe('isPlausibleGameRect', () => {
  it('accepts a negative-origin window that intersects the virtual screen', () => {
    expect(isPlausibleGameRect(ON_SECOND_MONITOR, VIRTUAL)).toBe(true);
  });

  it('rejects a null rect', () => {
    expect(isPlausibleGameRect(null, VIRTUAL)).toBe(false);
  });

  it('rejects zero and negative sizes', () => {
    expect(isPlausibleGameRect({ x: 0, y: 0, width: 0, height: 0 }, VIRTUAL)).toBe(false);
    expect(isPlausibleGameRect({ x: 0, y: 0, width: -1920, height: -1080 }, VIRTUAL)).toBe(false);
  });

  // A crash dialog or splash window owned by the game would otherwise become
  // the capture anchor.
  it('rejects a dialog-sized window', () => {
    expect(isPlausibleGameRect({ x: 0, y: 0, width: 320, height: 240 }, VIRTUAL)).toBe(false);
  });

  // Windows reports (-32000, -32000) for a minimized window. Rust already
  // filters IsIconic, but a rect wholly off the virtual screen must never be
  // used as capture bounds regardless of how it got here.
  it('rejects a rect entirely outside the virtual screen', () => {
    expect(isPlausibleGameRect({ x: -32000, y: -32000, width: 1920, height: 1080 }, VIRTUAL))
      .toBe(false);
  });
});

describe('resolveGameRect', () => {
  it('uses the game window when it is found and plausible', () => {
    expect(resolveGameRect(info())).toEqual({
      rect: ON_SECOND_MONITOR,
      source: 'game-window',
      warning: null,
    });
  });

  it('falls back to the primary monitor with a Borderless hint when not found', () => {
    expect(resolveGameRect(info({ found: false, rect: null, matchedBy: null })))
      .toEqual({ rect: PRIMARY, source: 'primary-screen', warning: WARN_NOT_FOUND });
  });

  it('falls back to the primary monitor when the rect is implausible', () => {
    const resolved = resolveGameRect(info({ rect: { x: 0, y: 0, width: 320, height: 240 } }));
    expect(resolved.source).toBe('primary-screen');
    expect(resolved.rect).toEqual(PRIMARY);
    expect(resolved.warning).toBe(WARN_IMPLAUSIBLE);
  });
});

describe('decideGameRectUpdate', () => {
  const current = ON_SECOND_MONITOR;

  it('keeps the current rect when nothing moved, and clears the warning', () => {
    expect(decideGameRectUpdate(current, info()))
      .toEqual({ action: 'keep', warning: null });
  });

  // The regression this guards: a session that starts before the game window
  // exists falls back to the primary rect and sets the not-found warning. On a
  // single-monitor machine the real rect then EQUALS the fallback, so a rule
  // that only cleared the warning when the rect changed would pin
  // "Can't find the League window" to the panel for the whole scan phase.
  it('clears the warning on an unchanged rect after a failed first resolve', () => {
    const decision = decideGameRectUpdate(PRIMARY, info({ rect: PRIMARY, virtualScreen: PRIMARY }));
    expect(decision.action).toBe('keep');
    expect(decision.warning).toBeNull();
  });

  it('ignores jitter inside the dead zone', () => {
    const jittered = { ...current, x: current.x + 2, height: current.height - 3 };
    expect(rectsAreClose(current, jittered)).toBe(true);
    expect(decideGameRectUpdate(current, info({ rect: jittered })))
      .toEqual({ action: 'keep', warning: null });
  });

  it('reports a real move as an apply', () => {
    const moved = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(decideGameRectUpdate(current, info({ rect: moved })))
      .toEqual({ action: 'apply', rect: moved, warning: null });
  });

  it('treats a 5px move as a move and a 4px move as jitter', () => {
    expect(decideGameRectUpdate(current, info({ rect: { ...current, x: current.x + 4 } })).action)
      .toBe('keep');
    expect(decideGameRectUpdate(current, info({ rect: { ...current, x: current.x + 5 } })).action)
      .toBe('apply');
  });

  // An alt-tabbed or minimizing game reports found: false. Rebuilding then
  // would reset a locked session to SCANNING every 5 seconds.
  it('keeps the current rect when the window is not found', () => {
    expect(decideGameRectUpdate(current, info({ found: false, rect: null })))
      .toEqual({ action: 'keep', warning: WARN_NOT_FOUND });
  });

  it('keeps the current rect when the reported rect is implausible', () => {
    expect(decideGameRectUpdate(current, info({ rect: { x: 0, y: 0, width: 320, height: 240 } })))
      .toEqual({ action: 'keep', warning: WARN_IMPLAUSIBLE });
  });

  it('keeps the current rect when the query itself failed', () => {
    expect(decideGameRectUpdate(current, null))
      .toEqual({ action: 'keep', warning: WARN_QUERY_FAILED });
  });
});

describe('panel warning text', () => {
  // The panel is a ~240px column; detail belongs in the log, not here.
  it.each([WARN_NOT_FOUND, WARN_IMPLAUSIBLE, WARN_QUERY_FAILED])('%s is short', (text) => {
    expect(text.length).toBeLessThanOrEqual(80);
  });
});
