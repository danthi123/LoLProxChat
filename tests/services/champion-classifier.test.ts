// onnxruntime-web pulls in browser-only globals at import time (WebAssembly
// loaders, `self`, etc) that crash under jest's node environment. The
// resolver under test doesn't touch any of that surface — mock the entire
// module so the import is inert.
jest.mock('onnxruntime-web', () => ({
  env: { wasm: { numThreads: 1, wasmPaths: '', proxy: false } },
  InferenceSession: { create: jest.fn() },
}));

import { ChampionClassifier } from '../../src/services/champion-classifier';
import labelMapRaw from '../../models/champion_labels.json';
const labelMap: Record<string, string> = labelMapRaw as Record<string, string>;
const resolve = (name: string) => ChampionClassifier.resolveLocalClassIndex(labelMap, name);

describe('ChampionClassifier.resolveLocalClassIndex', () => {
  test('matches exact label, case-insensitive', () => {
    expect(resolve('Ahri')).toBeGreaterThanOrEqual(0);
    expect(resolve('ahri')).toBeGreaterThanOrEqual(0);
  });

  test('returns -1 for unknown champion', () => {
    expect(resolve('NotAChampion')).toBe(-1);
  });

  // Regression coverage for issue #7. The LCU Live Client Data API returns
  // display names ("Nunu & Willump", "Dr. Mundo") but the scraper sanitizes
  // them into the labels ("Nunu _ Willump", "Dr_ Mundo"). resolveLocalClassIndex
  // normalizes both sides identically; without that localClassIndex was -1 and
  // every blob scored 0.0 → CV never recovered.
  test.each([
    ['Nunu & Willump', 'Nunu _ Willump'],
    ['Dr. Mundo', 'Dr_ Mundo'],
  ])('LCU display name %p resolves to label %p', (displayName, expectedLabel) => {
    const idx = resolve(displayName);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(labelMap[String(idx)]).toBe(expectedLabel);
  });

  // Apostrophes are inside the allowed set, so they survive normalization on
  // both sides and these resolve with no special-casing.
  test.each(["Cho'Gath", "Kai'Sa", "Kha'Zix", "Vel'Koz", "Kog'Maw"])(
    'apostrophe champion %p resolves',
    (name) => {
      expect(resolve(name)).toBeGreaterThanOrEqual(0);
    },
  );

  // Wukong's display name matches its label directly. Some LCU endpoints (champ
  // select / queue) return the internal "MonkeyKing" instead; if a code path
  // ever passes that, it'd need a DISPLAY_TO_LABEL_NAME entry — this guards the
  // common live-game case where the display name is "Wukong".
  test('Wukong resolves directly', () => {
    expect(resolve('Wukong')).toBeGreaterThanOrEqual(0);
  });
});
