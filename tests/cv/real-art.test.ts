// The occlusion scenarios again, on League's real Summoner's Rift minimap with
// real champion portraits inside the rings (see tests/cv/harness/real.ts).
//
// tracking-simulation.test.ts draws flat rings on flat fog. That leaves open
// whether any of it survives the real thing: river and jungle terrain, portrait
// art merging into or breaking up a border, and the red and blue structure
// icons baked into the map itself — exactly the "other red things near us"
// the occlusion check could mistake for an enemy champion.
//
// Riot's art is not committed, so this suite needs local fixtures:
//   npm run update-icons -- --limit 8   (or the full scrape)
//   python3 scripts/make-cv-fixtures.py
// Without them every test here is skipped, and the skip says why.

import { TrackingState } from '../../src/services/tracking';
import { driveTracker, newTracker } from './harness/drive';
import { ZeroScorer } from './harness/scorers';
import { ICON_DIAM, Point, SceneSpec, truthToGame } from './harness/scenes';
import { loadRealArt, renderReal } from './harness/real';

const art = loadRealArt();
const maybe = art ? describe : describe.skip;
if (!art) {
  // eslint-disable-next-line no-console
  console.warn('real-art.test.ts skipped: no fixtures. Run `npm run update-icons -- --limit 8` then `python3 scripts/make-cv-fixtures.py`.');
}

let logs: string[] = [];
beforeEach(() => {
  jest.useFakeTimers();
  logs = [];
  const rec = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  jest.spyOn(console, 'log').mockImplementation(rec);
  jest.spyOn(console, 'warn').mockImplementation(rec);
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const covering = (l: string) => l.includes('Own icon covered by an enemy icon');

// Mid-lane, on the river: the busiest background on the map.
const E: Point = { x: 140, y: 136 };
// Two allies and one enemy elsewhere, as in a real game.
const AROUND: SceneSpec = { allies: [{ x: 60, y: 60 }, { x: 40, y: 230 }], enemies: [{ x: 210, y: 70 }] };

function render(specs: SceneSpec[]) {
  return specs.map(s => renderReal(s, art!));
}

async function run(specs: SceneSpec[]) {
  const scenes = render(specs);
  const h = newTracker(scenes.map(s => s.frame), { classifier: new ZeroScorer() });
  return { h, records: await driveTracker(h, scenes) };
}

function slideUnder(speed: number, after: number, dir: Point = { x: 1, y: 0 }, extraOnTop: Point[] = []): SceneSpec[] {
  const specs: SceneSpec[] = [];
  for (let d = 60; d > 0; d -= speed) {
    specs.push({ ...AROUND, self: { x: E.x - dir.x * d, y: E.y - dir.y * d }, selfTrail: { x: -dir.x, y: -dir.y }, enemiesOnTop: [E, ...extraOnTop] });
  }
  for (let i = 0; i < after; i++) specs.push({ ...AROUND, self: E, enemiesOnTop: [E, ...extraOnTop] });
  return specs;
}

maybe('on the real minimap, with real portraits', () => {
  test('the tracker locks on and follows a walking champion', async () => {
    const specs = Array.from({ length: 60 }, (_, i) => ({
      ...AROUND, self: { x: 70 + i, y: 190 - i }, selfTrail: { x: -1, y: 1 },
    }));
    const { records } = await run(specs);
    const last = records[records.length - 1];
    expect(last.state).toBe(TrackingState.LOCKED);
    expect(distance(last.px!, last.truth!)).toBeLessThanOrEqual(4);
  });

  test.each([
    [0.5, { x: 1, y: 0 }], [1, { x: 1, y: 0 }], [2, { x: 1, y: 0 }],
    [1, { x: 0.7071, y: 0.7071 }], [1, { x: 0, y: -1 }],
  ])('walking under an enemy at %p px/frame (dir %j) holds without disowning', async (speed, dir) => {
    const { records } = await run(slideUnder(speed as number, 48, dir as Point));
    expect(logs.some(covering)).toBe(true);
    expect(records.slice(-40).every(r => r.holdSec === 0 && r.state === TrackingState.LOCKED)).toBe(true);
    expect(records.slice(-40).every(r => distance(r.px!, E) < 4)).toBe(true);
  });

  test('reports the true distance while the icons only partly overlap', async () => {
    // The uncovered part of our ring has its centroid pushed away from the
    // enemy — up to ~270 game units here, on each client, which dropped a pair
    // actually ~650 apart to half volume just before full overlap.
    const specs: SceneSpec[] = [];
    // From well clear, so the tracker has learnt what our whole icon looks like.
    for (let d = 60; d > 0; d -= 1) specs.push({ ...AROUND, self: { x: E.x - d, y: E.y }, selfTrail: { x: -1, y: 0 }, enemiesOnTop: [E] });
    const { records } = await run(specs);
    const eg = truthToGame(E);
    const partly = records.filter(r => r.truth && distance(r.truth, E) < ICON_DIAM * 0.9 && distance(r.truth, E) > 4 && r.holdSec === 0);
    expect(partly.length).toBeGreaterThan(5);
    for (const r of partly) {
      const t = truthToGame(r.truth!);
      const reported = Math.hypot(r.game!.x - eg.x, r.game!.y - eg.y);
      // ~110 is this scene's baseline error with no overlap at all (the trail
      // and portrait nudge the centroid ~2px); uncorrected, the gap grows to 350.
      expect(reported - Math.hypot(t.x - eg.x, t.y - eg.y)).toBeLessThan(130);
    }
  });

  test('a 2v1, two enemy icons touching over us', async () => {
    const { records } = await run(slideUnder(1, 40, { x: 1, y: 0 }, [{ x: E.x + ICON_DIAM * 0.8, y: E.y + 4 }]));
    expect(logs.some(covering)).toBe(true);
    expect(records.slice(-30).every(r => r.holdSec === 0)).toBe(true);
  });

  test('a recall beside an enemy is disowned', async () => {
    const NEAR: Point = { x: E.x + ICON_DIAM * 0.6, y: E.y };
    const walk = Array.from({ length: 16 }, (_, i) => ({ ...AROUND, self: { x: E.x - 30 + i * 2, y: E.y }, selfTrail: { x: -1, y: 0 } }));
    const stand = Array.from({ length: 64 }, () => ({ ...AROUND, self: E, enemies: [...AROUND.enemies!, NEAR] }));
    const gone = Array.from({ length: 24 }, () => ({ ...AROUND, self: null, enemies: [...AROUND.enemies!, NEAR] }));
    const { records } = await run([...walk, ...stand, ...gone]);
    expect(logs.some(covering)).toBe(false);
    expect(records[records.length - 1].holdSec).toBeGreaterThan(2);
  });

  test('a recall right next to an enemy turret is disowned', async () => {
    // The real map's red structure icons are the "other red things" the
    // occlusion check must not take for a champion. Top-right of this map
    // is the enemy base, dense with them.
    const TOWER_SIDE: Point = { x: 190, y: 55 };
    const walk = Array.from({ length: 24 }, (_, i) => ({ ...AROUND, enemies: [], self: { x: 160 + i * 1.25, y: 85 - i * 1.25 }, selfTrail: { x: -1, y: 1 } }));
    const stand = Array.from({ length: 64 }, () => ({ ...AROUND, enemies: [], self: TOWER_SIDE }));
    const gone = Array.from({ length: 24 }, () => ({ ...AROUND, enemies: [], self: null }));
    const { records } = await run([...walk, ...stand, ...gone]);
    expect(logs.some(covering)).toBe(false);
    expect(records[records.length - 1].holdSec).toBeGreaterThan(2);
  });

  test('walking through the enemy base never starts an episode', async () => {
    const specs = Array.from({ length: 90 }, (_, i) => ({
      ...AROUND, enemies: [], self: { x: 150 + i, y: 120 - i }, selfTrail: { x: -1, y: 1 },
    }));
    const { records } = await run(specs);
    expect(logs.some(covering)).toBe(false);
    expect(distance(records[records.length - 1].px!, records[records.length - 1].truth!)).toBeLessThanOrEqual(4);
  });
});
