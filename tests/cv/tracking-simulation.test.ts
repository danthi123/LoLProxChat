// Scripted minimaps in, reported game coordinates out.
//
// Every scenario here drives the REAL TrackingService — real colour
// classification, real dilate/flood-fill blob detection, real scoring, real
// state machine — over synthesized frames whose ground truth is known exactly.
// tests/cv/harness-selfcheck.test.ts is what guarantees the frames really
// contain what these scenarios say they contain.
//
// HONEST LIMITS: the icons are flat coloured rings with no champion art,
// perfect colours and no anti-aliasing. This suite proves the geometry, the
// state machine and the scoring wiring. It does NOT prove that the ONNX
// classifier recognises real icons (models/champion-classifier-metrics.json and
// real-game validation cover that), nor that classifyPixel's thresholds survive
// real minimap rendering. How much easier those flat rings are than a real icon
// is measured, not assumed: see "the frames are not easier than a real minimap"
// in tests/cv/harness-selfcheck.test.ts, which pins the border loss and the
// portrait-art fraction at which the detector stops seeing an icon at all.

import { MAP_DIMENSIONS } from '../../src/core/types';
import { TrackingState } from '../../src/services/tracking';
import { FORCED_REACQUIRE_HOLD_MS } from '../../src/services/tracking-helpers';
import { driveTracker, FRAME_MS, metrics, newTracker } from './harness/drive';
import {
  IndiscriminateScorer,
  OracleScorer,
  SpikingScorer,
  UnloadedScorer,
  ZeroScorer,
} from './harness/scorers';
import {
  ICON_DIAM,
  Point,
  REGION,
  SceneSpec,
  gameToTruth,
  renderScenes,
  toFramePoint,
  truthToGame,
} from './harness/scenes';

/** The static furniture every scenario is played against. */
const BACKDROP: SceneSpec = {
  allies: [{ x: 40, y: 45 }, { x: 250, y: 245 }],
  enemies: [{ x: 105, y: 35 }, { x: 250, y: 160 }],
  minions: [{ x: 215, y: 205 }],
  turrets: [{ x: 30, y: 245 }],
  camera: { x: 140, y: 30, w: 110, h: 80 },
};

const START: Point = { x: 60, y: 200 };
const STEP: Point = { x: 2, y: -1 };

function at(from: Point, step: Point, i: number): Point {
  return { x: from.x + step.x * i, y: from.y + step.y * i };
}

/** `count` frames of the champion walking, trail pointing back the way it came. */
function walk(count: number, from: Point = START, step: Point = STEP, over: SceneSpec = BACKDROP): SceneSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    ...over,
    self: at(from, step, i),
    selfTrail: { x: -step.x, y: -step.y },
  }));
}

/** `count` frames with the local champion's icon not drawn at all. */
function vanished(count: number, over: SceneSpec = BACKDROP): SceneSpec[] {
  return Array.from({ length: count }, () => ({ ...over, self: null }));
}

/** Frames with no teal blob anywhere — nothing for the tracker to follow. */
const NO_TEAL: SceneSpec = { enemies: BACKDROP.enemies, camera: BACKDROP.camera };

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Console is captured rather than silenced: several assertions read it back. */
function captureConsole(): string[] {
  const lines: string[] = [];
  const record = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  jest.spyOn(console, 'log').mockImplementation(record);
  jest.spyOn(console, 'warn').mockImplementation(record);
  jest.spyOn(console, 'error').mockImplementation(record);
  return lines;
}

let logs: string[];

beforeEach(() => {
  jest.useFakeTimers();
  logs = captureConsole();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('a classifier that scores the local champion 0.000 every frame (v0.5.8, #13)', () => {
  test('the tracker still locks on and follows the icon', async () => {
    const scenes = renderScenes(walk(60));
    const classifier = new ZeroScorer();
    const h = newTracker(scenes.map(s => s.frame), { classifier });

    const records = await driveTracker(h, scenes);
    const m = metrics(records);

    // The classifier really was in the loop, and really said nothing useful —
    // otherwise this scenario is not the one that broke v0.5.8.
    expect(classifier.runs).toBeGreaterThan(0);

    // Warmup is 1000ms with a classifier loaded: 8 frames at 125ms.
    expect(m.lockFrame).toBeGreaterThanOrEqual(7);
    expect(m.lockFrame).toBeLessThanOrEqual(12);

    // The failure this guards against is a position that stops moving while the
    // champion keeps walking: locked, held, force-reacquired, locked again,
    // with the broadcast coordinates pinned at the lock point the whole time.
    expect(m.maxErrorPx).toBeLessThanOrEqual(3);
    expect(m.scanningReentries).toBe(0);
    expect(m.longestFrozenRun).toBeLessThanOrEqual(2);
    expect(logs.filter(l => l.includes('forcing re-acquisition'))).toHaveLength(0);

    // And it moved: a frozen tracker satisfies an error bound against a frozen
    // expectation, so the reported travel has to be checked in its own right.
    const first = records[m.lockFrame].game!;
    const last = records[records.length - 1].game!;
    expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeGreaterThan(3000);
  });

  test('the reported coordinates are the ground truth, not just self-consistent', async () => {
    const scenes = renderScenes(walk(24));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });

    const records = await driveTracker(h, scenes);
    const last = records[records.length - 1];

    // Ground truth converted independently of pixelToGamePosition, so a bug in
    // the conversion cannot cancel out against the expectation.
    const expected = truthToGame(last.truth!);
    expect(last.game!.x).toBeCloseTo(expected.x, -2);
    expect(last.game!.y).toBeCloseTo(expected.y, -2);
    expect(last.game!.x).toBeGreaterThan(0);
    expect(last.game!.x).toBeLessThan(MAP_DIMENSIONS.summoners_rift.width);
  });

  test('it locks onto the icon with the movement trail, not onto a nearer ally', async () => {
    // With the classifier silent, the trail is the only thing distinguishing
    // the local champion from the two allies in the backdrop.
    const scenes = renderScenes(walk(20));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });

    const records = await driveTracker(h, scenes);
    const locked = records[records.length - 1];

    for (const ally of BACKDROP.allies!) {
      expect(distance(locked.px!, ally)).toBeGreaterThan(20);
    }
    expect(distance(locked.px!, locked.truth!)).toBeLessThanOrEqual(3);
  });
});

describe('far-field identity gating survives the near-field fix', () => {
  // The v0.5.8 fix exempts blobs within one icon diameter of the prediction
  // from the classifier's veto. These two tests are what stop that from
  // becoming "follow whatever teal blob is nearest".
  const DECOY: Point = { x: START.x + STEP.x * 15 + 34, y: START.y + STEP.y * 15 - 21 };

  function decoyScenes() {
    const lockPhase = walk(16);
    const decoyPhase = Array.from({ length: 16 }, () => ({
      ...BACKDROP,
      self: null,
      allies: [...BACKDROP.allies!, DECOY],
    }));
    return renderScenes([...lockPhase, ...decoyPhase]);
  }

  test('a blob the classifier does not vouch for is not followed into the far field', async () => {
    const scenes = decoyScenes();
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    const vanishPoint = at(START, STEP, 15);
    const end = records[records.length - 1].px!;

    // The decoy sits ~40px away: outside the near field (one icon diameter),
    // inside the jump radius. Only the classifier gate keeps the dot off it.
    expect(distance(vanishPoint, DECOY)).toBeGreaterThan(ICON_DIAM);
    expect(distance(end, DECOY)).toBeGreaterThan(15);
    expect(distance(end, vanishPoint)).toBeLessThan(12);
  });

  test('...but a blob it does vouch for is re-acquired', async () => {
    const scenes = decoyScenes();
    // A classifier that recognises the champion at the decoy: a teleport, a
    // recall, or the icon reappearing after an overlap.
    let target: Point = at(START, STEP, 0);
    const h = newTracker(scenes.map(s => s.frame), {
      classifier: new OracleScorer(() => toFramePoint(target)),
    });

    const records: Awaited<ReturnType<typeof driveTracker>> = [];
    for (let i = 0; i < scenes.length; i++) {
      target = i < 16 ? at(START, STEP, i) : DECOY;
      records.push(...await driveTracker(h, [scenes[i]]));
    }

    expect(distance(records[records.length - 1].px!, DECOY)).toBeLessThanOrEqual(3);
  });
});

describe('losing the icon', () => {
  test('extrapolates, grows the hold past the freshness threshold, and stays bounded', async () => {
    const scenes = renderScenes([...walk(16), ...Array.from({ length: 24 }, () => NO_TEAL)]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });

    const records = await driveTracker(h, scenes);
    const last = records[records.length - 1];
    const vanishPoint = at(START, STEP, 15);

    // The orchestrator stops broadcasting a position once the hold passes 2s.
    expect(last.holdSec).toBeGreaterThan(2);
    expect(last.holdSec * 1000).toBeLessThan(FORCED_REACQUIRE_HOLD_MS);
    expect(last.state).toBe(TrackingState.LOCKED);

    // Velocity decays and is capped, so extrapolation drifts a little and then
    // stops — it must never fly off across the map (VEL_CAP_PX exists because
    // a real log showed a 12000-unit drift in 500ms).
    expect(distance(last.px!, vanishPoint)).toBeLessThan(12);
    expect(last.px!.x).toBeGreaterThanOrEqual(0);
    expect(last.px!.x).toBeLessThan(REGION.width);

    // ...and it has to have EXTRAPOLATED, not merely stayed inside the bound.
    // A tracker that freezes at the vanish point, or one whose velocity EMA
    // points backwards, satisfies every assertion above — so check that the
    // drift went the way the champion was walking, and got somewhere.
    const drift = { x: last.px!.x - vanishPoint.x, y: last.px!.y - vanishPoint.y };
    const stepMag = Math.hypot(STEP.x, STEP.y);
    const along = (drift.x * STEP.x + drift.y * STEP.y) / stepMag;
    const across = Math.abs(drift.x * -STEP.y + drift.y * STEP.x) / stepMag;
    expect(along).toBeGreaterThan(3);
    expect(across).toBeLessThan(2);
  });

  test('a hold past the forced-reacquire budget drops to SCANNING and re-locks when the icon returns', async () => {
    const holdFrames = Math.ceil(FORCED_REACQUIRE_HOLD_MS / FRAME_MS) + 4;
    const RETURN: Point = { x: 200, y: 90 };
    const scenes = renderScenes([
      ...walk(16),
      ...Array.from({ length: holdFrames }, () => NO_TEAL),
      ...walk(8, RETURN, { x: 1, y: 0 }),
    ]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });

    const records = await driveTracker(h, scenes);
    const m = metrics(records);
    const last = records[records.length - 1];

    expect(m.scanningReentries).toBe(1);
    expect(logs.some(l => l.includes('forcing re-acquisition'))).toBe(true);
    expect(last.state).toBe(TrackingState.LOCKED);
    expect(distance(last.px!, last.truth!)).toBeLessThanOrEqual(3);
  });

  test('a minion wave standing where the champion was does not inherit the lock', async () => {
    const vanishPoint = at(START, STEP, 15);
    const scenes = renderScenes([
      ...walk(16),
      ...Array.from({ length: 12 }, () => ({
        ...BACKDROP,
        self: null,
        minions: [...BACKDROP.minions!, vanishPoint],
      })),
    ]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });

    const records = await driveTracker(h, scenes);

    // Dense shapes never reach the scorer at all — filterIconBlobs drops them —
    // so the tracker holds instead of latching onto the wave.
    expect(records[records.length - 1].state).toBe(TrackingState.LOCKED);
    expect(distance(records[records.length - 1].px!, vanishPoint)).toBeLessThan(12);
  });
});

describe('death and respawn', () => {
  test('a dead champion costs no capture and keeps reporting the death position', async () => {
    const scenes = renderScenes(walk(16));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    await driveTracker(h, scenes);

    const deathPos = h.svc.getLastPosition()!;
    const capturesBeforeDeath = h.source.captureCount;
    const emitsBeforeDeath = h.emitted.length;

    h.svc.onDeath();
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(FRAME_MS);
      await h.svc.tick();
    }

    // The DEAD branch returns before the capture: a dead player's screen has
    // nothing to track, and the overlay still needs a position every tick.
    expect(h.source.captureCount).toBe(capturesBeforeDeath);
    expect(h.emitted.length).toBe(emitsBeforeDeath + 5);
    for (const pos of h.emitted.slice(emitsBeforeDeath)) {
      expect(pos).toEqual(deathPos);
    }
  });

  test('respawn re-scans and locks onto the icon at the fountain', async () => {
    const scenes = renderScenes(walk(16));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    await driveTracker(h, scenes);

    h.svc.onDeath();
    expect(h.svc.getState()).toBe(TrackingState.DEAD);
    h.svc.onRespawn();
    expect(h.svc.getState()).toBe(TrackingState.SCANNING);

    const FOUNTAIN: Point = { x: 30, y: 245 };
    const respawnScenes = renderScenes(walk(16, FOUNTAIN, { x: 1, y: -1 }, {
      ...BACKDROP,
      turrets: [],
    }));
    // The frame source is spent; a fresh tracker would lose the death history,
    // so re-point this one at the new script.
    h.source.reload(respawnScenes.map(s => s.frame));

    const records = await driveTracker(h, respawnScenes);
    const last = records[records.length - 1];
    expect(last.state).toBe(TrackingState.LOCKED);
    expect(distance(last.px!, last.truth!)).toBeLessThanOrEqual(3);
  });
});

describe('camera viewport (#36, voice on camera)', () => {
  test('the rectangle centre resolves to game coordinates, independently of the lock', async () => {
    const scenes = renderScenes(walk(12));
    const h = newTracker(scenes.map(s => s.frame), {
      classifier: new ZeroScorer(),
      cameraTracking: true,
    });

    const records = await driveTracker(h, scenes);

    const camera = h.svc.getCameraPosition();
    expect(camera).not.toBeNull();
    const cameraPx = gameToTruth(camera!);
    const rect = BACKDROP.camera!;
    expect(cameraPx.x).toBeCloseTo(rect.x + (rect.w - 1) / 2, 0);
    expect(cameraPx.y).toBeCloseTo(rect.y + (rect.h - 1) / 2, 0);

    // Where the player is looking and where their champion is are different
    // things, and must not have converged.
    const champion = records[records.length - 1].px!;
    expect(distance(cameraPx, champion)).toBeGreaterThan(50);
  });

  test('camera tracking off, or no rectangle on screen, reports nothing', async () => {
    const withRect = renderScenes(walk(12));
    const off = newTracker(withRect.map(s => s.frame), { classifier: new ZeroScorer() });
    await driveTracker(off, withRect);
    expect(off.svc.getCameraPosition()).toBeNull();

    const noRect = renderScenes(walk(12, START, STEP, { ...BACKDROP, camera: null }));
    const on = newTracker(noRect.map(s => s.frame), {
      classifier: new ZeroScorer(),
      cameraTracking: true,
    });
    await driveTracker(on, noRect);
    expect(on.svc.getCameraPosition()).toBeNull();
  });
});

describe('without a classifier at all', () => {
  test('the movement trail alone carries the lock', async () => {
    // The no-classifier weighting: the model failed to load, or is still
    // loading during the first seconds of the game.
    const scenes = renderScenes(walk(30));
    const classifier = new UnloadedScorer();
    const h = newTracker(scenes.map(s => s.frame), { classifier });

    const records = await driveTracker(h, scenes);
    const m = metrics(records);

    expect(classifier.runs).toBe(0);
    // Warmup is 500ms without a classifier: half the frames of the loaded case.
    expect(m.lockFrame).toBeGreaterThanOrEqual(3);
    expect(m.lockFrame).toBeLessThanOrEqual(8);
    expect(m.maxErrorPx).toBeLessThanOrEqual(3);
    expect(m.longestFrozenRun).toBeLessThanOrEqual(2);
  });
});

describe('a mid-session config poll', () => {
  test('re-reading MinimapScale drops the lock and re-acquires', async () => {
    const scenes = renderScenes(walk(40));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });

    await driveTracker(h, scenes.slice(0, 16));
    expect(h.svc.getState()).toBe(TrackingState.LOCKED);

    h.svc.setMinimapScaleFromConfig(1.0);
    expect(h.svc.getState()).toBe(TrackingState.SCANNING);

    const records = await driveTracker(h, scenes.slice(16));
    const last = records[records.length - 1];
    expect(last.state).toBe(TrackingState.LOCKED);
    expect(distance(last.px!, last.truth!)).toBeLessThanOrEqual(3);
  });
});

describe('a second teal icon inside the jump radius', () => {
  // Every other scenario in this file keeps the backdrop allies ~150px away, so
  // exactly one candidate is ever in jump range and Phase 1 never actually has
  // to choose. These two put a second icon inside the radius, which is what
  // makes the composite score — rather than iteration order — decide the lock.
  const STOP: Point = at(START, STEP, 15);
  /** Raster-first (smaller y), inside the 48px jump radius, outside the near field. */
  const NEIGHBOUR: Point = { x: STOP.x, y: STOP.y - 34 };

  function standStill(count: number, trail: Point | null): SceneSpec[] {
    return Array.from({ length: count }, () => ({
      ...BACKDROP,
      allies: [...BACKDROP.allies!, NEIGHBOUR],
      self: STOP,
      selfTrail: trail,
    }));
  }

  test('the movement trail keeps the lock on the champion, not on the ally beside it', async () => {
    const scenes = renderScenes([...walk(16), ...standStill(12, { x: -STEP.x, y: -STEP.y })]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new UnloadedScorer() });

    const records = await driveTracker(h, scenes);
    const last = records[records.length - 1];

    expect(distance(NEIGHBOUR, STOP)).toBeLessThan(48);
    expect(distance(NEIGHBOUR, STOP)).toBeGreaterThan(ICON_DIAM);
    expect(distance(last.px!, STOP)).toBeLessThanOrEqual(3);
    expect(distance(last.px!, NEIGHBOUR)).toBeGreaterThan(20);
  });

  test('with no trail and no classifier, position alone still picks the right one', async () => {
    // The champion has stopped and its movement trail has faded; the ally is
    // nearer the top of the frame, so it reaches Phase 1 first. Nothing but the
    // position term separates them.
    const scenes = renderScenes([...walk(16), ...standStill(12, null)]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new UnloadedScorer() });

    const records = await driveTracker(h, scenes);
    const last = records[records.length - 1];

    expect(last.state).toBe(TrackingState.LOCKED);
    expect(distance(last.px!, STOP)).toBeLessThanOrEqual(3);
    expect(distance(last.px!, NEIGHBOUR)).toBeGreaterThan(20);
  });

  test('...and still picks it when the classifier vouches for both', async () => {
    // Score normalization turns a weak model's 0.060/0.055 into 1.00/0.92, so
    // "the classifier vouches for every candidate" is the ordinary case, not a
    // contrived one. With identity saying nothing and no trail to break the
    // tie, the position term is carrying the lock by itself.
    const scenes = renderScenes([...walk(16), ...standStill(12, null)]);
    const classifier = new IndiscriminateScorer();
    const h = newTracker(scenes.map(s => s.frame), { classifier });

    const records = await driveTracker(h, scenes);
    const last = records[records.length - 1];

    expect(classifier.runs).toBeGreaterThan(0);
    expect(last.state).toBe(TrackingState.LOCKED);
    expect(distance(last.px!, STOP)).toBeLessThanOrEqual(3);
    expect(distance(last.px!, NEIGHBOUR)).toBeGreaterThan(20);
  });
});

describe('how far the lock may travel in one frame', () => {
  const VANISH: Point = at(START, STEP, 15);

  test('a hold widens the jump radius enough to catch up with a moved icon', async () => {
    // The icon is hidden (a ping, an overlapping icon, fog) and reappears where
    // the champion walked to in the meantime — 75px away, far outside the 48px
    // base radius. computeMaxJumpPx's hold expansion is the only thing that
    // reaches it without a classifier.
    const RETURN: Point = { x: 150, y: 140 };
    const scenes = renderScenes([...walk(16), ...vanished(16), ...Array.from({ length: 8 }, () => ({
      ...BACKDROP,
      self: RETURN,
      selfTrail: { x: -STEP.x, y: -STEP.y },
    }))]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new UnloadedScorer() });

    const records = await driveTracker(h, scenes);
    const last = records[records.length - 1];

    expect(distance(VANISH, RETURN)).toBeGreaterThan(48);
    expect(distance(VANISH, RETURN)).toBeLessThan(96);
    expect(last.state).toBe(TrackingState.LOCKED);
    expect(distance(last.px!, RETURN)).toBeLessThanOrEqual(3);
  });

  test('...but never far enough to reach an ally across the map', async () => {
    // Same hold, no classifier to veto anything, and the backdrop ally at
    // (40,45) sitting ~149px away. The radius must not have grown that far in
    // the 3s this hold lasts.
    const HOLD_FRAMES = 24;
    const scenes = renderScenes([...walk(16), ...vanished(HOLD_FRAMES)]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new UnloadedScorer() });

    const records = await driveTracker(h, scenes);
    const last = records[records.length - 1];

    // 48px base + one icon diameter per held second, held for 3s.
    const widest = 48 + ICON_DIAM * (HOLD_FRAMES * FRAME_MS) / 1000;
    for (const ally of BACKDROP.allies!) {
      expect(distance(VANISH, ally)).toBeGreaterThan(widest);
      expect(distance(last.px!, ally)).toBeGreaterThan(50);
    }
    expect(distance(last.px!, VANISH)).toBeLessThan(12);
  });

  test('a one-frame jump across the widened radius does not fling the extrapolation off the map', async () => {
    // VEL_CAP_PX's reason for existing: after a long hold the radius is wide
    // enough for Phase 1 to accept a blob 110px away, the velocity EMA takes
    // half of that as the frame's speed, and if the icon vanishes again on the
    // next frame every remaining tick extrapolates at a speed no champion can
    // produce. A real user log drifted 12000 game units in 500ms that way.
    const JUMP: Point = { x: 190, y: 140 };
    const HOLD_FRAMES = 24;
    const JUMP_FRAME = 16 + HOLD_FRAMES;
    const scenes = renderScenes([
      ...walk(16),
      ...vanished(HOLD_FRAMES),
      { ...BACKDROP, self: JUMP },
      ...vanished(10),
    ]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new UnloadedScorer() });

    const records = await driveTracker(h, scenes);

    // The jump is inside the hold-widened radius and outside the base one, so
    // Phase 1 takes it in a single frame — which is what loads the EMA.
    expect(distance(VANISH, JUMP)).toBeGreaterThan(96);
    expect(distance(VANISH, JUMP)).toBeLessThan(48 + ICON_DIAM * (HOLD_FRAMES * FRAME_MS) / 1000);
    expect(distance(records[JUMP_FRAME].px!, JUMP)).toBeLessThanOrEqual(3);

    // Capped, the ten extrapolated frames that follow add up to ~32px and stop.
    // Uncapped they cover three times that and only the region clamp stops them.
    const last = records[records.length - 1];
    expect(distance(last.px!, JUMP)).toBeLessThan(45);
    expect(last.px!.x).toBeLessThan(REGION.width);
    expect(last.px!.y).toBeGreaterThanOrEqual(0);
  });
});

describe('a single-frame classifier misfire', () => {
  test('one confident frame on a distant ally does not steal a stationary lock', async () => {
    // The v0.3.0 "snap up to raw" EMA turned one wrong frame into a permanent
    // 1.0, and the tracker teleported onto structures and minion waves. With
    // the symmetric EMA the spike damps to 0.4, well under the 0.85 bar
    // computeReacquireThreshold sets once the champion has been stationary.
    const VANISH: Point = at(START, STEP, 15);
    const FAR_ALLY: Point = BACKDROP.allies![1];
    // The tenth inference run lands ~4.5s in: past the 3s of standing still
    // that raises the Phase-2 bar to 0.85, and before the 5s hold budget that
    // would have dropped the tracker to SCANNING and made the spike moot.
    const scenes = renderScenes([...walk(16), ...vanished(34)]);
    const classifier = new SpikingScorer(9, () => toFramePoint(FAR_ALLY));
    const h = newTracker(scenes.map(s => s.frame), { classifier });

    const records = await driveTracker(h, scenes);
    const last = records[records.length - 1];

    expect(classifier.runs).toBeGreaterThan(9);
    expect(distance(VANISH, FAR_ALLY)).toBeGreaterThan(144);
    expect(logs.some(l => l.includes('Re-acquired via classifier'))).toBe(false);
    expect(distance(last.px!, FAR_ALLY)).toBeGreaterThan(50);
    expect(distance(last.px!, VANISH)).toBeLessThan(12);
  });
});
