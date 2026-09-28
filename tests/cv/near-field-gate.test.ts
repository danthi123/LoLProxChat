// Proof that tests/cv/tracking-simulation.test.ts is not a rubber stamp.
//
// Its headline scenario — a loaded classifier scoring 0.000 on every blob —
// only means something if the same scenario would have FAILED before the
// v0.5.8 fix. So this file restores the pre-fix behaviour (the Phase-1
// classifier veto applied at every distance, with no near-field exemption) and
// asserts the tracker falls into the freeze the changelog describes:
// lock -> hold -> forced re-acquisition -> lock, with the broadcast position
// pinned at the lock point while the champion walks away from it.
//
// If this ever fails because the tracker copes without the exemption, the right
// response is to delete this file, not to repair it: it asserts a bug, and the
// bug being gone from another direction is good news.

import { driveTracker, metrics, newTracker } from './harness/drive';
import { ZeroScorer } from './harness/scorers';
import { Point, SceneSpec, renderScenes } from './harness/scenes';

jest.mock('../../src/services/tracking-helpers', () => ({
  ...jest.requireActual('../../src/services/tracking-helpers'),
  // The v0.5.8 gate: identity outranks continuity everywhere, so a blob sitting
  // 0px from the prediction is rejected when the classifier has nothing to say
  // about it.
  computeNearFieldPx: () => 0,
}));

const BACKDROP: SceneSpec = {
  allies: [{ x: 40, y: 45 }, { x: 250, y: 245 }],
  enemies: [{ x: 105, y: 35 }],
  camera: { x: 140, y: 30, w: 110, h: 80 },
};

const START: Point = { x: 60, y: 200 };
const STEP: Point = { x: 2, y: -1 };

let logs: string[];

beforeEach(() => {
  jest.useFakeTimers();
  logs = [];
  const record = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  jest.spyOn(console, 'log').mockImplementation(record);
  jest.spyOn(console, 'warn').mockImplementation(record);
  jest.spyOn(console, 'error').mockImplementation(record);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('with the pre-v0.5.8 gate restored, the same scenario freezes and re-acquires', async () => {
  const scenes = renderScenes(Array.from({ length: 60 }, (_, i) => ({
    ...BACKDROP,
    self: { x: START.x + STEP.x * i, y: START.y + STEP.y * i },
    selfTrail: { x: -STEP.x, y: -STEP.y },
  })));

  const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
  const m = metrics(await driveTracker(h, scenes));

  // The three symptoms from the v0.5.8 changelog, in the order a user meets
  // them: the dot stops moving, the tracker gives up and rescans, and the
  // coordinates it broadcast in between are far from where the champion is.
  expect(m.longestFrozenRun).toBeGreaterThan(10);
  expect(logs.some(l => l.includes('forcing re-acquisition'))).toBe(true);
  expect(m.maxErrorPx).toBeGreaterThan(20);
});
