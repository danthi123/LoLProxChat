import * as ort from 'onnxruntime-web';

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

/** Mirror the scraper's safeDir() so LCU names line up with label folders. */
function normalizeChampionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 '-]/g, '_').trim().toLowerCase();
}

export class ChampionClassifier {
  private session: ort.InferenceSession | null = null;
  private labelMap: Record<string, string> = {};
  private localClassIndex = -1;

  // Reusable canvases for crop+resize (avoid GC churn)
  private srcCanvas: HTMLCanvasElement | null = null;
  private cropCanvas: HTMLCanvasElement;

  constructor() {
    this.cropCanvas = document.createElement('canvas');
    this.cropCanvas.width = 32;
    this.cropCanvas.height = 32;
  }

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
   * Score multiple blobs: returns per-blob probability that the blob matches
   * the local player's champion (0.0 = no match, 1.0 = perfect match).
   */
  async scoreBlobsForLocalChampion(
    imageData: ImageData,
    blobs: Array<{ cropX: number; cropY: number; cropW: number; cropH: number }>,
  ): Promise<number[]> {
    if (!this.session || this.localClassIndex < 0) {
      return blobs.map(() => 0);
    }

    // Prepare source canvas (reuse, resize only if dimensions changed)
    if (!this.srcCanvas || this.srcCanvas.width !== imageData.width || this.srcCanvas.height !== imageData.height) {
      this.srcCanvas = document.createElement('canvas');
      this.srcCanvas.width = imageData.width;
      this.srcCanvas.height = imageData.height;
    }
    const srcCtx = this.srcCanvas.getContext('2d', { willReadFrequently: true })!;
    srcCtx.putImageData(imageData, 0, 0);

    const cropCtx = this.cropCanvas.getContext('2d', { willReadFrequently: true })!;
    const scores: number[] = [];

    for (const blob of blobs) {
      // Crop + resize to 32x32
      cropCtx.clearRect(0, 0, 32, 32);
      cropCtx.drawImage(this.srcCanvas, blob.cropX, blob.cropY, blob.cropW, blob.cropH, 0, 0, 32, 32);
      const resized = cropCtx.getImageData(0, 0, 32, 32);

      // Convert to float32 tensor [1, 3, 32, 32] normalized [0, 1]
      const float32Data = new Float32Array(3 * 32 * 32);
      for (let i = 0; i < 1024; i++) {
        const si = i * 4;
        float32Data[i] = resized.data[si] / 255;
        float32Data[1024 + i] = resized.data[si + 1] / 255;
        float32Data[2048 + i] = resized.data[si + 2] / 255;
      }

      const inputTensor = new ort.Tensor('float32', float32Data, [1, 3, 32, 32]);
      const results = await this.session.run({ input: inputTensor });
      const logits = results.logits.data as Float32Array;

      // Softmax → probability for local champion class
      let maxLogit = -Infinity;
      for (let i = 0; i < logits.length; i++) {
        if (logits[i] > maxLogit) maxLogit = logits[i];
      }
      let sumExp = 0;
      let localExp = 0;
      for (let i = 0; i < logits.length; i++) {
        const exp = Math.exp(logits[i] - maxLogit);
        sumExp += exp;
        if (i === this.localClassIndex) localExp = exp;
      }
      scores.push(localExp / sumExp);
    }

    return scores;
  }
}
