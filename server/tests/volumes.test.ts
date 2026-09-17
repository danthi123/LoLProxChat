import { describe, it, expect } from 'vitest';
import {
  calculateVolume,
  encryptPosition,
  decryptPosition,
  computeVolumes,
  computeVolumesFromRoom,
} from '../src/volumes.js';
import { computeTieredVolumes } from '../src/volumes.js';

// 64 hex chars = 256-bit test key
const TEST_KEY = 'a'.repeat(64);

describe('calculateVolume', () => {
  it('returns exactly 1.0 at distance 0', () => {
    expect(calculateVolume(0)).toBe(1.0);
  });

  it('returns exactly 0.0 at distance >= MAX_HEARING_RANGE', () => {
    expect(calculateVolume(1350)).toBe(0.0);
    expect(calculateVolume(5000)).toBe(0.0);
  });

  it('is strictly monotonically decreasing across the audible range', () => {
    const distances = [0, 100, 200, 400, 600, 800, 1000, 1100, 1199];
    const volumes = distances.map(calculateVolume);
    for (let i = 1; i < volumes.length; i++) {
      expect(volumes[i]).toBeLessThan(volumes[i - 1]);
    }
  });

  it('follows the documented 1 - (d/MAX)² quadratic falloff', () => {
    // At half the hearing range (1350/2 = 675): 1 - 0.5² = 0.75
    expect(calculateVolume(675)).toBeCloseTo(0.75, 5);
    // At 3/4 range (1012.5): 1 - 0.75² = 0.4375
    expect(calculateVolume(1012.5)).toBeCloseTo(0.4375, 5);
  });

  it('is deterministic — same input gives same output', () => {
    // After reverting the v0.1.26 quantization+jitter (v0.1.33), the
    // function is pure: no Math.random() in the path.
    const a = calculateVolume(500);
    const b = calculateVolume(500);
    expect(a).toBe(b);
  });
});

describe('encryptPosition / decryptPosition', () => {
  it('roundtrip preserves position', async () => {
    const blob = await encryptPosition(TEST_KEY, 123.5, -456.7);
    const result = await decryptPosition(TEST_KEY, blob);
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(123.5);
    expect(result!.y).toBeCloseTo(-456.7);
  });

  it('rejects tampered blobs (returns null)', async () => {
    const blob = await encryptPosition(TEST_KEY, 10, 20);
    // Flip the middle character to a guaranteed-different one. A fixed 'Z' was a
    // no-op ~1/64 of runs (when the random IV/ciphertext already had 'Z' there),
    // leaving the blob untampered and the test flaky.
    const repl = blob[20] === 'A' ? 'B' : 'A';
    const tampered = blob.slice(0, 20) + repl + blob.slice(21);
    const result = await decryptPosition(TEST_KEY, tampered);
    expect(result).toBeNull();
  });
});

describe('computeVolumes', () => {
  it('returns myBlob and peerVolumes for valid input', async () => {
    // First encrypt a peer position
    const peerBlob = await encryptPosition(TEST_KEY, 100, 100);

    const result = await computeVolumes(
      {
        myPosition: { x: 100, y: 100 },
        peers: { PeerA: peerBlob },
      },
      TEST_KEY,
    );

    expect(result.myBlob).toBeTruthy();
    expect(typeof result.myBlob).toBe('string');
    expect(result.peerVolumes).toBeDefined();
    expect(typeof result.peerVolumes.PeerA).toBe('number');
    // Same position => distance 0 => exactly 1.0 (continuous since v0.1.33).
    expect(result.peerVolumes.PeerA).toBe(1.0);
  });

  it('returns volume 0 for invalid peer blobs', async () => {
    const result = await computeVolumes(
      {
        myPosition: { x: 0, y: 0 },
        peers: { BadPeer: 'not-a-valid-blob' },
      },
      TEST_KEY,
    );

    expect(result.peerVolumes.BadPeer).toBe(0);
  });
});

describe('computeVolumesFromRoom (v0.2 path)', () => {
  // The function takes a getPositions fn so we don't need a real RoomManager
  // in tests. Pass a closure over a hand-built positions map.
  const makeGetter = (positions: Record<string, { x: number; y: number }>) =>
    () => positions;

  it('computes pairwise volumes against the room state', () => {
    const result = computeVolumesFromRoom(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me' },
      makeGetter({
        Adjacent: { x: 0, y: 0 },       // distance 0 → 1.0
        Mid: { x: 675, y: 0 },           // half range → 0.75
        Far: { x: 1350, y: 0 },          // at edge → 0.0
      }),
    );
    expect(result.peerVolumes.Adjacent).toBe(1.0);
    expect(result.peerVolumes.Mid).toBeCloseTo(0.75, 5);
    expect(result.peerVolumes.Far).toBe(0.0);
    expect(result.myBlob).toBe(''); // v0.2 returns no blob — server already has it
  });

  it('returns empty peerVolumes when no peers have reported positions', () => {
    const result = computeVolumesFromRoom(
      { myPosition: { x: 100, y: 100 }, roomId: 'r1', name: 'Me' },
      makeGetter({}),
    );
    expect(result.peerVolumes).toEqual({});
  });

  it('throws on invalid myPosition', () => {
    expect(() =>
      computeVolumesFromRoom(
        { myPosition: { x: NaN, y: 0 }, roomId: 'r1', name: 'Me' },
        makeGetter({}),
      ),
    ).toThrow('Invalid position');
  });

  it('throws on missing roomId', () => {
    expect(() =>
      computeVolumesFromRoom(
        { myPosition: { x: 0, y: 0 }, roomId: '', name: 'Me' },
        makeGetter({}),
      ),
    ).toThrow('Invalid roomId');
  });

  it('throws on missing name', () => {
    expect(() =>
      computeVolumesFromRoom(
        { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: '' },
        makeGetter({}),
      ),
    ).toThrow('Invalid name');
  });

  it('passes the staleness window through to getPositions', () => {
    const calls: Array<[string, string, number]> = [];
    const getter = (roomId: string, exceptName: string, staleMs: number) => {
      calls.push([roomId, exceptName, staleMs]);
      return {};
    };
    computeVolumesFromRoom(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me' },
      getter,
    );
    expect(calls).toEqual([['r1', 'Me', 5_000]]);
  });
});

describe('computeTieredVolumes (v0.3 path)', () => {
  // getRoomClients signature: (roomId) => TieredRoomClient[]
  // Returns ALL clients in the room including the requester — the function
  // filters out self by name.
  const makeGetter = (clients: Array<{ name: string; team?: 'ORDER' | 'CHAOS'; position?: { x: number; y: number; updatedMs: number } }>) =>
    () => clients;

  it('returns ally at 1.0 regardless of distance', () => {
    const result = computeTieredVolumes(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me' },
      makeGetter([
        { name: 'Me', team: 'ORDER', position: { x: 0, y: 0, updatedMs: Date.now() } },
        { name: 'AllyFarAway', team: 'ORDER', position: { x: 9999, y: 9999, updatedMs: Date.now() } },
      ]),
    );
    expect(result.peerVolumes.AllyFarAway).toBe(1.0);
  });

  it('with allyProximity set, allies use the same distance falloff as enemies', () => {
    const result = computeTieredVolumes(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me', allyProximity: true },
      makeGetter([
        { name: 'Me', team: 'ORDER', position: { x: 0, y: 0, updatedMs: Date.now() } },
        { name: 'AllyClose',  team: 'ORDER', position: { x: 400, y: 0, updatedMs: Date.now() } },
        { name: 'AllyEdge',   team: 'ORDER', position: { x: 1300, y: 0, updatedMs: Date.now() } }, // < 1350 → faint
        { name: 'AllyBeyond', team: 'ORDER', position: { x: 1500, y: 0, updatedMs: Date.now() } }, // > 1350 → omitted
      ]),
    );
    expect(result.peerVolumes.AllyClose).toBeGreaterThan(0.5);
    expect(result.peerVolumes.AllyClose).toBeLessThan(1.0); // proximity, not the global 1.0
    expect(result.peerVolumes.AllyEdge).toBeGreaterThan(0);
    expect(result.peerVolumes.AllyEdge).toBeLessThan(0.1);
    expect(result.peerVolumes.AllyBeyond).toBeUndefined();
  });

  it('makes cross-team enemies audible out to vision range, omitting those beyond', () => {
    const result = computeTieredVolumes(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me' },
      makeGetter([
        { name: 'Me', team: 'ORDER', position: { x: 0, y: 0, updatedMs: Date.now() } },
        { name: 'EnemyClose',  team: 'CHAOS', position: { x: 400, y: 0, updatedMs: Date.now() } },
        { name: 'EnemyEdge',   team: 'CHAOS', position: { x: 1300, y: 0, updatedMs: Date.now() } }, // < 1350 → faintly audible
        { name: 'EnemyBeyond', team: 'CHAOS', position: { x: 1500, y: 0, updatedMs: Date.now() } }, // > 1350 → omitted
      ]),
    );
    expect(result.peerVolumes.EnemyClose).toBeGreaterThan(0);
    expect(result.peerVolumes.EnemyEdge).toBeGreaterThan(0);
    expect(result.peerVolumes.EnemyEdge).toBeLessThan(0.1); // very quiet near the edge of vision
    expect(result.peerVolumes.EnemyBeyond).toBeUndefined();
  });

  it('falls back to team-blind vision-range falloff when requester has no team (legacy v0.2)', () => {
    const result = computeTieredVolumes(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me' },
      makeGetter([
        { name: 'Me', position: { x: 0, y: 0, updatedMs: Date.now() } },
        { name: 'OtherClose', team: 'CHAOS', position: { x: 400, y: 0, updatedMs: Date.now() } },
        { name: 'OtherFar',   team: 'ORDER', position: { x: 1000, y: 0, updatedMs: Date.now() } },
      ]),
    );
    expect(result.peerVolumes.OtherClose).toBeGreaterThan(0);
    expect(result.peerVolumes.OtherFar).toBeGreaterThan(0);
  });

  it('skips stale and missing positions for CROSS-TEAM peers', () => {
    const result = computeTieredVolumes(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me' },
      makeGetter([
        { name: 'Me', team: 'ORDER', position: { x: 0, y: 0, updatedMs: Date.now() } },
        { name: 'NoPos',    team: 'CHAOS' },
        { name: 'StalePos', team: 'CHAOS', position: { x: 100, y: 0, updatedMs: Date.now() - 30_000 } },
      ]),
    );
    expect(result.peerVolumes.NoPos).toBeUndefined();
    expect(result.peerVolumes.StalePos).toBeUndefined();
  });

  it('ALLIES stay at 1.0 even with stale or missing positions (by design — no team-voice proximity)', () => {
    // Allies in SCANNING or long-hold haven't reported coords recently but
    // are still actively transmitting voice. The "team voice always full"
    // design intent is to keep them audible regardless. See comment in
    // computeTieredVolumes for the full reasoning.
    const result = computeTieredVolumes(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me' },
      makeGetter([
        { name: 'Me', team: 'ORDER', position: { x: 0, y: 0, updatedMs: Date.now() } },
        { name: 'AllyNoPos',    team: 'ORDER' },
        { name: 'AllyStalePos', team: 'ORDER', position: { x: 100, y: 0, updatedMs: Date.now() - 30_000 } },
      ]),
    );
    expect(result.peerVolumes.AllyNoPos).toBe(1.0);
    expect(result.peerVolumes.AllyStalePos).toBe(1.0);
  });

  it('returns empty myBlob (v0.2+ shape)', () => {
    const result = computeTieredVolumes(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me' },
      makeGetter([{ name: 'Me', team: 'ORDER', position: { x: 0, y: 0, updatedMs: Date.now() } }]),
    );
    expect(result.myBlob).toBe('');
  });

  it('throws on invalid myPosition', () => {
    expect(() =>
      computeTieredVolumes(
        { myPosition: { x: NaN, y: 0 }, roomId: 'r1', name: 'Me' },
        makeGetter([{ name: 'Me', team: 'ORDER', position: { x: 0, y: 0, updatedMs: Date.now() } }]),
      ),
    ).toThrow('Invalid position');
  });
});

describe('computeTieredVolumes — listenPosition ("voice on camera", #36)', () => {
  const makeGetter = (clients: Array<{ name: string; team?: 'ORDER' | 'CHAOS'; position?: { x: number; y: number; updatedMs: number } }>) =>
    () => clients;

  const room = (enemyAt: { x: number; y: number }) => makeGetter([
    { name: 'Me', team: 'ORDER', position: { x: 0, y: 0, updatedMs: Date.now() } },
    { name: 'Enemy', team: 'CHAOS', position: { ...enemyAt, updatedMs: Date.now() } },
  ]);

  it('hears an enemy near the camera that is out of range of the champion', () => {
    // Champion at origin, enemy 5000u away — far outside the 1350u range.
    // Camera panned to sit right next to the enemy.
    const result = computeTieredVolumes(
      {
        myPosition: { x: 0, y: 0 },
        roomId: 'r1',
        name: 'Me',
        listenPosition: { x: 5000, y: 0 },
      },
      room({ x: 5000, y: 0 }),
    );
    expect(result.peerVolumes.Enemy).toBe(1.0);
  });

  it('stops hearing an enemy next to the champion once the camera pans away', () => {
    const result = computeTieredVolumes(
      {
        myPosition: { x: 0, y: 0 },
        roomId: 'r1',
        name: 'Me',
        listenPosition: { x: 9000, y: 9000 },
      },
      room({ x: 100, y: 0 }),
    );
    expect(result.peerVolumes.Enemy).toBeUndefined();
  });

  it('falls back to the champion position when no listenPosition is sent', () => {
    const result = computeTieredVolumes(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me' },
      room({ x: 100, y: 0 }),
    );
    expect(result.peerVolumes.Enemy).toBeGreaterThan(0);
  });

  it('ignores a malformed listenPosition rather than throwing', () => {
    for (const bad of [null, undefined, {}, { x: 1 }, { x: NaN, y: 0 }, { x: Infinity, y: 0 }, 'nope', 42]) {
      const result = computeTieredVolumes(
        { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me', listenPosition: bad as any },
        room({ x: 100, y: 0 }),
      );
      expect(result.peerVolumes.Enemy).toBeGreaterThan(0);
    }
  });

  it('is listen-only — it never changes what a peer hears from the requester', () => {
    // The requester's camera is parked next to the enemy, but the enemy's own
    // request measures against the requester's CHAMPION position in room state,
    // which the camera never touches.
    const enemyView = computeTieredVolumes(
      { myPosition: { x: 5000, y: 0 }, roomId: 'r1', name: 'Enemy' },
      makeGetter([
        { name: 'Me', team: 'ORDER', position: { x: 0, y: 0, updatedMs: Date.now() } },
        { name: 'Enemy', team: 'CHAOS', position: { x: 5000, y: 0, updatedMs: Date.now() } },
      ]),
    );
    expect(enemyView.peerVolumes.Me).toBeUndefined();
  });

  it('does not let a listenPosition bypass the team filter or the range cutoff', () => {
    const result = computeTieredVolumes(
      {
        myPosition: { x: 0, y: 0 },
        roomId: 'r1',
        name: 'Me',
        listenPosition: { x: 5000, y: 0 },
      },
      room({ x: 9000, y: 9000 }),
    );
    // Enemy is still far from the camera, so still absent from the response.
    expect(result.peerVolumes.Enemy).toBeUndefined();
  });
});
