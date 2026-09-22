import { describe, it, expect } from 'vitest';
import {
  calculateVolume,
  encryptPosition,
  decryptPosition,
  computeVolumes,
  computeVolumesFromRoom,
} from '../src/volumes.js';
import { computeTieredVolumes, closestApproach } from '../src/volumes.js';

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

  it('is flat across the plateau, then strictly decreasing to the cutoff', () => {
    // Inside the plateau every distance is equally loud — that is the point of
    // it, and it is also why volume carries no distance information there.
    for (const d of [0, 100, 400, 700, 899, 900]) {
      expect(calculateVolume(d)).toBe(1.0);
    }
    const falling = [901, 1000, 1100, 1200, 1300, 1349].map(calculateVolume);
    for (let i = 1; i < falling.length; i++) {
      expect(falling[i]).toBeLessThan(falling[i - 1]);
    }
  });

  it('keeps a ranged lane trade at full volume', () => {
    // The curve exists for two ranged champions holding a lane against each
    // other. Anything under the plateau must be indistinguishable from melee
    // range, which the pure-falloff curve it replaced was not: it put 700u at
    // 0.73 against melee's 0.95.
    expect(calculateVolume(550)).toBe(calculateVolume(150));
    expect(calculateVolume(700)).toBe(1.0);
  });

  it('falls quadratically across the outer band only', () => {
    // Half way through the 900-1350 band (1125): 1 - 0.5² = 0.75
    expect(calculateVolume(1125)).toBeCloseTo(0.75, 5);
    // Three quarters through (1237.5): 1 - 0.75² = 0.4375
    expect(calculateVolume(1237.5)).toBeCloseTo(0.4375, 5);
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
        Mid: { x: 1125, y: 0 },          // half way through the falloff band → 0.75
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
        { name: 'AllyClose',  team: 'ORDER', position: { x: 1050, y: 0, updatedMs: Date.now() } }, // in the band → attenuated
        { name: 'AllyEdge',   team: 'ORDER', position: { x: 1340, y: 0, updatedMs: Date.now() } }, // just inside 1350 → faint
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
        { name: 'EnemyEdge',   team: 'CHAOS', position: { x: 1340, y: 0, updatedMs: Date.now() } }, // < 1350 → faintly audible
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

describe('computeTieredVolumes — "voice on camera" (#36)', () => {
  // The feature is an opt-in BETWEEN two players. A camera in room state IS
  // the consent: a client publishes one only while the user has the setting
  // on, the server reads the requester's own from room state too, and a camera
  // counts for a pair only when both sides have published one.
  //
  // That makes the whole thing symmetric — the point you listen from is a
  // point you can be heard at — and it means a player who leaves the setting
  // off can only be heard by someone actually near them on the map, whatever
  // anyone else does with their camera.
  type Client = {
    name: string;
    team?: 'ORDER' | 'CHAOS';
    position?: { x: number; y: number; updatedMs: number };
    camera?: { x: number; y: number; updatedMs: number };
  };
  const makeGetter = (clients: Client[]) => () => clients;

  const now = () => Date.now();
  const at = (x: number, y: number) => ({ x, y, updatedMs: now() });

  /** Both players opted in; each camera given, or omitted to mean "off". */
  const pair = (
    mePos: { x: number; y: number },
    enemyPos: { x: number; y: number },
    myCam?: { x: number; y: number },
    enemyCam?: { x: number; y: number },
  ) => makeGetter([
    { name: 'Me', team: 'ORDER', position: at(mePos.x, mePos.y), camera: myCam && at(myCam.x, myCam.y) },
    { name: 'Enemy', team: 'CHAOS', position: at(enemyPos.x, enemyPos.y), camera: enemyCam && at(enemyCam.x, enemyCam.y) },
  ]);

  const ask = (name: string, myPosition: { x: number; y: number }, getter: () => Client[]) =>
    computeTieredVolumes({ myPosition, roomId: 'r1', name }, getter);

  it('hears an enemy near the camera that is out of range of the champion', () => {
    // Champions 5000u apart, far outside the 1350u range. Both opted in, and
    // my camera is parked on top of the enemy.
    const room = pair({ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 0 });
    expect(ask('Me', { x: 0, y: 0 }, room).peerVolumes.Enemy).toBe(1.0);
  });

  it('...and the enemy hears the eavesdropper just as loudly', () => {
    // The point of the symmetry: listening from a camera means being audible
    // at it. Panning onto a fight to listen in is not free.
    const room = pair({ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 0 });
    expect(ask('Enemy', { x: 5000, y: 0 }, room).peerVolumes.Me).toBe(1.0);
  });

  it('gives both sides the same volume however the four points are arranged', () => {
    const cases: Array<[{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }]> = [
      [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 4800, y: 0 }, { x: 300, y: 0 }],
      [{ x: 0, y: 0 }, { x: 1200, y: 0 }, { x: 9000, y: 9000 }, { x: 9000, y: 9000 }],
      [{ x: 700, y: 700 }, { x: 8000, y: 200 }, { x: 8000, y: 900 }, { x: 4000, y: 4000 }],
    ];
    for (const [mePos, enemyPos, myCam, enemyCam] of cases) {
      const room = pair(mePos, enemyPos, myCam, enemyCam);
      expect(ask('Me', mePos, room).peerVolumes.Enemy)
        .toBe(ask('Enemy', enemyPos, room).peerVolumes.Me);
    }
  });

  it('keeps hearing an enemy beside the champion while the camera is elsewhere', () => {
    // The camera ADDS a listening point, it does not move the one you already
    // had. Glancing across the map must not cut out the person you are
    // fighting — which the old replace-the-listen-point behaviour did.
    const room = pair({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 9000, y: 9000 }, { x: 9000, y: 9000 });
    expect(ask('Me', { x: 0, y: 0 }, room).peerVolumes.Enemy).toBeGreaterThan(0);
  });

  it('ignores my camera entirely when the enemy has the setting off', () => {
    // This is what lets someone keep the setting off in a competitive game and
    // know that nobody can listen in on them from across the map.
    const room = pair({ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 0 }, undefined);
    expect(ask('Me', { x: 0, y: 0 }, room).peerVolumes.Enemy).toBeUndefined();
    expect(ask('Enemy', { x: 5000, y: 0 }, room).peerVolumes.Me).toBeUndefined();
  });

  it('ignores the enemy camera when I have the setting off', () => {
    const room = pair({ x: 0, y: 0 }, { x: 5000, y: 0 }, undefined, { x: 0, y: 0 });
    expect(ask('Me', { x: 0, y: 0 }, room).peerVolumes.Enemy).toBeUndefined();
    expect(ask('Enemy', { x: 5000, y: 0 }, room).peerVolumes.Me).toBeUndefined();
  });

  it('ignores a listenPosition in the request — a camera must be published', () => {
    // The old wire field. Honouring it would let a client listen from a point
    // its peers are never scored against, which is exactly the asymmetry this
    // design removes. Both players have the setting off here; the request asks
    // to hear from on top of the enemy anyway.
    const room = pair({ x: 0, y: 0 }, { x: 5000, y: 0 });
    const result = computeTieredVolumes(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me', listenPosition: { x: 5000, y: 0 } },
      room,
    );
    expect(result.peerVolumes.Enemy).toBeUndefined();
  });

  it('...and cannot be used to smuggle a camera past an opted-out peer', () => {
    const room = pair({ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 0 }, undefined);
    const result = computeTieredVolumes(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me', listenPosition: { x: 5000, y: 0 } },
      room,
    );
    expect(result.peerVolumes.Enemy).toBeUndefined();
  });

  it('treats a stale camera as absent', () => {
    const stale = Date.now() - 60_000;
    const room = makeGetter([
      { name: 'Me', team: 'ORDER', position: at(0, 0), camera: { x: 5000, y: 0, updatedMs: stale } },
      { name: 'Enemy', team: 'CHAOS', position: at(5000, 0), camera: { x: 5000, y: 0, updatedMs: stale } },
    ]);
    expect(ask('Me', { x: 0, y: 0 }, room).peerVolumes.Enemy).toBeUndefined();
  });

  it('does not let a camera bypass the range cutoff', () => {
    // All four combinations beyond 1350u.
    const room = pair({ x: 0, y: 0 }, { x: 9000, y: 9000 }, { x: 5000, y: 0 }, { x: 2000, y: 8000 });
    expect(ask('Me', { x: 0, y: 0 }, room).peerVolumes.Enemy).toBeUndefined();
  });

  it('lets two opted-in players watching the same fight hear each other', () => {
    // Neither champion is anywhere near the other, and neither is near the
    // fight — but both have put a listening point on it, and a listening point
    // is also a point you are audible at. Falls out of the symmetry rather
    // than being a special case, and is asserted here so it stays deliberate.
    const room = pair({ x: 500, y: 500 }, { x: 13000, y: 13000 }, { x: 7000, y: 7000 }, { x: 7200, y: 7000 });
    expect(ask('Me', { x: 500, y: 500 }, room).peerVolumes.Enemy).toBe(1.0);
    expect(ask('Enemy', { x: 13000, y: 13000 }, room).peerVolumes.Me).toBe(1.0);
  });

  it('does not let a camera bypass the team filter', () => {
    // An ally is 1.0 by the team rule and never reaches the distance path at
    // all; the camera must not turn that into a distance answer either way.
    const room = makeGetter([
      { name: 'Me', team: 'ORDER', position: at(0, 0), camera: at(9000, 9000) },
      { name: 'Ally', team: 'ORDER', position: at(5000, 0), camera: at(9000, 9000) },
    ]);
    expect(ask('Me', { x: 0, y: 0 }, room).peerVolumes.Ally).toBe(1.0);
  });

  it('applies to allies too once the requester opts into ally proximity', () => {
    const room = makeGetter([
      { name: 'Me', team: 'ORDER', position: at(0, 0), camera: at(5000, 0) },
      { name: 'Ally', team: 'ORDER', position: at(5000, 0), camera: at(5000, 0) },
    ]);
    const result = computeTieredVolumes(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me', allyProximity: true },
      room,
    );
    expect(result.peerVolumes.Ally).toBe(1.0);
  });
});

describe('closestApproach', () => {
  it('is the champion-to-champion distance when neither side has a camera', () => {
    expect(closestApproach([{ x: 0, y: 0 }], [{ x: 300, y: 400 }])).toBe(500);
  });

  it('picks the closest of the four combinations', () => {
    const me = [{ x: 0, y: 0 }, { x: 5000, y: 0 }];
    const them = [{ x: 9000, y: 0 }, { x: 5100, y: 0 }];
    expect(closestApproach(me, them)).toBe(100);
  });

  it('is symmetric', () => {
    const a = [{ x: 0, y: 0 }, { x: 700, y: 900 }];
    const b = [{ x: 1200, y: 40 }, { x: 5, y: 60 }];
    expect(closestApproach(a, b)).toBe(closestApproach(b, a));
  });
});

// The other half of docs/threat-model.md Part 1, in the blocking `server` job:
// /compute-volumes is the one endpoint that HAS every peer's raw XY in hand,
// and it must answer with gains only. `index.ts` writes `JSON.stringify(result)`
// straight to the response, so the wire payload is exactly what these functions
// return. tests/e2e/compliance.e2e.test.ts sweeps the live responses, but it
// runs only in the continue-on-error `e2e` job — see .github/workflows/ci.yml.
describe('/compute-volumes response shape', () => {
  /** Every object anywhere in `value`, the root included. */
  function objectsIn(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
    if (Array.isArray(value)) {
      for (const item of value) objectsIn(item, out);
    } else if (value && typeof value === 'object') {
      out.push(value as Record<string, unknown>);
      for (const item of Object.values(value)) objectsIn(item, out);
    }
    return out;
  }

  /** A numeric x/y pair is what a leaked game coordinate looks like on the wire. */
  function coordinateShaped(value: unknown): Record<string, unknown>[] {
    return objectsIn(value).filter(o => typeof o.x === 'number' && typeof o.y === 'number');
  }

  /**
   * Asserts the exact payload contract. Serialised first, because that is what
   * the client receives and because an undefined-valued key would otherwise
   * pass a key-set check while being absent on the wire.
   */
  function expectGainsOnly(result: unknown): Record<string, any> {
    const wire = JSON.parse(JSON.stringify(result));
    expect(Object.keys(wire).sort()).toEqual(['myBlob', 'peerVolumes']);
    expect(typeof wire.myBlob).toBe('string');
    for (const [name, volume] of Object.entries(wire.peerVolumes)) {
      expect(typeof name).toBe('string');
      expect(typeof volume).toBe('number');
      expect(volume as number).toBeGreaterThanOrEqual(0);
      expect(volume as number).toBeLessThanOrEqual(1);
    }
    expect(coordinateShaped(wire)).toEqual([]);
    return wire;
  }

  const now = () => Date.now();

  it('answers the v0.3 tiered path with gains only', () => {
    const wire = expectGainsOnly(computeTieredVolumes(
      { myPosition: { x: 4200, y: 7300 }, roomId: 'r1', name: 'Me' },
      () => [
        { name: 'Me', team: 'ORDER', position: { x: 4200, y: 7300, updatedMs: now() } },
        { name: 'Ally', team: 'ORDER', position: { x: 9000, y: 1000, updatedMs: now() } },
        { name: 'Enemy', team: 'CHAOS', position: { x: 4600, y: 7300, updatedMs: now() } },
      ],
    ));
    // Both tiers present, so the sweep above ran over a populated response
    // rather than an empty one.
    expect(Object.keys(wire.peerVolumes).sort()).toEqual(['Ally', 'Enemy']);
  });

  it('answers the camera path with gains only', () => {
    // #36 puts a SECOND coordinate pair per player into room state, which is
    // the newest thing this endpoint could leak. It holds four raw positions
    // for this pair and must still answer with one number.
    const wire = expectGainsOnly(computeTieredVolumes(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me' },
      () => [
        { name: 'Me', team: 'ORDER', position: { x: 0, y: 0, updatedMs: now() }, camera: { x: 5000, y: 0, updatedMs: now() } },
        { name: 'Enemy', team: 'CHAOS', position: { x: 5100, y: 0, updatedMs: now() }, camera: { x: 9000, y: 9000, updatedMs: now() } },
      ],
    ));
    expect(wire.peerVolumes.Enemy).toBeGreaterThan(0);
  });

  it('answers the v0.2 room path with gains only', () => {
    const wire = expectGainsOnly(computeVolumesFromRoom(
      { myPosition: { x: 0, y: 0 }, roomId: 'r1', name: 'Me' },
      () => ({ Near: { x: 400, y: 0 } }),
    ));
    expect(wire.peerVolumes.Near).toBeGreaterThan(0);
  });

  it('answers the legacy v0.1 encrypted path with gains only', async () => {
    const peerBlob = await encryptPosition(TEST_KEY, 400, 0);
    const wire = expectGainsOnly(await computeVolumes(
      { myPosition: { x: 0, y: 0 }, peers: { PeerA: peerBlob } },
      TEST_KEY,
    ));
    expect(wire.peerVolumes.PeerA).toBeGreaterThan(0);
    // This path really does return a blob, so the myBlob key is not vacuously
    // an empty string in every branch.
    expect(wire.myBlob).not.toBe('');
  });

  it('answers with gains only when the requester is not in the room', () => {
    // The early-return branch — a separate return statement, so it needs its
    // own sweep.
    const wire = expectGainsOnly(computeTieredVolumes(
      { myPosition: { x: 4200, y: 7300 }, roomId: 'r1', name: 'Stranger' },
      () => [{ name: 'Me', team: 'ORDER', position: { x: 4200, y: 7300, updatedMs: now() } }],
    ));
    expect(wire.peerVolumes).toEqual({});
  });
});
