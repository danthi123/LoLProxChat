import { computeDesiredHeight, shouldSendSize } from '../../src/overlay/resize-helpers';

describe('computeDesiredHeight', () => {
  test('adds 4px breathing room for normal content sizes', () => {
    expect(computeDesiredHeight(400)).toBe(404);
    expect(computeDesiredHeight(623)).toBe(627);
  });

  test('floors at 120 (collapsed-state floor)', () => {
    expect(computeDesiredHeight(0)).toBe(120);
    expect(computeDesiredHeight(50)).toBe(120);
    expect(computeDesiredHeight(115)).toBe(120);
  });

  test('ceilings at 1200 (sanity cap)', () => {
    expect(computeDesiredHeight(2000)).toBe(1200);
    expect(computeDesiredHeight(1300)).toBe(1200);
  });

  test('returns exactly the floor at the transition boundary', () => {
    // 116 + 4 = 120 → still equals floor
    expect(computeDesiredHeight(116)).toBe(120);
    // 117 + 4 = 121 → above floor
    expect(computeDesiredHeight(117)).toBe(121);
  });

  test('returns exactly the ceiling at the transition boundary', () => {
    // 1196 + 4 = 1200 → at ceiling
    expect(computeDesiredHeight(1196)).toBe(1200);
    // 1197 + 4 = 1201 → still clamped to 1200
    expect(computeDesiredHeight(1197)).toBe(1200);
  });
});

describe('shouldSendSize', () => {
  test('always sends the first measurement', () => {
    expect(shouldSendSize(null, 300)).toBe(true);
  });

  test('suppresses an unchanged size — the resize-storm fix', () => {
    // broadcastOverlayState() rewrites the panel DOM ~30x/sec; every one of
    // those used to reach Rust as a window resize (NotOtakuu 2026-09-12).
    expect(shouldSendSize(300, 300)).toBe(false);
  });

  test('suppresses sub-hysteresis jitter in both directions', () => {
    expect(shouldSendSize(300, 302)).toBe(false);
    expect(shouldSendSize(300, 298)).toBe(false);
  });

  test('sends once the change reaches the hysteresis band', () => {
    expect(shouldSendSize(300, 303)).toBe(true);
    expect(shouldSendSize(300, 297)).toBe(true);
  });

  test('a real content change (settings opened) always gets through', () => {
    expect(shouldSendSize(120, 420)).toBe(true);
  });

  test('a two-value oscillation inside the band cannot sustain itself', () => {
    // The feedback loop shape: resize -> remeasure -> slightly different -> resize.
    let lastSent: number | null = null;
    let sends = 0;
    for (const measured of [300, 301, 300, 301, 300, 301]) {
      if (shouldSendSize(lastSent, measured)) {
        lastSent = measured;
        sends++;
      }
    }
    expect(sends).toBe(1);
  });
});
