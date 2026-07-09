import { computeFinalPeerVolume, resolveProximityTargets } from '../../src/services/audio';

describe('computeFinalPeerVolume', () => {
  test('proximity × slider when both in [0, 1]', () => {
    expect(computeFinalPeerVolume(0.5, 0.5)).toBe(0.25);
    expect(computeFinalPeerVolume(0.8, 0.4)).toBeCloseTo(0.32);
  });

  test('proximity 0 always returns 0 regardless of slider', () => {
    // The exact scenario from issue #7 — when the user's proximity volume
    // for a peer is 0 (e.g., a clock-skewed peer whose blob the server
    // rejected), moving the slider must NOT produce audible playback.
    expect(computeFinalPeerVolume(0, 0)).toBe(0);
    expect(computeFinalPeerVolume(0, 0.5)).toBe(0);
    expect(computeFinalPeerVolume(0, 1.0)).toBe(0);
  });

  test('slider 0 always returns 0 (per-player mute path)', () => {
    expect(computeFinalPeerVolume(0.8, 0)).toBe(0);
    expect(computeFinalPeerVolume(1.0, 0)).toBe(0);
  });

  test('clamps proximity to [0, 1] defensively', () => {
    expect(computeFinalPeerVolume(-0.5, 1.0)).toBe(0);
    expect(computeFinalPeerVolume(1.5, 1.0)).toBe(1);
  });

  test('clamps slider to [0, 1] defensively', () => {
    expect(computeFinalPeerVolume(0.5, 2.0)).toBe(0.5);
    expect(computeFinalPeerVolume(0.5, -1)).toBe(0);
  });

  test('proximity 1.0 × slider passes the slider through', () => {
    expect(computeFinalPeerVolume(1.0, 0.7)).toBeCloseTo(0.7);
  });
});

describe('resolveProximityTargets', () => {
  test('keeps volumes for peers present in the response', () => {
    const t = resolveProximityTargets({ Ahri: 0.5, Zed: 1.0 }, ['Ahri', 'Zed']);
    expect(t.get('Ahri')).toBe(0.5);
    expect(t.get('Zed')).toBe(1.0);
  });

  test('silences connected peers ABSENT from the response (the stuck-gain bug)', () => {
    // Zed connected but not in the response (server dropped them past the
    // 600u cross-team cap) → must be 0, not left at a stale gain.
    const t = resolveProximityTargets({ Ahri: 0.5 }, ['Ahri', 'Zed']);
    expect(t.get('Ahri')).toBe(0.5);
    expect(t.get('Zed')).toBe(0);
  });

  test('empty response silences every connected peer', () => {
    const t = resolveProximityTargets({}, ['Ahri', 'Zed']);
    expect(t.get('Ahri')).toBe(0);
    expect(t.get('Zed')).toBe(0);
  });

  test('records response peers even if not yet connected (slider/late-join)', () => {
    const t = resolveProximityTargets({ Ahri: 0.5 }, []);
    expect(t.get('Ahri')).toBe(0.5);
    expect(t.size).toBe(1);
  });

  test('does not override a response value with 0 for a connected peer', () => {
    // Ahri is both connected AND in the response — keep the response value.
    const t = resolveProximityTargets({ Ahri: 0.3 }, ['Ahri']);
    expect(t.get('Ahri')).toBe(0.3);
  });

  // Grace window (#27): a peer that briefly drops out of the response (e.g. a
  // dropped coords packet on a lossy / DPI-bypass tunnel) holds its last volume
  // instead of flapping to silence and back.
  test('holds the last volume for a peer absent within the grace window', () => {
    // now=1500, last seen at 1000 → 500ms ago, inside a 1500ms grace → hold 0.6.
    const t = resolveProximityTargets({}, ['Zed'], {
      lastVolumes: new Map([['Zed', 0.6]]),
      lastSeenMs: new Map([['Zed', 1000]]),
      now: 1500,
      graceMs: 1500,
    });
    expect(t.get('Zed')).toBe(0.6);
  });

  test('drops to 0 once a peer has been absent longer than the grace window', () => {
    // now=3000, last seen at 1000 → 2000ms ago, past a 1500ms grace → 0.
    const t = resolveProximityTargets({}, ['Zed'], {
      lastVolumes: new Map([['Zed', 0.6]]),
      lastSeenMs: new Map([['Zed', 1000]]),
      now: 3000,
      graceMs: 1500,
    });
    expect(t.get('Zed')).toBe(0);
  });

  test('a never-seen peer gets 0 even with grace state', () => {
    const t = resolveProximityTargets({}, ['Zed'], {
      lastVolumes: new Map(),
      lastSeenMs: new Map(),
      now: 1000,
      graceMs: 1500,
    });
    expect(t.get('Zed')).toBe(0);
  });

  test('a present peer ignores the grace and takes the response value', () => {
    const t = resolveProximityTargets({ Zed: 0.2 }, ['Zed'], {
      lastVolumes: new Map([['Zed', 0.6]]),
      lastSeenMs: new Map([['Zed', 0]]),
      now: 100000,
      graceMs: 1500,
    });
    expect(t.get('Zed')).toBe(0.2);
  });
});
