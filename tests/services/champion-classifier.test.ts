// onnxruntime-web pulls in browser-only globals at import time (WebAssembly
// loaders, `self`, etc) that crash under jest's node environment. The code
// under test only needs `env.wasm` to exist and `Tensor` to be constructible —
// mock the module so the import is inert and the tensor handed to the session
// is inspectable.
jest.mock('onnxruntime-web', () => ({
  env: { wasm: { numThreads: 1, wasmPaths: '', proxy: false } },
  InferenceSession: { create: jest.fn() },
  Tensor: class {
    constructor(
      public type: string,
      public data: Float32Array,
      public dims: number[],
    ) {}
  },
}));

import {
  ChampionClassifier,
  packCropsToNCHW,
  localClassProbs,
} from '../../src/services/champion-classifier';
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

/** A 32x32 RGBA crop of one constant colour. */
function solidCrop(r: number, g: number, b: number): { data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { data };
}

describe('packCropsToNCHW', () => {
  test('writes each sample at its own stride, planar RGB, /255', () => {
    const out = packCropsToNCHW([solidCrop(255, 0, 0), solidCrop(0, 128, 255)]);

    expect(out.length).toBe(2 * 3 * 1024);

    // Sample 0 — pure red.
    expect(out[0]).toBe(1);
    expect(out[1023]).toBe(1);
    expect(out[1024]).toBe(0);
    expect(out[2048]).toBe(0);

    // Sample 1 starts at 3072; before batching there was no sample stride at
    // all, so a second crop overwrote the first.
    expect(out[3072]).toBe(0);
    expect(out[3072 + 1024]).toBeCloseTo(128 / 255, 6);
    expect(out[3072 + 2048]).toBe(1);
  });

  test('throws on a wrong-sized crop rather than packing garbage', () => {
    expect(() => packCropsToNCHW([{ data: new Uint8ClampedArray(16) }])).toThrow(/expected 4096/);
  });

  test('throws on an empty batch', () => {
    expect(() => packCropsToNCHW([])).toThrow();
  });
});

describe('localClassProbs', () => {
  /** Independent scalar softmax of one row, for comparison. */
  function rowSoftmax(row: number[], idx: number): number {
    const max = Math.max(...row);
    const exps = row.map((v) => Math.exp(v - max));
    return exps[idx] / exps.reduce((a, b) => a + b, 0);
  }

  test('softmaxes each row independently, not the whole buffer', () => {
    const rows = [
      [0, 1, 2, 3],
      [5, 0, 0, 0],
      [1, 1, 1, 1],
    ];
    const logits = new Float32Array(rows.flat());

    const got = localClassProbs(logits, 3, 0);

    expect(got).toHaveLength(3);
    got.forEach((v, r) => expect(v).toBeCloseTo(rowSoftmax(rows[r], 0), 6));
    // Row 1 peaks at the local index; a whole-buffer softmax would divide by
    // the sum over all 12 logits and land visibly lower.
    expect(got[1]).toBeGreaterThan(0.9);
  });

  test('throws when the buffer does not divide into rows', () => {
    expect(() => localClassProbs(new Float32Array(7), 2, 0)).toThrow(/do not divide/);
  });

  test('throws when the class index is outside the row', () => {
    expect(() => localClassProbs(new Float32Array(8), 2, 4)).toThrow(/outside/);
  });
});

describe('ChampionClassifier.scoreCrops', () => {
  type FakeTensor = { dims: number[]; data: Float32Array };

  /**
   * Build a classifier with a fake session. `makeLogits` receives the packed
   * input tensor so a test can make each row depend on its own crop.
   */
  function withFakeSession(
    localClassIndex: number,
    makeLogits: (input: { data: Float32Array; dims: number[] }) => FakeTensor,
  ) {
    const run = jest.fn(async (feeds: { input: { data: Float32Array; dims: number[] } }) => ({
      logits: makeLogits(feeds.input),
    }));
    const c = new ChampionClassifier();
    (c as unknown as { session: unknown }).session = { run };
    (c as unknown as { localClassIndex: number }).localClassIndex = localClassIndex;
    return { c, run };
  }

  /** Row r gets its peak at class (r % numClasses). */
  function diagonalLogits(batch: number, numClasses: number): FakeTensor {
    const data = new Float32Array(batch * numClasses);
    for (let r = 0; r < batch; r++) data[r * numClasses + (r % numClasses)] = 10;
    return { dims: [batch, numClasses], data };
  }

  test('runs ONE inference for many crops and returns one score per crop', async () => {
    const { c, run } = withFakeSession(0, (input) => diagonalLogits(input.dims[0], 4));
    const crops = Array.from({ length: 10 }, (_, i) => solidCrop(i, i, i));

    const scores = await c.scoreCrops(crops);

    expect(run).toHaveBeenCalledTimes(1);
    const tensor = run.mock.calls[0][0].input;
    expect(tensor.dims).toEqual([10, 3, 32, 32]);
    expect(tensor.data.length).toBe(10 * 3 * 1024);
    expect(scores).toHaveLength(10);
    scores.forEach((s) => expect(Number.isFinite(s)).toBe(true));
  });

  test('scores stay in crop order (row offsets are not shuffled)', async () => {
    // Row r peaks at class r % 4, so with localClassIndex=1 only crops 1, 5 and
    // 9 should score high. A row-offset bug moves the peaks.
    const { c } = withFakeSession(1, (input) => diagonalLogits(input.dims[0], 4));
    const crops = Array.from({ length: 8 }, (_, i) => solidCrop(i, 0, 0));

    const scores = await c.scoreCrops(crops);

    scores.forEach((s, i) => {
      if (i % 4 === 1) expect(s).toBeGreaterThan(0.9);
      else expect(s).toBeLessThan(0.1);
    });
  });

  test('a single crop batched matches the same crop scored alone', async () => {
    const makeLogits = (input: { data: Float32Array; dims: number[] }): FakeTensor => {
      // Each row's logits derive only from that row's own packed pixels.
      const batch = input.dims[0];
      const data = new Float32Array(batch * 3);
      for (let r = 0; r < batch; r++) {
        const base = r * 3 * 1024;
        data[r * 3] = input.data[base] * 10;
        data[r * 3 + 1] = input.data[base + 1024] * 10;
        data[r * 3 + 2] = input.data[base + 2048] * 10;
      }
      return { dims: [batch, 3], data };
    };
    const a = solidCrop(255, 0, 0);
    const b = solidCrop(0, 255, 0);
    const c3 = solidCrop(0, 0, 255);

    const batched = await withFakeSession(1, makeLogits).c.scoreCrops([a, b, c3]);
    const singles = [
      await withFakeSession(1, makeLogits).c.scoreCrops([a]),
      await withFakeSession(1, makeLogits).c.scoreCrops([b]),
      await withFakeSession(1, makeLogits).c.scoreCrops([c3]),
    ].flat();

    batched.forEach((v, i) => expect(v).toBeCloseTo(singles[i], 10));
  });

  test('returns zeros of the right length when the model is not loaded', async () => {
    const c = new ChampionClassifier();
    await expect(c.scoreCrops([solidCrop(1, 1, 1), solidCrop(2, 2, 2)])).resolves.toEqual([0, 0]);
  });

  test('never runs inference for an empty blob list', async () => {
    const { c, run } = withFakeSession(0, (input) => diagonalLogits(input.dims[0], 4));
    await expect(c.scoreCrops([])).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  // A short or transposed output must NOT come back as a short array: the
  // caller indexes it positionally against its blob list, so `undefined` would
  // reach the EMA and cache NaN forever. Throwing lands in tracking.ts's catch
  // and leaves the prior scores intact.
  test('throws on a batch-dimension mismatch instead of returning a short array', async () => {
    const { c } = withFakeSession(0, () => ({ dims: [3, 4], data: new Float32Array(12) }));
    await expect(c.scoreCrops(Array.from({ length: 10 }, () => solidCrop(1, 1, 1))))
      .rejects.toThrow(/logits dims/);
  });

  test('throws when the model output is renamed', async () => {
    const run = jest.fn(async () => ({ output: { dims: [1, 4], data: new Float32Array(4) } }));
    const c = new ChampionClassifier();
    (c as unknown as { session: unknown }).session = { run };
    (c as unknown as { localClassIndex: number }).localClassIndex = 0;

    await expect(c.scoreCrops([solidCrop(1, 1, 1)])).rejects.toThrow(/"logits" missing/);
  });

  test('throws when the model class count disagrees with the label map', async () => {
    const { c } = withFakeSession(0, (input) => diagonalLogits(input.dims[0], 4));
    (c as unknown as { labelMap: Record<string, string> }).labelMap = { '0': 'Ahri', '1': 'Ashe' };

    await expect(c.scoreCrops([solidCrop(1, 1, 1)])).rejects.toThrow(/label map/);
  });
});
