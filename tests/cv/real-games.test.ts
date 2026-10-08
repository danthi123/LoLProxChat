// Real minimap icons from real games, against the skin matcher.
//
// Built by scripts/make-game-fixtures.py from testers' Debug zips: each patch
// is an own-team icon cut from a minimap snapshot, centred where tracking.ts
// centres it, and labelled with the teammate it is. The labels come from an
// independent implementation of the same correlation run with looser
// thresholds than the app's, then checked by eye on contact sheets and
// corrected (overrides.json) — including "nobody" for the turret and minion
// clusters the detector takes for icons. Icons that labelling could not call
// (mostly ones half under an enemy's) were labelled by eye where a person can
// tell whose they are: they are what the app's thresholds are there for.
// How much they guard is limited by the data: the score floor could drop to
// about 0.45 before a wrong name appears here (at 0.4, one turret is named),
// and the 0.2 margin is not exercised at all. Both stay set for icons and
// teammates this one game does not have.
//
// It also checks that the app's coarse-to-fine crop search decides exactly as
// an exhaustive search would: the shortcut must cost time, not answers. Riot's art is not committed, so
// tests/cv/fixtures-games/ is gitignored and this suite skips itself when it
// has not been built.
//
// What it guards: the TypeScript matcher, run exactly as the app runs it, on
// real minimap rendering — the thing the synthetic suites cannot show. A
// change to cropping, resampling, the search or the thresholds that makes it
// name the wrong teammate (or anyone, for a turret), or stop naming the right
// one, fails here. Its limits: four recordings of one 3v2 custom game, and
// rosters that offer every skin of each champion (the logs predate the skin
// line), which is harder than a real game but not the same.

import * as fs from 'fs';
import * as path from 'path';
import {
  MatchScore, TemplateSet, decideMatch, iconTemplates, matchIcon, normalizedInner, sampleSquare, whoseIcon,
} from '../../src/services/skin-matcher';
import { iconCropBox } from '../../src/services/tracking-helpers';

const DIR = path.join(__dirname, 'fixtures-games');

/** `label` is a roster alias, "nobody" for something that is not a teammate's
 *  icon, or "?" for one nobody has labelled yet (skipped). */
interface Patch { file: string; side: number; diam: number; cx: number; cy: number; label: string }
interface Game {
  zip: string;
  roster: Array<{ champion: string; alias: string; icons: string[] }>;
  icons: Record<string, [number, number]>;
  patches: Patch[];
}

function load(): Game[] | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')).games;
  } catch {
    return null;
  }
}

const games = load();
const maybe = games && games.length > 0 ? describe : describe.skip;
if (!games) {
  // eslint-disable-next-line no-console
  console.log('real-games: tests/cv/fixtures-games/ not built — run scripts/make-game-fixtures.py on Debug zips');
}

function templateSets(game: Game): TemplateSet[] {
  return game.roster.map(r => ({
    id: r.alias,
    vecs: r.icons.flatMap((f) => {
      const [w, h] = game.icons[f];
      const raw = fs.readFileSync(path.join(DIR, 'icons', f.replace(/\.png$/, '.rgba')));
      return iconTemplates(new Uint8Array(raw), w, h);
    }),
  }));
}

function patchFrame(p: Patch): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
  const raw = fs.readFileSync(path.join(DIR, 'patches', p.file));
  return { width: p.side, height: p.side, data: new Uint8ClampedArray(raw) as Uint8ClampedArray<ArrayBuffer> };
}

/** Every crop size and every offset within 2 px: what matchIcon approximates. */
function exhaustiveMatch(frame: ReturnType<typeof patchFrame>, cx: number, cy: number, diam: number, sets: TemplateSet[]): MatchScore[] {
  const best = sets.map(() => -Infinity);
  for (const k of [0.95, 1.05, 1.15]) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const v = normalizedInner(sampleSquare(frame.data, frame.width, frame.height, cx + dx, cy + dy, diam * k));
        sets.forEach((set, i) => {
          for (const t of set.vecs) {
            let s = 0;
            for (let j = 0; j < v.length; j++) s += v[j] * t[j];
            best[i] = Math.max(best[i], s);
          }
        });
      }
    }
  }
  return sets.map((set, i) => ({ id: set.id, score: best[i] })).sort((a, b) => b.score - a.score);
}

maybe('the skin matcher on real games\' icons', () => {
  // Jest fails a suite with no tests, so an unbuilt set still declares one.
  if (!games || games.length === 0) test.skip('tests/cv/fixtures-games/ not built', () => undefined);
  for (const game of games ?? []) {
    test(game.zip + ': the crop search decides as an exhaustive one would', () => {
      const sets = templateSets(game);
      const differ: string[] = [];
      for (const p of game.patches) {
        const frame = patchFrame(p);
        const box = iconCropBox(p.cx, p.cy, p.diam);
        const cx = box.cropX + box.cropW / 2;
        const cy = box.cropY + box.cropH / 2;
        const fast = decideMatch(matchIcon(frame, cx, cy, box.cropW, sets));
        const full = decideMatch(exhaustiveMatch(frame, cx, cy, box.cropW, sets));
        if (fast !== full) differ.push(p.file + ': ' + fast + ' vs ' + full);
      }
      expect(differ).toEqual([]);
    });

    test(game.zip + ': names the right teammate, and never the wrong one', () => {
      const sets = templateSets(game);
      let right = 0;
      let icons = 0;
      const wrong: string[] = [];
      for (const p of game.patches.filter(q => q.label !== '?')) {
        const who = whoseIcon(patchFrame(p), iconCropBox(p.cx, p.cy, p.diam), sets);
        if (p.label !== 'nobody') icons++;
        if (who === null) continue;
        if (who === p.label) right++;
        else wrong.push(p.file + ' -> ' + who + ' (is ' + p.label + ')');
      }
      // eslint-disable-next-line no-console
      console.log(game.zip + ': ' + right + '/' + icons + ' icons named, ' +
        game.patches.filter(q => q.label === 'nobody').length + ' non-icons, ' + wrong.length + ' wrong');
      expect(wrong).toEqual([]);
      // A third of these icons are half under an enemy's, so leaving some
      // undecided is right; naming 63-76% per recording is where it stands.
      expect(right / icons).toBeGreaterThanOrEqual(0.6);
    });
  }
});
