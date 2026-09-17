import * as ort from 'onnxruntime-web';
import type { CaptureFrame } from '../core/capture-frame';

// Threads stay at 1: onnxruntime-web needs SharedArrayBuffer, which needs the
// page to be cross-origin isolated, and the WebView2 custom-protocol origin
// ships no COOP/COEP headers. Raising this without those headers either throws
// at session create or silently falls back.
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = '/background/';
ort.env.wasm.proxy = false;

// LCU returns champion *display* names ("Nunu & Willump", "Dr. Mundo"); the
// classifier label file is keyed by the scraper's sanitized folder names, which
// replace every character outside [A-Za-z0-9 space ' -] with "_" (so the labels
// read "Nunu _ Willump", "Dr_ Mundo"). `resolveLocalClassIndex` normalizes BOTH
// sides the same way before matching, so punctuation differences line up on
// their own. This was the root cause of issue #7: a raw exact-match left
// localClassIndex=-1 and EVERY blob scored 0.0 forever for a Nunu player.
//
// DISPLAY_TO_LABEL_NAME is the escape hatch for the rarer case where an LCU
// display name differs from the asset name by more than punctuation — none
// currently, since normalization covers the known cases. Keys pre-lowercased.
const DISPLAY_TO_LABEL_NAME: Record<string, string> = {};

/** The model's input geometry: [N, 3, 32, 32], RGBA source crops. */
const CROP_SIZE = 32;
const CROP_PIXELS = CROP_SIZE * CROP_SIZE;
const CROP_BYTES = CROP_PIXELS * 4;

/** Anything with an RGBA byte buffer of one 32x32 crop — `ImageData` qualifies. */
export interface ClassifierCrop {
  data: Uint8ClampedArray;
}

/** Mirror the scraper's safeDir() so LCU names line up with label folders. */
function normalizeChampionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 '-]/g, '_').trim().toLowerCase();
}

/**
 * Pack N RGBA crops into one planar NCHW float tensor buffer, normalized to
 * [0, 1]. Sample `s` occupies `[s*3072, (s+1)*3072)` as R plane, G plane, B
 * plane; alpha is dropped. The /255-only normalization (no mean/std) is baked
 * into the trained weights and must not change.
 *
 * Throws rather than producing a mis-shaped tensor: a wrong-sized crop would
 * otherwise yield a garbage batch that still scores plausibly.
 */
export function packCropsToNCHW(crops: ClassifierCrop[]): Float32Array {
  if (crops.length === 0) throw new Error('packCropsToNCHW: no crops');
  const out = new Float32Array(crops.length * 3 * CROP_PIXELS);
  for (let s = 0; s < crops.length; s++) {
    const src = crops[s].data;
    if (src.length !== CROP_BYTES) {
      throw new Error(
        `packCropsToNCHW: crop ${s} has ${src.length} bytes, expected ${CROP_BYTES} ` +
        `(${CROP_SIZE}x${CROP_SIZE} RGBA)`,
      );
    }
    const base = s * 3 * CROP_PIXELS;
    for (let i = 0; i < CROP_PIXELS; i++) {
      const si = i * 4;
      out[base + i] = src[si] / 255;
      out[base + CROP_PIXELS + i] = src[si + 1] / 255;
      out[base + 2 * CROP_PIXELS + i] = src[si + 2] / 255;
    }
  }
  return out;
}

/**
 * Row-wise softmax over a flat [batchSize, numClasses] logits buffer, returning
 * the local champion's probability for each row. Rows are independent — a
 * whole-array softmax would divide every row by the batch's total and shrink
 * every score as the batch grows.
 *
 * Throws on a mis-shaped buffer instead of returning zeros: zeros are
 * indistinguishable from the "no blob matches" state after the caller's
 * MIN_RAW_THRESHOLD normalization (the issue #7 signature), while a throw is
 * caught in tracking.ts and leaves the prior EMA scores intact.
 */
export function localClassProbs(
  logits: Float32Array,
  batchSize: number,
  localClassIndex: number,
): number[] {
  if (batchSize <= 0) throw new Error('localClassProbs: batchSize must be positive');
  if (logits.length % batchSize !== 0) {
    throw new Error(
      `localClassProbs: ${logits.length} logits do not divide into ${batchSize} rows`,
    );
  }
  const numClasses = logits.length / batchSize;
  if (localClassIndex < 0 || localClassIndex >= numClasses) {
    throw new Error(
      `localClassProbs: class index ${localClassIndex} outside [0, ${numClasses})`,
    );
  }

  const scores: number[] = [];
  for (let r = 0; r < batchSize; r++) {
    const base = r * numClasses;
    let maxLogit = -Infinity;
    for (let i = 0; i < numClasses; i++) {
      if (logits[base + i] > maxLogit) maxLogit = logits[base + i];
    }
    let sumExp = 0;
    let localExp = 0;
    for (let i = 0; i < numClasses; i++) {
      const exp = Math.exp(logits[base + i] - maxLogit);
      sumExp += exp;
      if (i === localClassIndex) localExp = exp;
    }
    scores.push(localExp / sumExp);
  }
  return scores;
}

/** A blob's crop box in capture-frame pixels, padded by the caller. */
export interface BlobCropBox {
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
}

/**
 * What the tracker needs of a classifier. Taking a CaptureFrame rather than an
 * ImageData keeps the whole CV pipeline free of DOM types: the crop path is the
 * only stage that needs a canvas, so the conversion belongs on this side of the
 * interface, not in the caller.
 */
export interface BlobScorer {
  isLoaded(): boolean;
  scoreBlobsForLocalChampion(frame: CaptureFrame, blobs: BlobCropBox[]): Promise<number[]>;
}

export class ChampionClassifier implements BlobScorer {
  private session: ort.InferenceSession | null = null;
  private labelMap: Record<string, string> = {};
  private localClassIndex = -1;

  // Reusable canvases for crop+resize (avoid GC churn). Both are created on
  // first use so the class stays constructible without a DOM.
  private srcCanvas: HTMLCanvasElement | null = null;
  private cropCanvas: HTMLCanvasElement | null = null;

  async load(modelUrl: string, labelMapUrl: string, localChampionName: string): Promise<void> {
    console.log('[Classifier] Loading ONNX model:', modelUrl);

    const resp = await fetch(labelMapUrl);
    this.labelMap = await resp.json();

    this.localClassIndex = ChampionClassifier.resolveLocalClassIndex(this.labelMap, localChampionName);
    if (this.localClassIndex >= 0) {
      console.log('[Classifier] Local champion:', localChampionName,
        '→ matched label "' + this.labelMap[String(this.localClassIndex)] + '"',
        'classIndex:', this.localClassIndex);
    } else {
      // Log available labels to help debug name mismatch
      const allLabels = Object.values(this.labelMap).join(', ');
      console.error('[Classifier] FAILED to match champion "' + localChampionName + '"' +
        ' in label map! All scores will be 0. Available labels: ' + allLabels);
    }

    this.session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
    });
    console.log('[Classifier] Model loaded, numClasses=' +
      Object.keys(this.labelMap).length +
      ', localClassIndex=' + this.localClassIndex);
  }

  isLoaded(): boolean {
    return this.session !== null;
  }

  /**
   * Pure function — exposed for testing. Returns -1 if no match found.
   * Normalizes the LCU name and each label the same way (mirroring the
   * scraper's folder sanitization) so punctuation lines up; DISPLAY_TO_LABEL_NAME
   * is applied first for any non-punctuation display/asset mismatch.
   */
  static resolveLocalClassIndex(
    labelMap: Record<string, string>,
    localChampionName: string,
  ): number {
    const mapped = DISPLAY_TO_LABEL_NAME[localChampionName.toLowerCase()] ?? localChampionName;
    const needle = normalizeChampionName(mapped);
    for (const [idx, name] of Object.entries(labelMap)) {
      if (normalizeChampionName(name) === needle) return parseInt(idx);
    }
    return -1;
  }

  /**
   * Score already-cropped 32x32 RGBA icons in ONE inference. DOM-free.
   *
   * The graph declares a symbolic batch axis on both `input` and `logits` and
   * contains no BatchNormalization, Dropout or other cross-sample op, so a
   * batched run is per-sample identical to N single runs.
   *
   * Returns exactly `crops.length` scores, in crop order, or throws. Callers
   * index the result positionally against their blob list, so a short array
   * would feed `undefined` into the EMA and cache NaN forever.
   */
  async scoreCrops(crops: ClassifierCrop[]): Promise<number[]> {
    if (crops.length === 0) return [];
    if (!this.session || this.localClassIndex < 0) return crops.map(() => 0);

    const inputTensor = new ort.Tensor('float32', packCropsToNCHW(crops), [
      crops.length, 3, CROP_SIZE, CROP_SIZE,
    ]);
    const results = await this.session.run({ input: inputTensor });

    // Validate against the output's own dims rather than inferring the class
    // count from the buffer length: a renamed or transposed output would
    // otherwise mis-align every row and silently score every blob wrong.
    const out = results.logits as ort.Tensor | undefined;
    if (!out) {
      throw new Error('[Classifier] model output "logits" missing: ' +
        Object.keys(results).join(', '));
    }
    const dims = out.dims;
    if (dims.length !== 2 || dims[0] !== crops.length) {
      throw new Error('[Classifier] expected logits dims [' + crops.length +
        ', numClasses], got [' + dims.join(', ') + ']');
    }
    const numLabels = Object.keys(this.labelMap).length;
    if (numLabels > 0 && dims[1] !== numLabels) {
      throw new Error('[Classifier] model emits ' + dims[1] + ' classes but the label map has ' +
        numLabels);
    }

    return localClassProbs(out.data as Float32Array, crops.length, this.localClassIndex);
  }

  /**
   * Score multiple blobs: returns per-blob probability that the blob matches
   * the local player's champion (0.0 = no match, 1.0 = perfect match).
   */
  async scoreBlobsForLocalChampion(
    frame: CaptureFrame,
    blobs: BlobCropBox[],
  ): Promise<number[]> {
    // Before any canvas work: an unloaded classifier must not pay for N crops.
    if (!this.session || this.localClassIndex < 0) {
      return blobs.map(() => 0);
    }
    if (blobs.length === 0) return [];

    // The canvas will not take a raw RGBA buffer, and putImageData is how the
    // frame gets in. CaptureFrame's data is backed by a plain ArrayBuffer for
    // exactly this — see core/capture-frame.ts.
    const imageData = new ImageData(frame.data, frame.width, frame.height);

    // Prepare source canvas (reuse, resize only if dimensions changed)
    if (!this.srcCanvas || this.srcCanvas.width !== imageData.width || this.srcCanvas.height !== imageData.height) {
      this.srcCanvas = document.createElement('canvas');
      this.srcCanvas.width = imageData.width;
      this.srcCanvas.height = imageData.height;
    }
    const srcCtx = this.srcCanvas.getContext('2d', { willReadFrequently: true })!;
    srcCtx.putImageData(imageData, 0, 0);

    if (!this.cropCanvas) {
      this.cropCanvas = document.createElement('canvas');
      this.cropCanvas.width = CROP_SIZE;
      this.cropCanvas.height = CROP_SIZE;
    }
    const cropCtx = this.cropCanvas.getContext('2d', { willReadFrequently: true })!;

    const crops: ImageData[] = [];
    for (const blob of blobs) {
      cropCtx.clearRect(0, 0, CROP_SIZE, CROP_SIZE);
      cropCtx.drawImage(this.srcCanvas, blob.cropX, blob.cropY, blob.cropW, blob.cropH, 0, 0, CROP_SIZE, CROP_SIZE);
      crops.push(cropCtx.getImageData(0, 0, CROP_SIZE, CROP_SIZE));
    }

    return this.scoreCrops(crops);
  }
}
