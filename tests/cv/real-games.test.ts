// Real minimap icons from real games, against the skin matcher.
//
// Built by scripts/make-game-fixtures.py from testers' Debug zips: each patch
// is an own-team icon cut from a minimap snapshot and labelled with the
// teammate it is (by an independent implementation of the same correlation,
// with the labels checked by eye on the contact sheets the script writes).
// Riot's art is not committed, so tests/cv/fixtures-games/ is gitignored and
// this suite skips itself when it has not been built.
//
// What it guards: the TypeScript matcher, run exactly as the app runs it, on
// real minimap rendering — the thing the synthetic suites cannot show. A
// change to cropping, resampling or the thresholds that makes it name the
// wrong teammate, or stop naming the right one, fails here.

import * as fs from 'fs';
import * as path from 'path';
import { TemplateSet, decideMatch, iconTemplates, matchIcon } from '../../src/services/skin-matcher';

const DIR = path.join(__dirname, 'fixtures-games');

interface Patch { file: string; side: number; diam: number; label: string }
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

maybe('the skin matcher on real games\' icons', () => {
  for (const game of games ?? []) {
    test(game.zip + ': names the right teammate, and never the wrong one', () => {
      const sets: TemplateSet[] = game.roster.map(r => ({
        id: r.alias,
        vecs: r.icons.flatMap((f) => {
          const [w, h] = game.icons[f];
          const raw = fs.readFileSync(path.join(DIR, 'icons', f.replace(/\.png$/, '.rgba')));
          return iconTemplates(new Uint8Array(raw), w, h);
        }),
      }));
      let right = 0;
      const wrong: string[] = [];
      for (const p of game.patches) {
        const raw = fs.readFileSync(path.join(DIR, 'patches', p.file));
        const frame = { width: p.side, height: p.side, data: new Uint8ClampedArray(raw) as Uint8ClampedArray<ArrayBuffer> };
        const who = decideMatch(matchIcon(frame, p.side / 2, p.side / 2, p.diam, sets));
        if (who === p.label) right++;
        else if (who !== null) wrong.push(p.file + ' -> ' + who + ' (is ' + p.label + ')');
      }
      // eslint-disable-next-line no-console
      console.log(game.zip + ': ' + right + '/' + game.patches.length + ' named, ' + wrong.length + ' wrong');
      expect(wrong).toEqual([]);
      expect(right / game.patches.length).toBeGreaterThanOrEqual(0.85);
    });
  }
});
