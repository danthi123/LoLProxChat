import { nextSmoothedVolume } from '../../src/services/peer-connection';

describe('nextSmoothedVolume', () => {
  test('first call (prev=null) snaps directly to the target', () => {
    expect(nextSmoothedVolume(null, 0.8, 1000, 0)).toBe(0.8);
  });

  test('clamps target to [0, 1]', () => {
    expect(nextSmoothedVolume(null, 1.5, 0, 0)).toBe(1);
    expect(nextSmoothedVolume(null, -0.3, 0, 0)).toBe(0);
    expect(nextSmoothedVolume(0.5, 99, 100, 0)).toBeLessThanOrEqual(1);
  });

  test('short dt produces a small step toward the target', () => {
    // 100ms gap, prev=0, target=1 → ~24% of the way there
    const out = nextSmoothedVolume(0, 1, 100, 0);
    expect(out).toBeGreaterThan(0.2);
    expect(out).toBeLessThan(0.3);
  });

  test('long dt is capped at alpha=0.3 — no instant snap to loud target', () => {
    // 60s gap would naively give alpha ≈ 1. Cap forces 0.3.
    // prev=0, target=1 → result ≤ 0.3
    const out = nextSmoothedVolume(0, 1, 60_000, 0);
    expect(out).toBeCloseTo(0.3, 5);
  });

  test('repeated calls converge toward the target over multiple ticks', () => {
    let smoothed: number | null = 0;
    let t = 0;
    const target = 1;
    // 1-second cadence × 5 ticks
    for (let i = 0; i < 5; i++) {
      t += 1000;
      smoothed = nextSmoothedVolume(smoothed, target, t, t - 1000);
    }
    // After 5 seconds of constant target, should be well above 0.8
    expect(smoothed).toBeGreaterThan(0.8);
    // And below or at the cap-bounded ceiling
    expect(smoothed).toBeLessThanOrEqual(1);
  });

  test('asymmetric: one step down covers more of the gap than one step up', () => {
    // This used to assert the two directions were symmetric. They are
    // deliberately not: see the RISE/FALL caps and the comment above them.
    const downStep = nextSmoothedVolume(1, 0, 1000, 0);   // 1.0 -> lower is better
    const upStep = nextSmoothedVolume(0, 1, 1000, 0);     // 0.0 -> higher is louder
    expect(1 - downStep).toBeGreaterThan(upStep);
  });
});

describe('nextSmoothedVolume — asymmetric ramp', () => {
  // Falling quiet fast and rising loud slow are not the same trade. A slow rise
  // protects the listener from a sudden blast; a slow fall just means hearing
  // someone you should not. A tester measured a median 4.9s to silence after
  // panning the camera off a peer, which this halves at the tick rates the
  // volume loop actually runs at once a /compute-volumes round trip is in it.
  /** Seconds to traverse 90% of the range, so both directions are measured the same. */
  const secondsToFall = (hz: number) => {
    const dt = 1000 / hz;
    let v = 1, t = 0;
    while (v > 0.1 && t < 20000) { v = nextSmoothedVolume(v, 0, t + dt, t); t += dt; }
    return t / 1000;
  };
  const secondsToRise = (hz: number) => {
    const dt = 1000 / hz;
    let v = 0, t = 0;
    while (v < 0.9 && t < 20000) { v = nextSmoothedVolume(v, 1, t + dt, t); t += dt; }
    return t / 1000;
  };
  const fadeToSilence = (hz: number) => {
    const dt = 1000 / hz;
    let v = 1, t = 0;
    while (v >= 0.005 && t < 20000) { v = nextSmoothedVolume(v, 0, t + dt, t); t += dt; }
    return t / 1000;
  };

  test('falls faster than it rises at every rate the glide runs at', () => {
    // The two directions have different time constants now, not just different
    // ceilings, so the asymmetry holds whatever the step rate — including the
    // 20Hz the local glide actually ticks at.
    for (const hz of [6, 10, 20]) {
      expect(secondsToFall(hz)).toBeLessThan(secondsToRise(hz));
    }
  });

  test('a peer leaving range is inaudible inside half a second at glide rate', () => {
    // The whole point of moving the glide off the network clock: this number is
    // now a property of the smoother, not of the server round-trip time.
    const dt = 1000 / 20;
    let v = 1;
    let t = 0;
    while (v > 0.05 && t < 20000) { v = nextSmoothedVolume(v, 0, t + dt, t); t += dt; }
    expect(t / 1000).toBeLessThan(0.5);
  });

  test('a peer leaving range is silent well inside two seconds', () => {
    expect(fadeToSilence(6)).toBeLessThan(2.0);
    expect(fadeToSilence(10)).toBeLessThan(2.0);
  });

  test('rising is still gentle — no snap to full volume on one tick', () => {
    // The property the rise cap exists for: a peer re-entering range after a
    // long gap must not arrive at full volume in a single step.
    const afterOneLongGap = nextSmoothedVolume(0, 1, 10_000, 0);
    expect(afterOneLongGap).toBeLessThanOrEqual(0.3);
  });

  test('still snaps on the first sample, so a new peer does not ramp up from 0', () => {
    expect(nextSmoothedVolume(null, 0.42, 1000, 0)).toBe(0.42);
  });
});
