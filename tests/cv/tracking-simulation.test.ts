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
import {
  CAMERA_DWELL_MIN_READABLE_MS,
  CAMERA_SWITCH_COOLDOWN_MS,
  FORCED_REACQUIRE_HOLD_MS,
  MAX_OCCLUDED_MS,
  OCCLUDER_GRACE_MS,
} from '../../src/services/tracking-helpers';
import { driveTracker, FRAME_MS, metrics, newTracker } from './harness/drive';
import {
  IndiscriminateScorer,
  OracleScorer,
  SkinVerdictScorer,
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
/** Frames with nothing readable at all — the capture itself failing. */
const BLANK: SceneSpec = {};

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

describe('why the tracker says it lost us', () => {
  // The orchestrator disowns our coordinates faster for one of these than the
  // other (see disownAfterSec), so the tracker has to tell them apart. It is
  // the difference between "the minimap capture failed" and "we are not where
  // we said we were".
  test('reports no-blobs when nothing on the minimap is readable at all', async () => {
    const scenes = renderScenes([...walk(16), ...Array.from({ length: 12 }, () => BLANK)]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    const held = records.filter(r => r.holdSec > 0);
    expect(held.length).toBeGreaterThan(0);
    expect(held.every(r => r.holdReason === 'no-blobs')).toBe(true);
  });

  test('reports no-match when the minimap is readable but shows no own-team icon (a 1v1 recall)', async () => {
    // Until v0.5.10 this was no-blobs, on the premise that a real game always
    // draws four allies — so in a 1v1 every recall took 5s to go quiet.
    const scenes = renderScenes([...walk(16), ...Array.from({ length: 12 }, () => NO_TEAL)]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    const held = records.filter(r => r.holdSec > 0);
    expect(held.length).toBeGreaterThan(0);
    expect(held.every(r => r.holdReason === 'no-match')).toBe(true);
  });

  test('keeps the longer wait when an enemy icon sits where we vanished (a missed cover, 1v1)', async () => {
    // Review: an enemy icon landing on ours in one frame never shows the
    // shrinking that starts an occlusion episode. Treated as no-match it cut
    // audio at 2s where it used to be 5s.
    const VANISH: Point = at(START, STEP, 15);
    const ONE_V_ONE: SceneSpec = { camera: BACKDROP.camera, enemies: [{ x: 250, y: 160 }] };
    const scenes = renderScenes([
      ...walk(16, START, STEP, ONE_V_ONE),
      ...Array.from({ length: 12 }, () => ({ ...ONE_V_ONE, self: null, enemiesOnTop: [VANISH] })),
    ]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    const held = records.filter(r => r.holdSec > 0);
    expect(held.length).toBeGreaterThan(0);
    expect(held.every(r => r.holdReason === 'no-blobs')).toBe(true);
  });

  test('reports no-match when icons are there and none of them is us', async () => {
    const scenes = renderScenes([...walk(16), ...vanished(12)]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    const held = records.filter(r => r.holdSec > 0);
    expect(held.length).toBeGreaterThan(0);
    expect(held.some(r => r.holdReason === 'no-match')).toBe(true);
  });

  test('a hold that starts blind stays no-match once icons come back without us', async () => {
    // The stronger signal wins for the rest of the hold: whatever the first
    // frame looked like, icons returning and still not matching means we moved.
    const scenes = renderScenes([...walk(16), BLANK, BLANK, ...vanished(10)]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    expect(records[17].holdReason).toBe('no-blobs');
    expect(records[records.length - 1].holdReason).toBe('no-match');
  });

  test('clears the reason once tracking resumes', async () => {
    const scenes = renderScenes([...walk(16), ...Array.from({ length: 4 }, () => NO_TEAL), ...walk(6, at(START, STEP, 16))]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    expect(records[records.length - 1].holdSec).toBe(0);
    expect(records[records.length - 1].holdReason).toBeNull();
  });
});

describe('dying', () => {
  // Deaths are detected from a 3s poll, so by the time onDeath arrives the
  // icon may have been gone a while, the tracker holding and extrapolating.
  test('puts the body where the tracker last saw us and clears the hold', async () => {
    const VANISH: Point = at(START, STEP, 15);
    const scenes = renderScenes([...walk(16), ...vanished(20)]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);
    expect(records[records.length - 1].holdSec).toBeGreaterThan(2);

    h.svc.onDeath();
    expect(h.svc.getHoldDurationSec()).toBe(0);
    expect(h.svc.getHoldReason()).toBeNull();
    expect(distance(gameToTruth(h.svc.getLastPosition()!), VANISH)).toBeLessThanOrEqual(3);
    jest.advanceTimersByTime(20_000);
    expect(h.svc.getHoldDurationSec()).toBe(0);

    h.svc.onRespawn();
    expect(h.svc.getState()).toBe(TrackingState.SCANNING);
  });

  test('has no body to keep if it had already lost us and was rescanning', async () => {
    // Review: a tracker in SCANNING gave up on its last position, possibly long
    // ago and in another lane — taking that as the body would make it live.
    const scenes = renderScenes([...walk(16), ...vanished(48)]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);
    expect(records[records.length - 1].state).toBe(TrackingState.SCANNING);

    h.svc.onDeath();
    expect(h.svc.getLastPosition()).toBeNull();
  });

  test('keeps following the camera while dead, for voice on camera', async () => {
    // Review: the tracker stopped capturing at death, so the camera the
    // player listens from froze where they died for the whole timer.
    const CAM_A = { x: 140, y: 30, w: 110, h: 80 };
    const CAM_B = { x: 20, y: 160, w: 110, h: 80 };
    const alive = walk(16, START, STEP, { ...BACKDROP, camera: CAM_A });
    const dead = Array.from({ length: 16 }, () => ({ ...BACKDROP, self: null, camera: CAM_B }));
    const scenes = renderScenes([...alive, ...dead]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    h.svc.setCameraTracking(true);
    await driveTracker(h, scenes.slice(0, 16));
    const before = h.svc.getCameraPosition();
    expect(before).not.toBeNull();

    h.svc.onDeath();
    await driveTracker(h, scenes.slice(16));
    const after = h.svc.getCameraPosition();
    expect(h.svc.getState()).toBe(TrackingState.DEAD);
    expect(after).not.toBeNull();
    const centreB = truthToGame({ x: CAM_B.x + CAM_B.w / 2, y: CAM_B.y + CAM_B.h / 2 });
    expect(Math.hypot(after!.x - centreB.x, after!.y - centreB.y)).toBeLessThan(400);
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

describe('a recall', () => {
  // A recall is an instant teleport across the map, and the tracker cannot
  // follow one: the destination is far outside the per-frame jump radius, and
  // Phase 2 re-acquisition wants high classifier confidence — which tightens
  // further precisely BECAUSE the champion stood still to channel it.
  //
  // So the reported position keeps pointing at the lane for a while after the
  // champion is already in base, and an enemy standing where they were goes on
  // hearing them. This pins how long that window is, because it is a number
  // worth noticing if it grows.
  const LANE: Point = { x: 190, y: 110 };
  const BASE: Point = { x: 30, y: 245 };

  const stand = (at: Point, trailFrom: number, n: number): SceneSpec[] =>
    Array.from({ length: n }, () => ({
      self: at,
      selfTrail: { x: at.x + trailFrom, y: at.y },
      allies: [{ x: 60, y: 60 }],
    }));

  test('the reported position lags in lane for several seconds after the teleport', async () => {
    const specs = [...stand(LANE, -6, 32), ...stand(BASE, 6, 72)];
    const scenes = renderScenes(specs);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const recs = await driveTracker(h, scenes);

    const post = recs.slice(32);
    const near = (p: { x: number; y: number } | null, t: Point) =>
      !!p && Math.hypot(p.x - t.x, p.y - t.y) < 20;

    const stillLane = post.filter(r => near(r.px, LANE)).length;
    const firstAtBase = post.findIndex(r => near(r.px, BASE));

    // It does recover — this is a lag, not the v0.5.8 permanent freeze.
    expect(firstAtBase).toBeGreaterThanOrEqual(0);
    // ...but not quickly. Measured at 48 frames (6.0s at the 8 FPS the harness
    // runs); the client additionally stops sending coords partway through, and
    // the server then holds the last one for STALE_POSITION_MS on top.
    expect(stillLane).toBeGreaterThan(24);
    expect(firstAtBase).toBeLessThanOrEqual(56);
  });

  test('coords stop being sent well before the position is right again', async () => {
    // positionTickInner suppresses coords once the hold passes 2s, so the
    // phantom window is bounded by that plus the server's staleness horizon
    // rather than by the tracker recovering.
    const specs = [...stand(LANE, -6, 32), ...stand(BASE, 6, 72)];
    const scenes = renderScenes(specs);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const recs = await driveTracker(h, scenes);

    const post = recs.slice(32);
    const suppressedAt = post.findIndex(r => r.holdSec > 2);
    const firstAtBase = post.findIndex(
      r => !!r.px && Math.hypot(r.px.x - BASE.x, r.px.y - BASE.y) < 20,
    );
    expect(suppressedAt).toBeGreaterThanOrEqual(0);
    expect(suppressedAt).toBeLessThan(firstAtBase);
  });
});

describe('an enemy icon drawn over ours', () => {
  // Two champions in melee range overlap on the minimap, and whichever icon is
  // drawn on top hides the other's border. Real logs (v0.5.9, a 1v1 in the
  // practice tool) showed both players' trackers losing their own icon this
  // way several times a game, always mid-fight, and the orchestrator
  // disowning the position two seconds in — so the two people fighting each
  // other dropped out of each other's audio for 5-9 seconds at a time.
  //
  // Two earlier versions of the fix failed adversarial review, and several
  // tests below are the scenarios that sank them: they took an enemy near the
  // spot we vanished from as cover, followed that enemy, and so re-owned
  // recalled positions for up to twelve seconds.
  const E: Point = { x: 150, y: 140 };
  const BACK = BACKDROP;

  /** We walk into an enemy icon drawn over ours at `speed` px/frame, then stay under it. */
  function slideUnder(speed: number, after: number, over: SceneSpec = BACK, dir: Point = { x: 1, y: 0 }): SceneSpec[] {
    const specs: SceneSpec[] = [];
    for (let d = 60; d > 0; d -= speed) {
      specs.push({ ...over, self: { x: E.x - dir.x * d, y: E.y - dir.y * d }, selfTrail: { x: -dir.x, y: -dir.y }, enemiesOnTop: [E] });
    }
    for (let i = 0; i < after; i++) specs.push({ ...over, self: E, enemiesOnTop: [E] });
    return specs;
  }
  const coveredFrames = <T,>(records: T[], n: number): T[] => records.slice(-n);
  const covering = (l: string) => l.includes('Own icon covered by an enemy icon');

  test.each([0.5, 1, 2])('holds under the enemy, never disowning, when we walk under it at %p px/frame', async (speed) => {
    // 7.5s under: past both the 2s disown and the 5s forced re-acquisition.
    const scenes = renderScenes(slideUnder(speed, 60));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    expect(logs.some(covering)).toBe(true);
    const tail = coveredFrames(records, 50);
    expect(tail.every(r => r.holdSec === 0 && r.state === TrackingState.LOCKED)).toBe(true);
    expect(tail.every(r => distance(r.px!, E) < 3)).toBe(true);
    expect(logs.filter(l => l.includes('forcing re-acquisition'))).toHaveLength(0);
  });

  test('works in a 1v1, with no teal blob anywhere on the map', async () => {
    const ONE_V_ONE: SceneSpec = { camera: BACK.camera };
    const scenes = renderScenes(slideUnder(1, 40, ONE_V_ONE));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    expect(coveredFrames(records, 30).every(r => r.holdSec === 0 && r.holdReason === null)).toBe(true);
  });

  test('does not go looking for us across the map while we are covered', async () => {
    // A classifier certain about an ally far away. Without the occlusion
    // check Phase 2 takes it; the real logs showed exactly this, cls=1.00 on a
    // blob thousands of units away, in the middle of a fight.
    const FAR_ALLY: Point = BACK.allies![1];
    const specs = slideUnder(1, 40);
    const scenes = renderScenes(specs);
    let target: Point | null = null;
    const h = newTracker(scenes.map(s => s.frame), { classifier: new OracleScorer(() => target && toFramePoint(target)) });
    const records: Awaited<ReturnType<typeof driveTracker>> = [];
    for (let i = 0; i < scenes.length; i++) {
      target = specs[i].self && distance(specs[i].self!, E) > ICON_DIAM ? specs[i].self! : FAR_ALLY;
      records.push(...await driveTracker(h, [scenes[i]]));
    }

    expect(logs.some(l => l.includes('Re-acquired via classifier'))).toBe(false);
    expect(distance(records[records.length - 1].px!, E) < 3).toBe(true);
  });

  test('picks our icon back up when it walks out from under', async () => {
    const out = Array.from({ length: 16 }, (_, i) => ({
      ...BACK, self: { x: E.x + 2 + i * 2, y: E.y }, selfTrail: { x: -1, y: 0 }, enemiesOnTop: [E],
    }));
    const scenes = renderScenes([...slideUnder(1, 16), ...out]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    const last = records[records.length - 1];
    expect(distance(last.px!, last.truth!)).toBeLessThanOrEqual(3);
    expect(logs.some(l => l.includes('Own icon uncovered after'))).toBe(true);
  });

  test('survives the covering icon dropping out of detection for a few frames', async () => {
    // A second enemy brushing the first merges the two red rings into one blob
    // the icon filter rejects. Nothing has changed underneath.
    const blink = Array.from({ length: 3 }, () => ({ ...BACK, self: null, enemies: BACK.enemies }));
    const scenes = renderScenes([...slideUnder(1, 12), ...blink, ...Array.from({ length: 24 }, () => ({ ...BACK, self: null, enemiesOnTop: [E] }))]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    expect(coveredFrames(records, 30).every(r => r.holdSec === 0)).toBe(true);
    expect(logs.some(l => l.includes('Stopped treating own icon as covered'))).toBe(false);
  });

  test('a recall beside an enemy is still disowned', async () => {
    // Stood still for the 8s channel, then gone in one frame — with an enemy
    // icon near enough to overlap where we were. A full-size icon vanishing
    // at once is a teleport, not a cover.
    const NEAR: Point = { x: E.x + ICON_DIAM * 0.6, y: E.y };
    const stand = Array.from({ length: 64 }, () => ({ ...BACK, self: E, enemies: [...BACK.enemies!, NEAR] }));
    const gone = Array.from({ length: 24 }, () => ({ ...BACK, self: null, enemies: [...BACK.enemies!, NEAR] }));
    const scenes = renderScenes([...walk(16, { x: 120, y: 140 }, { x: 2, y: 0 }), ...stand, ...gone]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    expect(logs.some(covering)).toBe(false);
    expect(records[records.length - 1].holdSec).toBeGreaterThan(2);
  });

  test('an enemy passing over a standing recaller is not mistaken for cover when the recall lands', async () => {
    // Review round two: an enemy drawn on top crosses our icon mid-channel,
    // then stands close by (0.8 icon) as the recall completes. Its crossing
    // shrank our visible icon for a moment; what matters is that the frame
    // before we vanished showed it whole.
    const pass = Array.from({ length: 16 }, (_, i) => ({
      ...BACK, self: E, enemiesOnTop: [{ x: E.x - 30 + i * 4, y: E.y + ICON_DIAM * 0.5 }],
    }));
    const STAND: Point = { x: E.x + ICON_DIAM * 0.8, y: E.y };
    const settle = Array.from({ length: 24 }, () => ({ ...BACK, self: E, enemiesOnTop: [STAND] }));
    const gone = Array.from({ length: 24 }, () => ({ ...BACK, self: null, enemiesOnTop: [STAND] }));
    const scenes = renderScenes([...walk(16, { x: 120, y: 140 }, { x: 2, y: 0 }), ...pass, ...settle, ...gone]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    expect(logs.some(covering)).toBe(false);
    expect(records[records.length - 1].holdSec).toBeGreaterThan(2);
  });

  test('if we do vanish from under an enemy, we stay where it was, not wherever it goes', async () => {
    // Review round two: once covered, a recall or teleport from underneath is
    // indistinguishable from staying put. What bounds it is that the reported
    // position stays at the anchor, and the episode ends half a second after
    // no enemy icon is left there — so the hold and the 2s disown follow.
    const leave = Array.from({ length: 40 }, (_, i) => ({ ...BACK, self: null, enemiesOnTop: [{ x: E.x + i * 2, y: E.y }] }));
    const scenes = renderScenes([...slideUnder(1, 8), ...leave]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    const after = records.slice(-40);
    expect(after.every(r => distance(r.px!, E) < 3)).toBe(true);
    expect(logs.some(l => l.includes('no enemy icon left on the spot'))).toBe(true);
    // Enemy is a full icon off the anchor ~12 frames in; +0.5s grace; then a
    // hold that has to pass 2s. 40 frames is 5s.
    expect(records[records.length - 1].holdSec).toBeGreaterThan(2);
  });

  test('an enemy walking onto the spot partway through a hold does not end it', async () => {
    // We vanished with nobody near (a recall, a teleport) and the hold is
    // already running — perhaps already disowned.
    const VANISH: Point = at(START, STEP, 15);
    const late = Array.from({ length: 24 }, () => ({ ...BACK, self: null, enemiesOnTop: [VANISH] }));
    const scenes = renderScenes([...walk(16), ...vanished(8), ...late]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    expect(logs.some(covering)).toBe(false);
    expect(records[records.length - 1].holdSec).toBeGreaterThan(3.5);
  });

  test('once the episode ends without ours reappearing, it cannot restart', async () => {
    const away = Array.from({ length: 16 }, () => ({ ...BACK, self: null, enemies: BACK.enemies }));
    const back = Array.from({ length: 16 }, () => ({ ...BACK, self: null, enemiesOnTop: [E] }));
    const scenes = renderScenes([...slideUnder(1, 8), ...away, ...back]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    expect(logs.filter(covering)).toHaveLength(1);
    expect(records[records.length - 1].holdSec).toBeGreaterThan(2.5);
  });

  test.each([[{ x: 1, y: 0 }], [{ x: 0, y: 1 }]])(
    'reports the true distance while the icons only partly overlap (approach %j)', async (dir) => {
    // The uncovered part of our ring has its centroid pushed away from the
    // enemy, on both clients; uncorrected this scene reads up to 6px (~330
    // game units) long per side. tests/cv/real-art.test.ts checks the same on
    // the real minimap. Not asserted for diagonal approaches: see the limit
    // noted on coverCorrectedCentre.
    const specs = slideUnder(1, 0, BACK, dir);
    const scenes = renderScenes(specs);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);
    // From 8px in, ours is all but gone and the occlusion anchor takes over.
    const partly = records.filter(r => r.truth && r.holdSec === 0 &&
      distance(r.truth, E) > 8 && distance(r.truth, E) < ICON_DIAM * 0.9);
    expect(partly.length).toBeGreaterThan(5);
    // Uncorrected this reaches 6px; the first frame or two in, before our
    // box has visibly narrowed, read up to 3.
    for (const r of partly) {
      expect(Math.abs(distance(r.px!, E) - distance(r.truth!, E))).toBeLessThanOrEqual(3);
    }
    expect(partly.filter(r => Math.abs(distance(r.px!, E) - distance(r.truth!, E)) > 1).length).toBeLessThanOrEqual(2);
  });

  test('does not correct towards an enemy icon when another sits on the other side', async () => {
    // Review round five: a second enemy drawn UNDER ours on the uncovered side
    // made the correction push the wrong way, doubling the error.
    const UNDER: Point = { x: E.x - 30, y: E.y };
    const specs = slideUnder(1, 0).map(sp => ({ ...sp, enemies: [...BACK.enemies!, UNDER] }));
    const scenes = renderScenes(specs);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);
    const partly = records.filter(r => r.truth && r.holdSec === 0 &&
      distance(r.truth, E) > 4 && distance(r.truth, E) < ICON_DIAM * 0.9);
    // Where the correction would apply (10-19px in): never worse than the raw
    // centroid, which peaks at 5.6px here; without the guard it reached 7.8.
    const mid = partly.filter(r => distance(r.truth!, E) > 10 && distance(r.truth!, E) < 19);
    expect(mid.length).toBeGreaterThan(5);
    for (const r of mid) expect(distance(r.px!, r.truth!)).toBeLessThanOrEqual(5.7);
  });

  test('holds through a 2v1, where a second enemy icon merges with the covering one', async () => {
    // Review round three: two touching red rings become one blob too big for
    // the icon filter, and the fix used to see no occluder at all.
    const B: Point = { x: E.x + ICON_DIAM * 0.8, y: E.y + 4 };
    const specs = slideUnder(1, 40).map(sp => ({ ...sp, enemiesOnTop: [E, B] }));
    const scenes = renderScenes(specs);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    expect(logs.some(covering)).toBe(true);
    expect(coveredFrames(records, 30).every(r => r.holdSec === 0)).toBe(true);
  });

  test('an ally icon overlapping ours does not skew what a covered icon looks like', async () => {
    // Review round three: an ally walking stacked with us merged into our
    // blob and inflated the learnt icon size, after which an enemy merely
    // nearby looked like it was covering us — and a recall engaged.
    const NEAR: Point = { x: E.x + ICON_DIAM * 0.83, y: E.y };
    const withAlly = Array.from({ length: 40 }, () => ({ ...BACK, self: E, allies: [...BACK.allies!, { x: E.x + 3, y: E.y + 3 }] }));
    const stand = Array.from({ length: 24 }, () => ({ ...BACK, self: E, enemies: [...BACK.enemies!, NEAR] }));
    const gone = Array.from({ length: 24 }, () => ({ ...BACK, self: null, enemies: [...BACK.enemies!, NEAR] }));
    const scenes = renderScenes([...walk(16, { x: 120, y: 140 }, { x: 2, y: 0 }), ...withAlly, ...stand, ...gone]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    expect(logs.some(covering)).toBe(false);
    expect(records[records.length - 1].holdSec).toBeGreaterThan(2);
  });

  test('an icon clipped at the minimap edge does not teach it a too-small icon', async () => {
    // Review round four: learnt from a clipped icon (fountain is in a corner),
    // the baseline stuck low and no later cover ever looked shrunk enough.
    // No allies, so the clipped icon is the only thing to lock on to.
    const SOLO: SceneSpec = { enemies: BACK.enemies, camera: BACK.camera };
    const walkOut = Array.from({ length: 36 }, (_, i) => ({ ...SOLO, self: { x: 80 - i * 2, y: 140 }, selfTrail: { x: 1, y: 0 } }));
    const EDGE = Array.from({ length: 80 }, () => ({ ...SOLO, self: { x: 8, y: 140 } }));
    const walkIn = Array.from({ length: 30 }, (_, i) => ({ ...SOLO, self: { x: 8 + i * 2.5, y: 140 }, selfTrail: { x: -1, y: 0 } }));
    const scenes = renderScenes([...walkOut, ...EDGE, ...walkIn, ...slideUnder(1, 30, SOLO)]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    expect(records[36 + 79].state).toBe(TrackingState.LOCKED);
    expect(distance(records[36 + 79].px!, { x: 8, y: 140 })).toBeLessThan(6);
    expect(logs.some(covering)).toBe(true);
    expect(coveredFrames(records, 20).every(r => r.holdSec === 0)).toBe(true);
  });

  test('two enemy icons diagonally away from us do not keep an episode alive', async () => {
    // Review round four: a merged pair's bounding box has an empty corner
    // reaching ~2 icons out, which kept an episode running to the cap.
    // Centres 1.66 and 1.75 icons off, touching each other; the merged
    // blob's bounding-box corner is under half an icon from the anchor.
    const PAIR: Point[] = [
      { x: E.x + ICON_DIAM * 0.9, y: E.y + ICON_DIAM * 1.4 },
      { x: E.x + ICON_DIAM * 1.6, y: E.y + ICON_DIAM * 0.7 },
    ];
    const leave = Array.from({ length: 40 }, () => ({ ...BACK, self: null, enemiesOnTop: PAIR }));
    const scenes = renderScenes([...slideUnder(1, 8), ...leave]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    expect(logs.some(l => l.includes('no enemy icon left on the spot'))).toBe(true);
    expect(records[records.length - 1].holdSec).toBeGreaterThan(2);
  });

  test('dying while covered holds the body where we died, like any other death', async () => {
    // Before v0.5.10 no death was ever detected, and this handed the episode
    // back to an ordinary hold to match what an undetected death did. With
    // death detected, the policy is one rule: stay where you died until you
    // respawn, heard and hearing from there — no hold, so nothing disowns it.
    const scenes = renderScenes(slideUnder(1, 8));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);
    expect(logs.some(covering)).toBe(true);
    const where = records[records.length - 1].px!;

    h.svc.onDeath();
    jest.advanceTimersByTime(10_000);
    expect(h.svc.getState()).toBe(TrackingState.DEAD);
    expect(h.svc.getHoldDurationSec()).toBe(0);
    expect(distance(gameToTruth(h.svc.getLastPosition()!), where)).toBeLessThan(1);
  });

  test('gives up after MAX_OCCLUDED_MS and falls back to an ordinary hold', async () => {
    const scenes = renderScenes(slideUnder(1, 100));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    expect(logs.some(l => l.includes('s cap'))).toBe(true);
    expect(records[records.length - 1].holdSec).toBeGreaterThan(0);
    expect(MAX_OCCLUDED_MS).toBe(10_000);
  });
});

describe('a lock that ends up on a static teal marker (v0.5.10 Briar log)', () => {
  // The champion's icon goes for a moment right beside something teal that
  // stays put — a ward, in the log (there an enemy icon covered ours; here it
  // simply vanishes). Phase 1 follows the nearest blob on continuity, which is
  // the marker, and nothing moved it back: it stays visible, so there is no
  // hold. The other player then heard nothing for minutes, scored against the
  // ward, while the classifier — on the runs where it said anything — rated
  // the real icon 1.00 and the ward 0.00.
  const WARD: Point = at(START, STEP, 40);
  const OVER: SceneSpec = { ...BACKDROP, allies: [...BACKDROP.allies!, WARD] };
  const AWAY: Point = { x: 215, y: 215 };
  const AWAY_STEP: Point = { x: 0, y: -1 };

  function specs(afterFrames: number, after?: SceneSpec[]): SceneSpec[] {
    return [
      ...walk(29, START, STEP, OVER),
      ...vanished(8, OVER),
      ...(after ?? walk(afterFrames, AWAY, AWAY_STEP, OVER)),
    ];
  }

  async function drive(classifier: 'oracle' | 'zero' | 'both', afterFrames = 64, resetAt = -1, after?: SceneSpec[]) {
    const s = specs(afterFrames, after);
    const scenes = renderScenes(s);
    let target: Point | null = null;
    const scorer = classifier === 'oracle'
      ? new OracleScorer(() => target && toFramePoint(target))
      : classifier === 'zero' ? new ZeroScorer() : new IndiscriminateScorer();
    const h = newTracker(scenes.map(sc => sc.frame), { classifier: scorer });
    const records: Awaited<ReturnType<typeof driveTracker>> = [];
    for (let i = 0; i < scenes.length; i++) {
      target = s[i].self ?? null;
      if (i === resetAt) h.svc.resetPosition();
      records.push(...await driveTracker(h, [scenes[i]]));
    }
    return { records, scenes: s, awayFrom: s.length - afterFrames };
  }

  test('the scene really strands the lock on the marker', async () => {
    // Without anything to say otherwise, the lock stays on the ward while the
    // champion walks off — the failure, reproduced.
    const { records } = await drive('zero');
    const last = records[records.length - 1];
    expect(last.state).toBe(TrackingState.LOCKED);
    expect(distance(last.px!, WARD)).toBeLessThanOrEqual(3);
    expect(distance(last.truth!, WARD)).toBeGreaterThan(70);
  });

  test('a classifier that keeps saying "not us" moves the lock to the real icon', async () => {
    const { records, awayFrom } = await drive('oracle');
    // Stranded first: the marker held the lock when the champion reappeared.
    expect(distance(records[awayFrom + 2].px!, WARD)).toBeLessThanOrEqual(3);
    const moved = records.findIndex((r, i) => i > awayFrom && distance(r.px!, r.truth!) <= 3);
    expect(moved).toBeGreaterThan(awayFrom);
    // Not on the first contrary run: it takes the evidence window (4s, 32 frames).
    expect((moved - awayFrom) * FRAME_MS).toBeGreaterThanOrEqual(4000);
    expect((moved - awayFrom) * FRAME_MS).toBeLessThanOrEqual(6500);
    for (const r of records.slice(moved)) expect(distance(r.px!, r.truth!)).toBeLessThanOrEqual(3);
    expect(logs.some(l => l.includes('is not us'))).toBe(true);
  });

  test('a classifier that cannot tell icons apart never moves it', async () => {
    const { records } = await drive('both');
    expect(distance(records[records.length - 1].px!, WARD)).toBeLessThanOrEqual(3);
    expect(logs.some(l => l.includes('is not us'))).toBe(false);
  });

  test('"Wrong position?" finds the champion when the classifier is no help', async () => {
    // A model that recognises nothing cannot catch this; the user can. The
    // only other teal icon nearby is below the champion, so nothing but the
    // reset's avoidance stops the scan re-picking the ward, which comes first
    // in raster order. Standing still, the champion carries nothing that
    // identifies it either, so the scan waits for it to walk.
    const STAND: Point = { x: 185, y: 175 };
    const SPARSE: SceneSpec = { ...BACKDROP, allies: [WARD, BACKDROP.allies![1]] };
    const after = [
      ...Array.from({ length: 32 }, () => ({ ...SPARSE, self: STAND, selfTrail: null })),
      ...walk(24, STAND, { x: 0, y: -1 }, SPARSE),
    ];
    const stuck = await drive('zero', after.length, -1, after);
    expect(distance(stuck.records[stuck.awayFrom + 30].px!, WARD)).toBeLessThanOrEqual(3);

    logs.length = 0;
    const resetAt = stuck.awayFrom + 8;
    const { records } = await drive('zero', after.length, resetAt, after);
    expect(logs.some(l => l.includes('Position reset by the user'))).toBe(true);
    const walkFrom = stuck.awayFrom + 32;
    // Standing still: no lock at all, rather than an arbitrary one.
    for (const r of records.slice(resetAt, walkFrom)) expect(r.state).toBe(TrackingState.SCANNING);
    const relocked = records.findIndex((r, i) => i >= walkFrom && r.state === TrackingState.LOCKED);
    expect(relocked).toBeGreaterThanOrEqual(walkFrom);
    for (const r of records.slice(relocked)) {
      expect(r.state).toBe(TrackingState.LOCKED);
      expect(distance(r.px!, r.truth!)).toBeLessThanOrEqual(3);
    }
  });

  test('a ward vanishing for one frame during the watch neither locks early nor counts as movement', async () => {
    const STAND: Point = { x: 185, y: 175 };
    const SPARSE: SceneSpec = { ...BACKDROP, allies: [WARD, BACKDROP.allies![1]] };
    const NO_WARD: SceneSpec = { ...BACKDROP, allies: [BACKDROP.allies![1]] };
    const after = Array.from({ length: 40 }, (_, i) =>
      ({ ...(i === 18 ? NO_WARD : SPARSE), self: STAND, selfTrail: null }));
    const stuck = await drive('zero', after.length, -1, after);
    const resetAt = stuck.awayFrom + 8;
    logs.length = 0;
    const { records } = await drive('zero', after.length, resetAt, after);
    expect(logs.some(l => l.includes('not a marker'))).toBe(false);
    // The watch is 1.5s whether or not the ward was seen on every frame of it:
    // frame resetAt + k runs (k + 1) * 125ms after the reset, and the ward is
    // missing at k = 10.
    for (const r of records.slice(resetAt, resetAt + 11)) expect(r.state).toBe(TrackingState.SCANNING);
    for (const r of records.slice(resetAt)) {
      if (r.state === TrackingState.LOCKED) expect(distance(r.px!, WARD)).toBeGreaterThan(30);
    }
  });
});

describe('the wrong-lock check leaves a walking champion alone', () => {
  test('a classifier sure of a distant ally does not pull a lock that is moving', async () => {
    // A weak model confidently preferring someone else is the risk this check
    // carries. What protects a correct lock is that we move: the evidence only
    // builds while the followed blob stays within a quarter icon (WRONG_LOCK_STILL_FRACTION,
    // at least 3px) of where it started.
    // Locked correctly first; from then on the model is sure it is the ally.
    const FAR_ALLY: Point = BACKDROP.allies![1];
    const specs = walk(70);
    const scenes = renderScenes(specs);
    let target: Point = specs[0].self!;
    const h = newTracker(scenes.map(s => s.frame), { classifier: new OracleScorer(() => toFramePoint(target)) });
    const records: Awaited<ReturnType<typeof driveTracker>> = [];
    for (let i = 0; i < scenes.length; i++) {
      target = i < 16 ? specs[i].self! : FAR_ALLY;
      records.push(...await driveTracker(h, [scenes[i]]));
    }
    expect(records[15].state).toBe(TrackingState.LOCKED);
    for (const r of records.slice(16)) expect(distance(r.px!, r.truth!)).toBeLessThanOrEqual(3);
    expect(logs.some(l => l.includes('is not us'))).toBe(false);
  });
});

describe('the wrong-lock check at real walking speed', () => {
  // ~345 move speed is ~6 px/s on this minimap: 0.75px per 125ms frame.
  // A champion pacing in a small area — last-hitting, holding a bush — never
  // leaves a one-icon radius, which is what the first version of the check
  // used as its "not moving" test.
  test('a champion pacing back and forth keeps its lock against a confidently wrong model', async () => {
    const FAR_ALLY: Point = BACKDROP.allies![1];
    const lockSpecs = walk(16);
    const centre = lockSpecs[15].self!;
    const pace = Array.from({ length: 80 }, (_, i) => {
      const phase = i % 40;
      const dx = Math.round((phase < 20 ? phase : 40 - phase) * 0.75);
      return { ...BACKDROP, self: { x: centre.x + dx, y: centre.y }, selfTrail: { x: phase < 20 ? -1 : 1, y: 0 } };
    });
    const specs = [...lockSpecs, ...pace];
    const scenes = renderScenes(specs);
    let target: Point = specs[0].self!;
    const h = newTracker(scenes.map(s => s.frame), { classifier: new OracleScorer(() => toFramePoint(target)) });
    const records: Awaited<ReturnType<typeof driveTracker>> = [];
    for (let i = 0; i < scenes.length; i++) {
      target = i < 16 ? specs[i].self! : FAR_ALLY;
      records.push(...await driveTracker(h, [scenes[i]]));
    }
    for (const r of records.slice(16)) expect(distance(r.px!, r.truth!)).toBeLessThanOrEqual(3);
    expect(logs.some(l => l.includes('is not us'))).toBe(false);
  });
});

describe('a shared RESET from another player, when our lock is not clean', () => {
  // TrackingService.rescan acts only from a clean lock. Holding, merged or
  // already scanning, the tracker is re-finding us with what it knows about
  // the teammates beside us; starting over threw that away and handed the
  // lock to the nearest teammate (v0.5.21 review).
  const meet = at(START, STEP, 16);
  const withMate = (self: Point | null, mate: Point): SceneSpec =>
    ({ ...BACKDROP, self, selfTrail: null, allies: [...BACKDROP.allies!, mate] });

  async function runWith(specs: SceneSpec[], actAt: Record<number, (h: ReturnType<typeof newTracker>) => void>) {
    const scenes = renderScenes(specs);
    const h = newTracker(scenes.map(sc => sc.frame), { classifier: new ZeroScorer() });
    const records: Awaited<ReturnType<typeof driveTracker>> = [];
    for (let i = 0; i < scenes.length; i++) {
      actAt[i]?.(h);
      records.push(...await driveTracker(h, [scenes[i]]));
    }
    return records;
  }
  const lockedOn = (records: Awaited<ReturnType<typeof driveTracker>>, p: Point) =>
    records.filter(r => r.state === TrackingState.LOCKED && r.holdSec === 0 && distance(r.px!, p) <= 12).length;

  test('during a recall\'s hold, or after it ran out, it never puts us on the teammate beside us', async () => {
    const mate = { x: meet.x + 40, y: meet.y };
    const specs = [
      ...walk(17).map(sc => ({ ...sc, allies: [...BACKDROP.allies!, mate] })),
      ...Array.from({ length: 120 }, () => withMate(null, mate)),
    ];
    let during: boolean | null = null;
    let after: boolean | null = null;
    const a = await runWith(specs, { 25: h => { during = h.svc.rescan(); } });
    const b = await runWith(specs, { 70: h => { after = h.svc.rescan(); } });
    expect(during).toBe(false);
    expect(after).toBe(false);
    expect(lockedOn(a.slice(17), mate)).toBe(0);
    expect(lockedOn(b.slice(17), mate)).toBe(0);
  });

  test('merged with a duo partner, it leaves the pair alone', async () => {
    const mate = { x: meet.x + 18, y: meet.y };
    const specs = [...walk(17), ...Array.from({ length: 40 }, () => withMate(meet, mate))];
    let acted: boolean | null = null;
    const records = await runWith(specs, { 40: h => { acted = h.svc.rescan(); } });
    expect(acted).toBe(false);
    for (const r of records.slice(40)) expect(r.state).toBe(TrackingState.LOCKED);
  });

  test('after our own RESET, it does not undo the avoidance', async () => {
    const lockSpecs = walk(16);
    const from = lockSpecs[15].self!;
    const specs = [...lockSpecs, ...Array.from({ length: 48 }, () => ({ ...BACKDROP, self: from, selfTrail: null }))];
    let acted: boolean | null = null;
    const own = await runWith(specs, { 16: h => h.svc.resetPosition() });
    const both = await runWith(specs, { 16: h => h.svc.resetPosition(), 18: h => { acted = h.svc.rescan(); } });
    expect(acted).toBe(false);
    expect(both.map(r => r.state)).toEqual(own.map(r => r.state));
  });
});

describe('RESET pressed when the lock was right', () => {
  const NEAR_ALLY: Point = { x: 120, y: 120 };

  async function resetWhile(motion: (i: number) => Point, scorer: 'zero' | 'oracle', allies: Point[], how: 'reset' | 'rescan' = 'reset') {
    const lockSpecs = walk(16);
    const from = lockSpecs[15].self!;
    const over: SceneSpec = { ...BACKDROP, allies };
    const after = Array.from({ length: 48 }, (_, i) => {
      const p = motion(i);
      return { ...over, self: { x: from.x + p.x, y: from.y + p.y }, selfTrail: p.x === 0 && p.y === 0 ? null : { x: -1, y: 0 } };
    });
    const specs = [...lockSpecs.map(s => ({ ...s, allies })), ...after];
    const scenes = renderScenes(specs);
    let target: Point | null = null;
    const h = newTracker(scenes.map(s => s.frame), {
      classifier: scorer === 'oracle' ? new OracleScorer(() => target && toFramePoint(target)) : new ZeroScorer(),
    });
    const records: Awaited<ReturnType<typeof driveTracker>> = [];
    for (let i = 0; i < scenes.length; i++) {
      target = specs[i].self ?? null;
      if (i === 16) expect(how === 'reset' ? h.svc.resetPosition() : h.svc.rescan()).toBe(true);
      records.push(...await driveTracker(h, [scenes[i]]));
    }
    return records;
  }

  // Shared RESET: another player pressed RESET, so ours rescans — but nobody
  // said our lock was wrong, so it must not be steered off the icon it had.
  test('a shared RESET finds a standing champion straight away; a RESET of our own steers off it', async () => {
    const still = () => ({ x: 0, y: 0 });
    const soft = await resetWhile(still, 'zero', [...BACKDROP.allies!, NEAR_ALLY], 'rescan');
    const relocked = soft.findIndex((r, i) => i > 16 && r.state === TrackingState.LOCKED);
    expect(relocked).toBeGreaterThan(16);
    expect((relocked - 16) * FRAME_MS).toBeLessThanOrEqual(1_500);
    for (const r of soft.slice(relocked)) expect(distance(r.px!, r.truth!)).toBeLessThanOrEqual(3);
    expect(logs.some(l => l.includes('shared RESET from another player'))).toBe(true);
    expect(logs.some(l => l.includes('avoiding ('))).toBe(false);

    logs.length = 0;
    const own = await resetWhile(still, 'zero', [...BACKDROP.allies!, NEAR_ALLY], 'reset');
    const ownRelocked = own.findIndex((r, i) => i > 16 && r.state === TrackingState.LOCKED && distance(r.px!, r.truth!) <= 3);
    expect(ownRelocked === -1 || (ownRelocked - 16) * FRAME_MS > 1_500).toBe(true);
  });

  test('a champion walking at ordinary speed is found again, not an ally', async () => {
    const records = await resetWhile(i => ({ x: Math.round(i * 0.75), y: 0 }), 'zero', [...BACKDROP.allies!, NEAR_ALLY]);
    expect(logs.some(l => l.includes('it is a champion, not a marker'))).toBe(true);
    for (const r of records.slice(-16)) {
      expect(r.state).toBe(TrackingState.LOCKED);
      expect(distance(r.px!, r.truth!)).toBeLessThanOrEqual(3);
    }
  });

  test('a standing champion the classifier vouches for is found again', async () => {
    const records = await resetWhile(() => ({ x: 0, y: 0 }), 'oracle', [...BACKDROP.allies!, NEAR_ALLY]);
    for (const r of records.slice(-16)) {
      expect(r.state).toBe(TrackingState.LOCKED);
      expect(distance(r.px!, r.truth!)).toBeLessThanOrEqual(3);
    }
  });

  test('the only icon on the minimap is found again within a couple of seconds', async () => {
    const records = await resetWhile(() => ({ x: 0, y: 0 }), 'zero', []);
    const relocked = records.findIndex((r, i) => i > 16 && r.state === TrackingState.LOCKED);
    expect(relocked).toBeGreaterThan(16);
    expect((relocked - 16) * FRAME_MS).toBeLessThanOrEqual(2500);
    expect(distance(records[records.length - 1].px!, records[records.length - 1].truth!)).toBeLessThanOrEqual(3);
  });
});

describe('walking alongside a teammate (v0.5.12 Shen + Vex log)', () => {
  // Two teammates in one lane: their icons overlap into one teal blob too wide
  // to pass as an icon. The tracker used to see no icon of ours at all, give
  // up after 5s, and rescan — where the teammate's icon was the only clean
  // candidate, so it locked onto that. The player was then placed on top of
  // their teammate for most of the game. The classifier is silent here, as it
  // mostly was for Shen.
  const OFFSET: Point = { x: 18, y: 0 };
  const PAIR_STEP: Point = { x: 1, y: 0 };
  const SOLO: SceneSpec = { ...BACKDROP };

  function together(from: Point, count: number, over: SceneSpec = SOLO): SceneSpec[] {
    return Array.from({ length: count }, (_, i) => {
      const self = at(from, PAIR_STEP, i);
      return { ...over, self, selfTrail: null, allies: [...over.allies!, { x: self.x + OFFSET.x, y: self.y + OFFSET.y }] };
    });
  }

  function lockThenJoin(): { specs: SceneSpec[]; joinAt: number; meet: Point } {
    const lock = walk(16);
    const meet = at(START, STEP, 16);
    // The teammate walks in from 50px away and settles 18px beside us.
    const approach = Array.from({ length: 8 }, (_, i) => {
      const self = at(meet, PAIR_STEP, i);
      const gap = 50 - 4 * i;
      return { ...SOLO, self, selfTrail: null, allies: [...SOLO.allies!, { x: self.x + Math.max(OFFSET.x, gap), y: self.y }] };
    });
    return { specs: [...lock, ...approach], joinAt: 16, meet };
  }

  async function run(specs: SceneSpec[]) {
    const scenes = renderScenes(specs);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    return driveTracker(h, scenes);
  }

  test('the pair really merges into one blob the icon filter rejects', async () => {
    const { specs } = lockThenJoin();
    const pairStart = at(at(START, STEP, 16), PAIR_STEP, 8);
    const scenes = renderScenes([...specs, ...together(pairStart, 4)]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);
    expect(logs.some(l => l.includes('merged with a teammate'))).toBe(true);
    expect(records[records.length - 1].state).toBe(TrackingState.LOCKED);
  });

  test('stays with the player for as long as they walk together, without a hold', async () => {
    const { specs } = lockThenJoin();
    const pairStart = at(at(START, STEP, 16), PAIR_STEP, 8);
    const pair = together(pairStart, 64); // 8s: past the 5s that used to force a rescan
    const records = await run([...specs, ...pair]);
    const during = records.slice(specs.length);
    expect(logs.some(l => l.includes('Hold exceeded'))).toBe(false);
    for (const r of during) {
      expect(r.state).toBe(TrackingState.LOCKED);
      expect(r.holdSec).toBe(0);
      // On our side of the pair: nearer our icon than the teammate's.
      const mate = { x: r.truth!.x + OFFSET.x, y: r.truth!.y + OFFSET.y };
      expect(distance(r.px!, r.truth!)).toBeLessThan(distance(r.px!, mate));
      expect(distance(r.px!, r.truth!)).toBeLessThanOrEqual(8);
    }
  });

  test('the same for a champion whose art is teal (Gwen beside her support)', async () => {
    // Her hair fills the merged pair past the plain-ring fill cap; before
    // v0.5.21's review it was not taken for a stack at all, held, and was
    // rescanned at 5s like the v0.5.12 log.
    const { specs } = lockThenJoin();
    const pairStart = at(at(START, STEP, 16), PAIR_STEP, 8);
    const pair = together(pairStart, 64);
    const art = (s: SceneSpec): SceneSpec => ({ ...s, selfTealArt: true });
    const records = await run([...specs, ...pair].map(art));
    expect(logs.some(l => l.includes('merged with a teammate'))).toBe(true);
    expect(logs.some(l => l.includes('Hold exceeded'))).toBe(false);
    for (const r of records.slice(specs.length)) {
      expect(r.state).toBe(TrackingState.LOCKED);
      expect(distance(r.px!, r.truth!)).toBeLessThanOrEqual(8);
    }
  });

  test('when they split up, the lock goes with the player, not the teammate', async () => {
    const { specs } = lockThenJoin();
    const pairStart = at(at(START, STEP, 16), PAIR_STEP, 8);
    const pair = together(pairStart, 24);
    const last = pair[pair.length - 1].self!;
    const split = Array.from({ length: 24 }, (_, i) => {
      const self = { x: last.x, y: last.y - i };
      return { ...SOLO, self, selfTrail: null, allies: [...SOLO.allies!, { x: last.x + OFFSET.x + i, y: last.y + i }] };
    });
    const records = await run([...specs, ...pair, ...split]);
    for (const r of records.slice(-12)) {
      expect(r.state).toBe(TrackingState.LOCKED);
      expect(distance(r.px!, r.truth!)).toBeLessThanOrEqual(3);
    }
  });

  test('recalling from beside the teammate does not hand the lock to them', async () => {
    const { specs } = lockThenJoin();
    const pairStart = at(at(START, STEP, 16), PAIR_STEP, 8);
    const pair = together(pairStart, 24);
    const last = pair[pair.length - 1].self!;
    const mateAt = { x: last.x + OFFSET.x, y: last.y + OFFSET.y };
    // We recall: our icon is gone; the teammate stays, then walks off.
    const after = Array.from({ length: 80 }, (_, i) => ({
      ...SOLO, self: null, allies: [...SOLO.allies!, { x: mateAt.x + Math.floor(i / 2), y: mateAt.y }],
    }));
    const records = await run([...specs, ...pair, ...after]);
    expect(logs.some(l => l.includes('not taking theirs for ours'))).toBe(true);
    const recallAt = specs.length + pair.length;
    // Held as lost — so the orchestrator disowns us at 2s — never following the teammate.
    expect(records[recallAt + 20].holdSec).toBeGreaterThan(2);
    expect(records[recallAt + 20].holdReason).toBe('no-match');
    for (const r of records.slice(recallAt)) {
      const mate = { x: mateAt.x + Math.floor((r.i - recallAt) / 2), y: mateAt.y };
      if (r.state === TrackingState.LOCKED && r.holdSec === 0) {
        expect(distance(r.px!, mate)).toBeGreaterThan(12);
      }
    }
  });

  test('the teammate recalling leaves the lock on the player', async () => {
    const { specs } = lockThenJoin();
    const pairStart = at(at(START, STEP, 16), PAIR_STEP, 8);
    const pair = together(pairStart, 24);
    const last = pair[pair.length - 1].self!;
    const after = Array.from({ length: 24 }, (_, i) => ({ ...SOLO, self: { x: last.x, y: last.y - i }, selfTrail: null }));
    const records = await run([...specs, ...pair, ...after]);
    expect(logs.some(l => l.includes('not taking theirs for ours'))).toBe(false);
    for (const r of records.slice(-16)) {
      expect(r.state).toBe(TrackingState.LOCKED);
      expect(distance(r.px!, r.truth!)).toBeLessThanOrEqual(3);
    }
  });
});

describe('walking alongside a teammate — review findings', () => {
  const OFFSET = 18;
  const SOLO: SceneSpec = { ...BACKDROP };
  const meet = at(START, STEP, 16);

  async function run(specs: SceneSpec[], classifier: 'zero' | ((i: number) => Point | null) = 'zero') {
    const scenes = renderScenes(specs);
    let target: Point | null = null;
    const scorer = classifier === 'zero' ? new ZeroScorer() : new OracleScorer(() => target && toFramePoint(target));
    const h = newTracker(scenes.map(s => s.frame), { classifier: scorer });
    const records: Awaited<ReturnType<typeof driveTracker>> = [];
    for (let i = 0; i < scenes.length; i++) {
      if (classifier !== 'zero') target = classifier(i);
      records.push(...await driveTracker(h, [scenes[i]]));
    }
    return records;
  }
  const withMate = (self: Point | null, mate: Point): SceneSpec =>
    ({ ...SOLO, self, selfTrail: null, allies: [...SOLO.allies!, mate] });

  test('teammates walking over the spot we recalled from do not re-own it', async () => {
    // Recall first (a no-match hold), then a merged pair walks across where
    // we vanished. Picking that up as "us" would put a player who is in base
    // back in lane, next to them.
    const pair = Array.from({ length: 40 }, (_, i) => {
      const a = { x: meet.x - 40 + 2 * i, y: meet.y };
      return { ...SOLO, self: null, allies: [...SOLO.allies!, a, { x: a.x + OFFSET, y: a.y }] };
    });
    const records = await run([...walk(16), ...vanished(6), ...pair]);
    expect(logs.some(l => l.includes('merged with a teammate'))).toBe(false);
    expect(records[16 + 6 + 12].holdSec).toBeGreaterThan(2);
  });

  test('a duo merged for 20s still ends with the lock on the player', async () => {
    // Past the old 15s cap. Then we stand still and the teammate walks off.
    const pair = Array.from({ length: 160 }, () => withMate(meet, { x: meet.x + OFFSET, y: meet.y }));
    const split = Array.from({ length: 24 }, (_, i) => withMate(meet, { x: meet.x + OFFSET + i, y: meet.y - i }));
    const records = await run([...walk(17), ...pair, ...split]);
    expect(logs.some(l => l.includes('Hold exceeded'))).toBe(false);
    for (const r of records.slice(-8)) {
      expect(r.state).toBe(TrackingState.LOCKED);
      expect(distance(r.px!, r.truth!)).toBeLessThanOrEqual(3);
    }
  });

  test('a teammate walking through a standing player leaves the lock on the player', async () => {
    const through = Array.from({ length: 96 }, (_, i) => withMate(meet, { x: meet.x + 40 - i, y: meet.y }));
    const records = await run([...walk(17), ...through]);
    for (const r of records.slice(-6)) {
      expect(r.state).toBe(TrackingState.LOCKED);
      expect(distance(r.px!, meet)).toBeLessThanOrEqual(3);
    }
  });

  test('a teammate who settles almost on top of the player and then leaves does not take the lock along', async () => {
    // While the two icons overlap deeply the merged blob still passes as one
    // icon and is followed by its centre — the midpoint. When it widens into
    // a pair again, our side must come from where we last saw our icon alone,
    // not from that midpoint, or the estimate drifts off with the teammate.
    const approach = Array.from({ length: 38 }, (_, i) => withMate(meet, { x: meet.x + 40 - i, y: meet.y }));
    const linger = Array.from({ length: 16 }, () => withMate(meet, { x: meet.x + 2, y: meet.y }));
    const leave = Array.from({ length: 60 }, (_, i) => withMate(meet, { x: meet.x + 2 + i, y: meet.y }));
    const records = await run([...walk(17), ...approach, ...linger, ...leave]);
    for (const r of records.slice(-6)) {
      expect(r.state).toBe(TrackingState.LOCKED);
      expect(distance(r.px!, meet)).toBeLessThanOrEqual(3);
    }
  });

  test('one noisy classifier run does not release an excluded teammate', async () => {
    // Few icons on screen, so normalization can turn a stray raw score into a
    // confident 1.0 for the teammate on a single run. Three runs in a row are
    // needed before an excluded icon is let back in.
    const pair = Array.from({ length: 24 }, (_, i) => {
      const self = at(meet, { x: 1, y: 0 }, i);
      return withMate(self, { x: self.x + OFFSET, y: self.y });
    });
    const last = pair[pair.length - 1].self!;
    const left = { x: last.x + OFFSET, y: last.y };
    const after = Array.from({ length: 64 }, () => withMate(null, left));
    const n = 16 + 24;
    // Silent, except for the first run after the exit (one run happens in any
    // 4 frames = 500ms), which points at the teammate. That is the worst case:
    // the icon's first score is unsmoothed, so the spike reads 1.0.
    const records = await run([...walk(16), ...pair, ...after],
      i => (i < 16 ? at(START, STEP, i) : i >= n && i < n + 4 ? left : null));
    for (const r of records.slice(n)) {
      if (r.state === TrackingState.LOCKED && r.holdSec === 0) expect(distance(r.px!, left)).toBeGreaterThan(12);
    }
  });

  test('recalling from beside a teammate never hands them the lock, even 20s on', async () => {
    const pair = Array.from({ length: 24 }, (_, i) => {
      const self = at(meet, { x: 1, y: 0 }, i);
      return withMate(self, { x: self.x + OFFSET, y: self.y });
    });
    const last = pair[pair.length - 1].self!;
    const mate = { x: last.x + OFFSET, y: last.y };
    const after = Array.from({ length: 160 }, (_, i) => withMate(null, { x: mate.x + Math.floor(i / 4), y: mate.y }));
    const records = await run([...walk(16), ...pair, ...after]);
    // (driven a frame at a time, so r.i is always 0: index by position)
    records.forEach((r, i) => {
      if (i < 16 + 24) return;
      const m = { x: mate.x + Math.floor((i - 40) / 4), y: mate.y };
      if (r.state === TrackingState.LOCKED && r.holdSec === 0) expect(distance(r.px!, m)).toBeGreaterThan(12);
    });
  });

  test('recalling from 40px beside a teammate (not merged) does not hand them the lock either', async () => {
    const mate = { x: meet.x + 40, y: meet.y };
    const records = await run([
      ...walk(17).map(sc => ({ ...sc, allies: [...SOLO.allies!, mate] })),
      ...Array.from({ length: 160 }, () => withMate(null, mate)),
    ]);
    for (const r of records.slice(17)) {
      if (r.state === TrackingState.LOCKED && r.holdSec === 0) expect(distance(r.px!, mate)).toBeGreaterThan(12);
    }
  });

  test('an excluded icon the classifier keeps vouching for is let go', async () => {
    // The exit was misjudged: the icon left is ours. A classifier that is sure
    // of it releases it and the tracker takes it back.
    const pair = Array.from({ length: 24 }, (_, i) => {
      const self = at(meet, { x: 1, y: 0 }, i);
      return withMate(self, { x: self.x + OFFSET, y: self.y });
    });
    const last = pair[pair.length - 1].self!;
    const left = { x: last.x + OFFSET, y: last.y };
    const after = Array.from({ length: 64 }, () => withMate(null, left));
    const n = 16 + 24;
    const records = await run([...walk(16), ...pair, ...after], i => (i < 16 ? at(START, STEP, i) : i < n ? null : left));
    expect(logs.some(l => l.includes('not taking theirs for ours'))).toBe(true);
    const back = records.findIndex((r, i) => i > n && r.state === TrackingState.LOCKED && r.holdSec === 0 && distance(r.px!, left) <= 3);
    expect(back).toBeGreaterThan(n);
    expect((back - n) * FRAME_MS).toBeLessThanOrEqual(4000);
  });
});

describe('walking alongside a teammate — second review', () => {
  const SOLO: SceneSpec = { ...BACKDROP };
  const meet = at(START, STEP, 16);
  const group = (self: Point | null, mates: Point[]): SceneSpec =>
    ({ ...SOLO, self, selfTrail: null, allies: [...SOLO.allies!, ...mates] });
  async function run(specs: SceneSpec[]) {
    const scenes = renderScenes(specs);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records: Awaited<ReturnType<typeof driveTracker>> = [];
    for (const sc of scenes) records.push(...await driveTracker(h, [sc]));
    return records;
  }

  test('our icon set aside near where we were lost is taken back once our movement path shows on it', async () => {
    // A silent classifier and our icon reappearing 1.5 icons from where it
    // vanished: past the hold's near field, so the forced rescan sets it aside
    // as a teammate's. The movement path drawn from it is what says it is us.
    const last = at(START, STEP, 15);
    const back = { x: last.x + 36, y: last.y };
    const records = await run([
      ...walk(16), ...vanished(4),
      ...Array.from({ length: 120 }, () => ({ ...SOLO, self: back, selfTrail: { x: -STEP.x, y: -STEP.y } })),
    ]);
    const end = records[records.length - 1];
    expect(end.state).toBe(TrackingState.LOCKED);
    expect(distance(end.px!, back)).toBeLessThanOrEqual(3);
  });

  test('recalling out of a group of three does not leave us following the two left behind', async () => {
    // Three teammates merged into one wide blob; we recall and the other two
    // stay merged as a pair, which still looks like a stack. Following it
    // would keep a player sitting in base audible in lane, with no hold.
    const mates = [{ x: meet.x + 16, y: meet.y }, { x: meet.x + 32, y: meet.y }];
    const trio = Array.from({ length: 24 }, () => group(meet, mates));
    const after = Array.from({ length: 80 }, () => group(null, mates));
    const records = await run([...walk(17), ...trio, ...after]);
    expect(logs.some(l => l.includes('merged with a teammate'))).toBe(true);
    expect(logs.some(l => l.includes('An icon left the merged teammate icons'))).toBe(true);
    const recallAt = 17 + 24;
    expect(records[recallAt + 24].holdSec).toBeGreaterThan(2);
    const pairCentre = { x: meet.x + 24, y: meet.y };
    records.slice(recallAt + 4).forEach(r => {
      if (r.state === TrackingState.LOCKED && r.holdSec === 0) expect(distance(r.px!, pairCentre)).toBeGreaterThan(20);
    });
  });

  test('a teammate walking out of a group of three leaves us following the other', async () => {
    const a = { x: meet.x + 16, y: meet.y };
    const trio = Array.from({ length: 24 }, () => group(meet, [a, { x: meet.x + 32, y: meet.y }]));
    const leave = Array.from({ length: 40 }, (_, i) => group(meet, [a, { x: meet.x + 32 + i, y: meet.y + i }]));
    const records = await run([...walk(17), ...trio, ...leave]);
    expect(logs.some(l => l.includes('An icon left the merged teammate icons'))).toBe(false);
    for (const r of records.slice(-16)) {
      expect(r.holdSec).toBe(0);
      expect(distance(r.px!, meet)).toBeLessThanOrEqual(12);
    }
  });
});

describe('the rescan after a hold runs out', () => {
  test('does not lock an unidentified teammate icon far from where we were lost', async () => {
    // Our icon is gone (fog, a merge the tracker could not follow) for long
    // enough to force a rescan. The backdrop allies are ~150px away; nothing
    // identifies either. Locking one is how the log put Shen on Vex.
    const VANISH: Point = at(START, STEP, 15);
    const scenes = renderScenes([...walk(16), ...vanished(96), ...Array.from({ length: 16 }, () => ({ ...BACKDROP, self: VANISH, selfTrail: null }))]);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);
    expect(logs.some(l => l.includes('Hold exceeded'))).toBe(true);
    for (const r of records.slice(16, 16 + 96)) {
      if (r.state === TrackingState.LOCKED && r.holdSec === 0) {
        for (const ally of BACKDROP.allies!) expect(distance(r.px!, ally)).toBeGreaterThan(20);
      }
    }
    // ...and takes our icon back when it shows up where we were.
    const last = records[records.length - 1];
    expect(last.state).toBe(TrackingState.LOCKED);
    expect(distance(last.px!, VANISH)).toBeLessThanOrEqual(3);
  });
});

describe('re-acquiring across the map (2026-10-07 gcg545 log)', () => {
  // A Darius in top lane lost his icon and Phase 2 re-acquired him on a
  // teammate's icon in bot lane — 13,000 units in 0.6 s — on a smoothed score
  // of 0.64 that a near-silent model's normalization had produced. The enemy
  // bot laner then heard him, and he heard them.
  const WALK = 16;
  const VANISH: Point = at(START, STEP, WALK - 1);
  const FAR_ALLY: Point = BACKDROP.allies![1];
  const reacquired = () => logs.some(l => l.includes('Re-acquired via classifier'));

  /** Recognises us while we walk, then names `after` once our icon is gone. */
  function run(specs: SceneSpec[], after: Point, raw: number) {
    const scenes = renderScenes(specs);
    let h: ReturnType<typeof newTracker> | null = null;
    const target = () => {
      const frame = h ? h.source.captureCount - 1 : 0;
      return toFramePoint(frame < WALK ? at(START, STEP, frame) : after);
    };
    h = newTracker(scenes.map(s => s.frame), { classifier: new OracleScorer(target, raw) });
    return driveTracker(h, scenes);
  }

  test('a near-silent model cannot move us further than we could have travelled', async () => {
    // Past the 5 s forced rescan too: that rescan used to count the same
    // normalized score as identifying the far icon and lock onto it there.
    const records = await run([...walk(WALK), ...vanished(140)], FAR_ALLY, 0.02);

    expect(distance(VANISH, FAR_ALLY)).toBeGreaterThan(150);
    expect(reacquired()).toBe(false);
    expect(logs.some(l => l.includes('Not re-acquiring at game('))).toBe(true);
    for (const r of records.slice(WALK)) {
      if (r.px) expect(distance(r.px, FAR_ALLY)).toBeGreaterThan(50);
    }
    expect(logs.some(l => l.includes('Hold exceeded'))).toBe(true);
    expect(logs.some(l => l.includes('SCANNING -> LOCKED'))).toBe(true); // the walk's own lock only
    expect(logs.filter(l => l.includes('SCANNING -> LOCKED')).length).toBe(1);
  });

  test('a model that really recognises us still follows a Teleport', async () => {
    const records = await run([
      ...walk(WALK),
      ...vanished(8),
      ...Array.from({ length: 16 }, () => ({ ...BACKDROP, allies: [BACKDROP.allies![0]], self: FAR_ALLY })),
    ], FAR_ALLY, 0.9);

    expect(reacquired()).toBe(true);
    expect(distance(records[records.length - 1].px!, FAR_ALLY)).toBeLessThan(12);
  });

  test('a recall into the fountain needs no more than before', async () => {
    const FOUNTAIN: Point = { x: 20, y: 255 };
    const records = await run([
      ...walk(WALK),
      ...vanished(4),
      ...Array.from({ length: 16 }, () => ({ ...BACKDROP, turrets: [], self: FOUNTAIN })),
    ], FOUNTAIN, 0.02);

    expect(distance(VANISH, FOUNTAIN)).toBeGreaterThan(90);
    expect(reacquired()).toBe(true);
    expect(distance(records[records.length - 1].px!, FOUNTAIN)).toBeLessThan(12);
  });
});

describe('the camera says which teammate icon is us (2026-10-08 1hoxklt log)', () => {
  // In that game the classifier scored Gwen 0% and the fountain lock took
  // Kayn's icon, which Gwen's tracker then followed for four minutes. What
  // still told them apart was the camera: Gwen's stayed on Gwen.
  //
  // A free camera, not a locked one — the player is inside the rectangle but
  // well off its centre, which is how most of the testers play.
  const DECOY_FROM: Point = { x: 200, y: 80 };
  const SELF_FROM: Point = { x: 80, y: 200 };
  const SELF_STEP: Point = { x: 0.25, y: -0.1 };
  const freeCam = (p: Point) => ({ x: p.x - 20, y: p.y - 50, w: 110, h: 80 });

  /** The decoy alone first, so the tracker locks it; then both, with the camera on self. */
  function wrongStart(
    seconds: number,
    camera: (self: Point, decoy: Point, i: number) => SceneSpec['camera'],
    decoyFrom: Point = DECOY_FROM,
  ): SceneSpec[] {
    const intro = Array.from({ length: 32 }, (_, i): SceneSpec => {
      const decoy = at(decoyFrom, { x: 0, y: 0.05 }, i);
      return { allies: [decoy], enemies: [{ x: 250, y: 160 }], camera: freeCam(SELF_FROM) };
    });
    const both = Array.from({ length: seconds * 8 }, (_, i): SceneSpec => {
      const decoy = at(decoyFrom, { x: 0, y: 0.05 }, 32 + i);
      const self = at(SELF_FROM, SELF_STEP, i);
      return {
        self, selfTrail: null, allies: [decoy], enemies: [{ x: 250, y: 160 }],
        camera: camera(self, decoy, i),
      };
    });
    return [...intro, ...both];
  }

  test('a lock on a teammate the player never looks at moves to the icon they do', async () => {
    const scenes = renderScenes(wrongStart(40, (self) => freeCam(self)));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    // Really started on the decoy, or this proves nothing.
    expect(distance(records[40].px!, at(DECOY_FROM, { x: 0, y: 0.05 }, 40))).toBeLessThan(6);
    const switched = records.findIndex(r => r.truth && r.px && distance(r.px, r.truth) < 6);
    const locked = records.findIndex(r => r.state === TrackingState.LOCKED);
    expect(switched).toBeGreaterThan(32);
    // Not within the cooldown after the lock, nor before 10s of evidence on
    // both icons; and well inside a window once both hold.
    expect((switched - locked) * FRAME_MS).toBeGreaterThanOrEqual(CAMERA_SWITCH_COOLDOWN_MS);
    expect((switched - 32) * FRAME_MS).toBeGreaterThanOrEqual(CAMERA_DWELL_MIN_READABLE_MS);
    expect((switched - 32) * FRAME_MS).toBeLessThanOrEqual(30_000);
    for (const r of records.slice(switched)) expect(distance(r.px!, r.truth!)).toBeLessThan(6);
    expect(logs.some(l => l.includes('moving to the one it keeps on screen'))).toBe(true);
  });

  /**
   * Locked on self from the start with the camera on self, then the camera
   * somewhere else from `awayFrom` to `awayTo` seconds: on the teammate while
   * `onDecoy(t)`, on an empty stretch of map otherwise.
   */
  function lookingAway(seconds: number, awayFrom: number, awayTo: number, onDecoy: (t: number) => boolean): SceneSpec[] {
    return Array.from({ length: seconds * 8 }, (_, i): SceneSpec => {
      const self = at(SELF_FROM, SELF_STEP, i);
      const decoy = at(DECOY_FROM, { x: 0, y: 0.05 }, i);
      const t = i / 8;
      const away = t >= awayFrom && t < awayTo;
      return {
        self, selfTrail: { x: -SELF_STEP.x, y: -SELF_STEP.y }, allies: i < 16 ? [] : [decoy],
        enemies: [{ x: 250, y: 160 }],
        camera: !away ? freeCam(self)
          : onDecoy(t) ? { x: decoy.x - 35, y: decoy.y - 30, w: 70, h: 60 }
          : { x: 10, y: 10, w: 110, h: 80 },
      };
    });
  }

  test('watching a teammate for 22s does not move the lock off the player', async () => {
    // A fight in another lane, or F2 held: 22s of 30 on the teammate leaves
    // the player on screen about a quarter of the window, still above
    // CAMERA_DWELL_LOW.
    const specs = lookingAway(50, 20, 42, () => true);
    const scenes = renderScenes(specs);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);

    const locked = records.findIndex(r => r.state === TrackingState.LOCKED);
    expect(distance(records[locked + 1].px!, records[locked + 1].truth!)).toBeLessThan(6);
    for (const r of records.slice(locked + 1)) expect(distance(r.px!, r.truth!)).toBeLessThan(6);
    expect(logs.some(l => l.includes('moving to the one it keeps on screen'))).toBe(false);
  });

  test('a teammate on screen half the time is not enough, even with the player never in view', async () => {
    // 20s watching an empty stretch of map (an objective), then 15s on the
    // teammate: the player is off screen for the whole window, but the
    // teammate is in view only half of it, short of CAMERA_DWELL_HIGH.
    const specs = lookingAway(55, 20, 55, (t) => t >= 40);
    const scenes = renderScenes(specs);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);
    const locked = records.findIndex(r => r.state === TrackingState.LOCKED);
    for (const r of records.slice(locked + 1)) expect(distance(r.px!, r.truth!)).toBeLessThan(6);
    expect(logs.some(l => l.includes('moving to the one it keeps on screen'))).toBe(false);
  });

  test('a classifier that recognises the icon we follow outranks the camera', async () => {
    // 40s watching a teammate: on camera evidence alone that moves the lock
    // (the control run); with the model genuinely recognising the player, it
    // does not.
    const specs = lookingAway(60, 20, 60, () => true);
    let base = 0;
    const selfNow = () => toFramePoint(at(SELF_FROM, SELF_STEP, Math.round((performance.now() - base) / FRAME_MS) - 1));
    const control = renderScenes(specs);
    const hc = newTracker(control.map(s => s.frame), { classifier: new ZeroScorer() });
    await driveTracker(hc, control);
    expect(logs.some(l => l.includes('moving to the one it keeps on screen'))).toBe(true);

    logs.length = 0;
    const scenes = renderScenes(specs);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new OracleScorer(selfNow, 0.6) });
    base = performance.now();
    const records = await driveTracker(h, scenes);
    expect(logs.some(l => /Classifier scores: .*raw=0\.600/.test(l))).toBe(true);
    expect(logs.some(l => l.includes('moving to the one it keeps on screen'))).toBe(false);
    const r = records[records.length - 1];
    expect(distance(r.px!, r.truth!)).toBeLessThan(6);
  });

  test('never moves the lock off an icon in a base, where players look elsewhere', async () => {
    // Shopping, or waiting out a recall: the camera is on the map, not on the
    // fountain. The same evidence that moves a lock in lane does not move it
    // out of a base.
    const BASE: Point = { x: 25, y: 245 };
    const scenes = renderScenes(wrongStart(40, (self) => freeCam(self), BASE));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);
    expect(distance(records[40].px!, at(BASE, { x: 0, y: 0.05 }, 40))).toBeLessThan(6);
    expect(logs.some(l => l.includes('moving to the one it keeps on screen'))).toBe(false);
  });

  test('after RESET, the scan locks the icon the camera keeps on screen', async () => {
    // Locked on the decoy; the user presses RESET with 12s of camera history
    // behind them. The scan rules the decoy out and the camera names the
    // player at once, instead of waiting for them to walk.
    const scenes = renderScenes(wrongStart(13, (self) => freeCam(self)));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const first = await driveTracker(h, scenes.slice(0, 32 + 11 * 8));
    expect(distance(first[first.length - 1].px!, first[first.length - 1].truth!)).toBeGreaterThan(50);
    h.svc.resetPosition();
    const after = await driveTracker(h, scenes.slice(32 + 11 * 8));
    const lockLine = logs.find(l => l.includes('SCANNING -> LOCKED via camera('));
    expect(lockLine).toBeDefined();
    const relocked = after.findIndex(r => r.state === TrackingState.LOCKED);
    expect(relocked * FRAME_MS).toBeLessThanOrEqual(1_500);
    for (const r of after.slice(relocked)) expect(distance(r.px!, r.truth!)).toBeLessThan(6);
    // And the icon reset away from stays out of the camera's picks after the
    // scan's own avoidance has ended with this lock.
    const decoyNow = at(DECOY_FROM, { x: 0, y: 0.05 }, scenes.length - 1);
    const readings = (h.svc as any).cameraDwell.readings(performance.now());
    expect(readings.find((x: any) => distance(x, decoyNow) < 6).rejected).toBe(true);
  });

  test('a rescan does not take a far teammate the camera was watching while we were in base', async () => {
    // Shopping in the fountain with the camera on a teammate in lane, then our
    // icon lost in the fountain long enough to rescan. The teammate is the
    // camera's clear favourite, and far out of walking reach.
    const BASE_SELF: Point = { x: 30, y: 240 };
    const lane = (i: number) => at(DECOY_FROM, { x: 0, y: 0.05 }, i);
    const specs: SceneSpec[] = [
      ...Array.from({ length: 20 * 8 }, (_, i): SceneSpec => ({
        self: BASE_SELF, allies: i < 16 ? [] : [lane(i)], enemies: [{ x: 250, y: 160 }],
        camera: { x: lane(i).x - 35, y: lane(i).y - 30, w: 70, h: 60 },
      })),
      ...Array.from({ length: 10 * 8 }, (_, i): SceneSpec => ({
        self: null, allies: [lane(160 + i)], enemies: [{ x: 250, y: 160 }],
        camera: { x: lane(160 + i).x - 35, y: lane(160 + i).y - 30, w: 70, h: 60 },
      })),
    ];
    const scenes = renderScenes(specs);
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);
    // It did rescan, and never put us on the teammate.
    expect(records.some(r => r.state === TrackingState.SCANNING && r.i > 160)).toBe(true);
    for (const r of records) {
      if (r.px) expect(distance(r.px, lane(r.i))).toBeGreaterThan(40);
    }
  });

  test('two icons the player keeps on screen together are left alone', async () => {
    // A duo lane: the camera shows both all the time, so it cannot say which
    // is us, and the lock it has is kept.
    const scenes = renderScenes(wrongStart(40, (self) => ({ x: self.x - 20, y: 70, w: 170, h: 160 })));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);
    // The box really does contain the decoy as well.
    expect(DECOY_FROM.y).toBeGreaterThan(70);
    expect(logs.some(l => l.includes('moving to the one it keeps on screen'))).toBe(false);
    expect(distance(records[records.length - 1].px!, at(DECOY_FROM, { x: 0, y: 0.05 }, records.length - 1))).toBeLessThan(6);
  });
});

describe('a champion whose art is teal (2026-10-08 evening log, two Gwens)', () => {
  // Gwen's cyan hair passes the teal test and merges with her ring into a blob
  // too filled for a bare ring: until v0.5.21 the tracker threw her icon away
  // on every frame, so a Gwen was tracked on nobody's screen — her own
  // tracker followed teammates instead.
  test('is found and followed', async () => {
    const scenes = renderScenes(walk(30).map(s => ({ ...s, selfTealArt: true })));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const m = metrics(await driveTracker(h, scenes));
    expect(m.lockFrame).toBeGreaterThanOrEqual(0);
    expect(m.lockFrame).toBeLessThanOrEqual(12);
    expect(m.maxErrorPx).toBeLessThanOrEqual(3);
  });

  test('a turret and a minion wave still are not icons', async () => {
    // Nothing but the backdrop's turret and minions on our side: no lock.
    const scenes = renderScenes(Array.from({ length: 30 }, () => ({
      enemies: BACKDROP.enemies, turrets: BACKDROP.turrets, minions: [{ x: 120, y: 120 }, { x: 128, y: 126 }],
    })));
    const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
    const records = await driveTracker(h, scenes);
    expect(records.every(r => r.state !== TrackingState.LOCKED)).toBe(true);
  });
});

describe('an icon the skin match calls a teammate\'s', () => {
  const MATE: Point = { x: 150, y: 120 };

  test('is never locked on, even with nothing else to follow', async () => {
    // Our own icon is nowhere to be seen (how red Gwen's was); the one
    // teammate's is a clean ring. Before v0.5.21 the ring score alone took the
    // lock ("cls=0.00 ... ring=0.99").
    const scenes = renderScenes(Array.from({ length: 40 }, () => ({ ...NO_TEAL, allies: [MATE] })));
    const classifier = new SkinVerdictScorer(() => null, () => [toFramePoint(MATE)]);
    const h = newTracker(scenes.map(s => s.frame), { classifier });
    const records = await driveTracker(h, scenes);
    expect(classifier.runs).toBeGreaterThan(3);
    expect(records.every(r => r.state !== TrackingState.LOCKED)).toBe(true);
  });

  test('is let go once the verdicts come in, and we are found', async () => {
    // Locked on the teammate before skin matching had its say (the model
    // was silent): two verdicts later the tracker drops it and, rescanning,
    // finds our own icon — teal art and all.
    let verdictsOn = false;
    const selfAt = (i: number): Point => at({ x: 60, y: 220 }, { x: 1, y: 0 }, i);
    const specs: SceneSpec[] = Array.from({ length: 120 }, (_, i) => ({
      ...NO_TEAL,
      allies: [MATE],
      self: i < 20 ? null : selfAt(i),
      selfTealArt: true,
    }));
    const scenes = renderScenes(specs);
    let frame = 0;
    const classifier = new SkinVerdictScorer(
      () => (verdictsOn && frame >= 20 ? toFramePoint(selfAt(frame)) : null),
      () => (verdictsOn ? [toFramePoint(MATE)] : []),
    );
    const h = newTracker(scenes.map(s => s.frame), { classifier });
    const early = await driveTracker(h, scenes.slice(0, 20));
    expect(early[early.length - 1].state).toBe(TrackingState.LOCKED);
    expect(distance(early[early.length - 1].px!, MATE)).toBeLessThanOrEqual(3);
    verdictsOn = true;
    const late = [];
    for (let i = 20; i < scenes.length; i++) {
      frame = i;
      late.push(...await driveTracker(h, [scenes[i]]));
    }
    // Let go within two classifier runs and a frame or two — not after a 5s
    // hold that keeps reporting the teammate's position as ours.
    const onMate = (r: { px: Point | null }) => !!r.px && distance(r.px, MATE) <= 3;
    const released = late.findIndex(r => !onMate(r) || r.state !== TrackingState.LOCKED);
    expect(released).toBeGreaterThanOrEqual(0);
    expect(released * FRAME_MS).toBeLessThanOrEqual(1500);
    const last = late[late.length - 1];
    expect(last.state).toBe(TrackingState.LOCKED);
    expect(distance(last.px!, selfAt(scenes.length - 1))).toBeLessThanOrEqual(3);
  });

  test('is let go at once even when nothing yet says which icon is ours', async () => {
    // As above, but the skin match is unsure of our icon (half covered, say):
    // nothing re-acquires us, so only dropping the teammate's icon outright
    // stops its position going out as ours for a 5s hold.
    const selfAt = (i: number): Point => at({ x: 60, y: 220 }, { x: 1, y: 0 }, i);
    const specs: SceneSpec[] = Array.from({ length: 40 }, (_, i) => ({
      ...NO_TEAL, allies: [MATE], self: i < 20 ? null : selfAt(i),
    }));
    const scenes = renderScenes(specs);
    let verdictsOn = false;
    const classifier = new SkinVerdictScorer(() => null, () => (verdictsOn ? [toFramePoint(MATE)] : []));
    const h = newTracker(scenes.map(s => s.frame), { classifier });
    const early = await driveTracker(h, scenes.slice(0, 20));
    expect(distance(early[early.length - 1].px!, MATE)).toBeLessThanOrEqual(3);
    verdictsOn = true;
    const late = await driveTracker(h, scenes.slice(20));
    const reportsMate = late.map(r => r.state === TrackingState.LOCKED && !!r.px && distance(r.px, MATE) <= 3);
    const lastOnMate = reportsMate.lastIndexOf(true);
    expect((lastOnMate + 1) * FRAME_MS).toBeLessThanOrEqual(1500);
    expect(logs.some(l => l.includes('is a teammate\'s (skin match)'))).toBe(true);
  });

  // Two teammates fighting side by side: theirs is drawn over ours, and the
  // camera — locked on us — is centred on the pair. Until v0.5.22 the tracker
  // let their icon go as soon as the skin match named it, and had no position
  // at all until it locked it again (the 2026-10-08 test: four times in half
  // a minute, with the enemy in the fight unable to hear us).
  describe('over ours, with the camera centred on them', () => {
    const P: Point = { x: 120, y: 150 };
    // A real camera rectangle is about 3.4 by 1.9 icons (2026-10-08 frames).
    const camOn = (p: Point) => ({ x: p.x - 41, y: p.y - 23, w: 82, h: 46 });
    const BASE: SceneSpec = { enemies: BACKDROP.enemies };
    const WALK = 50;
    const selfAt = (i: number): Point => ({ x: P.x - WALK + i, y: P.y });
    const mateAt = (i: number): Point => ({ x: P.x + Math.floor(i / 4), y: P.y });

    /** WALK frames walking to P alone, the camera locked on us, then `cover` frames hidden under the teammate. */
    function coveredSpecs(cover: number, camera: (p: Point) => SceneSpec['camera'] = camOn): SceneSpec[] {
      const specs: SceneSpec[] = [];
      for (let i = 0; i < WALK; i++) specs.push({ ...BASE, self: selfAt(i), selfTrail: { x: -1, y: 0 }, camera: camera(selfAt(i)) });
      for (let i = 0; i < cover; i++) specs.push({ ...BASE, self: null, allies: [mateAt(i)], camera: camera(mateAt(i)) });
      return specs;
    }

    async function drive(
      specs: SceneSpec[],
      mate: (frame: number) => Point | null,
      self: (frame: number) => Point | null = () => null,
      at: Record<number, (h: any) => void> = {},
    ) {
      const scenes = renderScenes(specs);
      let frame = 0;
      const classifier = new SkinVerdictScorer(
        () => { const p = self(frame); return p ? toFramePoint(p) : null; },
        () => { const m = frame >= WALK ? mate(frame) : null; return m ? [toFramePoint(m)] : []; },
      );
      const h = newTracker(scenes.map(sc => sc.frame), { classifier });
      const records = [];
      const events: Array<{ frame: number; line: string }> = [];
      for (let i = 0; i < scenes.length; i++) {
        frame = i;
        at[i]?.(h);
        const before = logs.length;
        records.push(...await driveTracker(h, [scenes[i]]));
        for (const line of logs.slice(before)) events.push({ frame: i, line });
      }
      return { records, h, events };
    }

    test('reports their spot as ours instead of nothing, following them', async () => {
      const specs = coveredSpecs(70);
      const { records } = await drive(specs, f => mateAt(f - WALK));
      for (let i = WALK; i < specs.length; i++) {
        expect(records[i].state).toBe(TrackingState.LOCKED);
        expect(distance(records[i].px!, mateAt(i - WALK))).toBeLessThanOrEqual(3);
      }
      expect(logs.some(l => l.includes('under a teammate'))).toBe(true);
      expect(logs.some(l => l.includes('is a teammate\'s (skin match)'))).toBe(false);
    });

    test('a camera that merely has them on screen does not count', async () => {
      // The camera parked on the spot all along, not following us there: no
      // sign it is locked on us, so the v0.5.21 rule stands.
      const specs = coveredSpecs(40, () => camOn(P));
      await drive(specs, f => mateAt(f - WALK));
      expect(logs.some(l => l.includes('under a teammate'))).toBe(false);
      expect(logs.some(l => l.includes('is a teammate\'s (skin match)'))).toBe(true);
    });

    // A recall puts a locked camera on the fountain, where the map's corner
    // cuts the rectangle off and it cannot be read; a pan leaves it readable
    // somewhere else. Either way the teammate's spot stops being ours.
    test.each([
      ['moves off (a pan)', { x: 200, y: 70 }, 2, 'the camera moved off them'],
      ['goes unreadable (a recall to the fountain)', { x: 262, y: 262 }, Math.ceil(OCCLUDER_GRACE_MS / FRAME_MS) + 2,
        'the camera is not readable'],
    ])('lets them go when the camera %s', async (_name, far, within, why) => {
      const specs = coveredSpecs(40);
      const moved = specs.length;
      for (let i = 40; i < 70; i++) specs.push({ ...BASE, self: null, allies: [mateAt(i)], camera: camOn(far) });
      const { records } = await drive(specs, f => mateAt(f - WALK));
      const late = records.slice(moved);
      const onMate = late.map(r => r.state === TrackingState.LOCKED && !!r.px && distance(r.px, mateAt(40)) <= 12);
      expect(onMate.lastIndexOf(true) + 1).toBeLessThanOrEqual(within);
      expect(logs.some(l => l.includes('Stopped following the teammate') && l.includes(why))).toBe(true);
    });

    test('takes ours back when they walk off it', async () => {
      const specs = coveredSpecs(40);
      const parted = specs.length;
      const away = (i: number): Point => ({ x: mateAt(40).x + 2 * i, y: P.y - i });
      for (let i = 0; i < 40; i++) specs.push({ ...BASE, self: mateAt(40), allies: [away(i)], camera: camOn(mateAt(40)) });
      const { records } = await drive(
        specs,
        f => (f < parted ? mateAt(f - WALK) : away(f - parted)),
        f => (f >= parted ? mateAt(40) : null),
      );
      const last = records[records.length - 1];
      expect(last.state).toBe(TrackingState.LOCKED);
      expect(distance(last.px!, mateAt(40)).toFixed(0)).toBe('0');
    });

    test('a skin match that keeps going unsure does not stretch it past the cap', async () => {
      // Ours gone for good, their icon on screen with the camera following
      // it, and the skin match unsure of them 2.5s out of every 6s. Each unsure
      // stretch used to hand their icon back to the locked path as ours, and
      // the next verdict started a fresh 10s cover. (Locking their icon again
      // while the skin match is unsure is v0.5.21's behaviour, not the cover's.)
      const FRAMES = Math.ceil(30_000 / FRAME_MS);
      const specs = coveredSpecs(FRAMES);
      const unsure = (f: number) => ((f - WALK) * FRAME_MS) % 6000 >= 3500;
      const { events } = await drive(specs, f => (unsure(f) ? null : mateAt(f - WALK)));
      const starts = events.filter(e => e.line.includes('under a teammate'));
      const capped = events.find(e => e.line.includes('Stopped following the teammate') && e.line.includes('cap'));
      expect(starts.length).toBeGreaterThan(0);
      expect(capped).toBeDefined();
      expect((capped!.frame - starts[0].frame) * FRAME_MS).toBeLessThanOrEqual(MAX_OCCLUDED_MS + 2 * FRAME_MS);
      expect(starts.filter(e => e.frame > capped!.frame)).toEqual([]);
    });

    test('a death under them keeps the spot where ours went under, not where they walked to', async () => {
      const specs = coveredSpecs(80);
      const deathAt = WALK + 79;
      const { h } = await drive(specs, f => mateAt(f - WALK), () => null, { [deathAt]: (hh: any) => hh.svc.onDeath() });
      const lastSeen = h.svc.getLastPosition()!;
      const startedAt = truthToGame(mateAt(0));
      const walkedTo = truthToGame(mateAt(79));
      expect(Math.hypot(lastSeen.x - startedAt.x, lastSeen.y - startedAt.y))
        .toBeLessThan(Math.hypot(lastSeen.x - walkedTo.x, lastSeen.y - walkedTo.y));
    });
  });

  test('walking past where an enemy covers us does not end the cover hold', async () => {
    // We walk under an enemy's icon (the hold that keeps us where we went out
    // of sight), then a teammate the skin match knows settles beside it. The
    // teammate is not the icon we follow — ours is under the enemy — so the
    // lock must not be dropped (v0.5.21 review: it was, for team-only audio
    // in the middle of a fight).
    const E: Point = { x: 150, y: 140 };
    const specs: SceneSpec[] = [];
    for (let d = 60; d > 0; d--) specs.push({ ...BACKDROP, self: { x: E.x - d, y: E.y }, selfTrail: { x: -1, y: 0 }, enemiesOnTop: [E] });
    const covered = specs.length;
    const mateAt = (i: number): Point => ({ x: Math.max(E.x + 20, E.x + 40 - 2 * i), y: E.y });
    for (let i = 0; i < 30; i++) specs.push({ ...BACKDROP, self: E, enemiesOnTop: [E], allies: [...BACKDROP.allies!, mateAt(i)] });
    const scenes = renderScenes(specs);
    let frame = 0;
    const classifier = new SkinVerdictScorer(
      () => (frame < covered ? toFramePoint(specs[frame].self!) : null),
      () => (frame >= covered ? [toFramePoint(mateAt(frame - covered))] : []),
    );
    const h = newTracker(scenes.map(s => s.frame), { classifier });
    const records = [];
    for (let i = 0; i < scenes.length; i++) {
      frame = i;
      records.push(...await driveTracker(h, [scenes[i]]));
    }
    for (const r of records.slice(covered)) {
      expect(r.state).toBe(TrackingState.LOCKED);
      expect(distance(r.px!, E)).toBeLessThanOrEqual(4);
    }
    expect(logs.some(l => l.includes('is a teammate\'s (skin match)'))).toBe(false);
  });
});
