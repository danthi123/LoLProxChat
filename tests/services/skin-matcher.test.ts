import {
  MATCH_MIN_MARGIN,
  MATCH_MIN_SCORE,
  SKIN_SELF_RAW,
  SkinAwareScorer,
  TemplateSet,
  championAlias,
  decideMatch,
  iconFilesForSkin,
  iconTemplates,
  matchIcon,
} from '../../src/services/skin-matcher';
import type { BlobCropBox, BlobScorer } from '../../src/services/champion-classifier';
import type { CaptureFrame } from '../../src/core/capture-frame';

const KAYN_LISTING = [
  'kayn_ass_circle_15.png', 'kayn_ass_circle_1.png', 'kayn_ass_circle.png',
  'kayn_circle_15.png', 'kayn_circle_1.png', 'kayn_circle_20.png', 'kayn_circle.png',
  'kayn_slay_circle_15.png', 'kayn_slay_circle.png', 'kayn_square.png',
].map(f => `<a href="${f}">${f}</a>`).join('\n');

describe('iconFilesForSkin', () => {
  test('the base skin, in every form the champion takes', () => {
    expect(iconFilesForSkin(KAYN_LISTING, 'Kayn', 0))
      .toEqual(['kayn_ass_circle.png', 'kayn_circle.png', 'kayn_slay_circle.png']);
  });

  test('a skin with its own icon', () => {
    expect(iconFilesForSkin(KAYN_LISTING, 'kayn', 15))
      .toEqual(['kayn_ass_circle_15.png', 'kayn_circle_15.png', 'kayn_slay_circle_15.png']);
  });

  test('a chroma wears its parent skin\'s icon', () => {
    // 17 has no icon of its own: the highest below it is 15.
    expect(iconFilesForSkin(KAYN_LISTING, 'kayn', 17))
      .toEqual(['kayn_ass_circle_15.png', 'kayn_circle_15.png', 'kayn_slay_circle_15.png']);
    // A form without the skin falls back within that form only.
    expect(iconFilesForSkin(KAYN_LISTING, 'kayn', 21))
      .toEqual(['kayn_ass_circle_15.png', 'kayn_circle_20.png', 'kayn_slay_circle_15.png']);
  });

  test('a numbered base icon counts as the base skin', () => {
    const gwen = '<a href="gwen_circle_0.png"></a><a href="gwen_circle_11.png"></a>';
    expect(iconFilesForSkin(gwen, 'gwen', 0)).toEqual(['gwen_circle_0.png']);
    expect(iconFilesForSkin(gwen, 'gwen', 12)).toEqual(['gwen_circle_11.png']);
  });

  test('another champion\'s files, and nothing at all, give nothing', () => {
    expect(iconFilesForSkin(KAYN_LISTING, 'gwen', 0)).toEqual([]);
    expect(iconFilesForSkin('', 'kayn', 0)).toEqual([]);
  });
});

describe('championAlias', () => {
  test('from rawChampionName when there is one', () => {
    expect(championAlias('game_character_displayname_MonkeyKing', 'Wukong')).toBe('monkeyking');
  });
  test('otherwise from the display name', () => {
    expect(championAlias(undefined, "Kai'Sa")).toBe('kaisa');
    expect(championAlias('', 'Lee Sin')).toBe('leesin');
  });
});

// ---------- Matching, on synthetic icons ----------

const ICON = 120;
type Pattern = (x: number, y: number) => [number, number, number];

/** A 120px RGBA circle icon painted with `pattern`, transparent corners. */
function icon(pattern: Pattern): Uint8ClampedArray {
  const out = new Uint8ClampedArray(ICON * ICON * 4);
  const c = (ICON - 1) / 2;
  for (let y = 0; y < ICON; y++) {
    for (let x = 0; x < ICON; x++) {
      const i = (y * ICON + x) * 4;
      if (Math.hypot(x - c, y - c) > ICON / 2) continue;
      const [r, g, b] = pattern(x / ICON, y / ICON);
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
    }
  }
  return out;
}

const PATTERNS: Record<string, Pattern> = {
  me: (x, y) => [230 * x, 60, 230 * y],
  mate: (x, y) => [40, 200 * (1 - y), Math.sin(x * 12) * 100 + 120],
  other: (x, y) => [Math.cos(y * 9) * 100 + 120, 220 * x * y, 50],
};

/** A minimap-ish frame with `who`'s icon drawn at `diam` px, with a teal ring,
 *  centred at (cx, cy), darkened the way the minimap draws it. */
function frameWith(who: string | null, cx: number, cy: number, diam: number): CaptureFrame {
  const W = 120;
  const data = new Uint8ClampedArray(W * W * 4);
  for (let i = 0; i < W * W; i++) { data[i * 4] = 70; data[i * 4 + 1] = 78; data[i * 4 + 2] = 58; data[i * 4 + 3] = 255; }
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const i = (y * W + x) * 4;
      if (d <= diam / 2 && d > diam / 2 - 2) { data[i] = 40; data[i + 1] = 200; data[i + 2] = 190; continue; }
      if (d > diam / 2 - 2 || !who) continue;
      const u = (x - cx) / diam + 0.5;
      const v = (y - cy) / diam + 0.5;
      const [r, g, b] = PATTERNS[who](u, v);
      data[i] = r * 0.7; data[i + 1] = g * 0.7; data[i + 2] = b * 0.7;
    }
  }
  return { width: W, height: W, data: data as Uint8ClampedArray<ArrayBuffer> };
}

function sets(...ids: string[]): TemplateSet[] {
  return ids.map(id => ({ id, vecs: iconTemplates(icon(PATTERNS[id]), ICON, ICON) }));
}

describe('matchIcon and decideMatch', () => {
  test('picks the teammate whose icon it is, clearly, a pixel or two off centre', () => {
    const ranked = matchIcon(frameWith('mate', 61.5, 58, 29), 60, 60, 29, sets('me', 'mate', 'other'));
    expect(ranked[0].id).toBe('mate');
    expect(ranked[0].score).toBeGreaterThanOrEqual(MATCH_MIN_SCORE);
    expect(ranked[0].score - ranked[1].score).toBeGreaterThanOrEqual(MATCH_MIN_MARGIN);
    expect(decideMatch(ranked)).toBe('mate');
  });

  test('an empty ring decides nothing', () => {
    expect(decideMatch(matchIcon(frameWith(null, 60, 60, 29), 60, 60, 29, sets('me', 'mate')))).toBeNull();
  });

  test('needs both a high score and a margin', () => {
    expect(decideMatch([{ id: 'a', score: 0.59 }, { id: 'b', score: 0 }])).toBeNull();
    expect(decideMatch([{ id: 'a', score: 0.9 }, { id: 'b', score: 0.71 }])).toBeNull();
    expect(decideMatch([{ id: 'a', score: 0.9 }, { id: 'b', score: 0.69 }])).toBe('a');
    expect(decideMatch([{ id: 'a', score: 0.9 }])).toBe('a');
    expect(decideMatch([])).toBeNull();
  });
});

describe('SkinAwareScorer', () => {
  const box = (cx: number, cy: number, side = 29): BlobCropBox =>
    ({ cropX: Math.round(cx - side / 2), cropY: Math.round(cy - side / 2), cropW: side, cropH: side });
  const model = (score: number): BlobScorer => ({
    isLoaded: () => true,
    scoreBlobsForLocalChampion: async (_f, blobs) => blobs.map(() => score),
  });

  test('vouches for our icon, rules out a teammate\'s, and defers to the model otherwise', async () => {
    const scorer = new SkinAwareScorer('me', model(0.02));
    scorer.setTemplates(sets('me', 'mate'));
    expect(await scorer.scoreBlobsForLocalChampion(frameWith('me', 60, 60, 29), [box(60, 60)])).toEqual([SKIN_SELF_RAW]);
    expect(await scorer.scoreBlobsForLocalChampion(frameWith('mate', 60, 60, 29), [box(60, 60)])).toEqual([0]);
    expect(await scorer.scoreBlobsForLocalChampion(frameWith(null, 60, 60, 29), [box(60, 60)])).toEqual([0.02]);
  });

  test('works before the model has loaded', async () => {
    const scorer = new SkinAwareScorer('me');
    expect(scorer.isLoaded()).toBe(false);
    scorer.setTemplates(sets('me', 'mate'));
    expect(scorer.isLoaded()).toBe(true);
    expect(await scorer.scoreBlobsForLocalChampion(frameWith('me', 60, 60, 29), [box(60, 60)])).toEqual([SKIN_SELF_RAW]);
  });

  test('without our own icon among the templates, matches vouch for no one', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const scorer = new SkinAwareScorer('me', model(0.3));
    scorer.setTemplates(sets('mate', 'other'));
    expect(await scorer.scoreBlobsForLocalChampion(frameWith('mate', 60, 60, 29), [box(60, 60)])).toEqual([0.3]);
    jest.restoreAllMocks();
  });
});
