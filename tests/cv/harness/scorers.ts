// Stand-ins for the ONNX champion classifier.
//
// The real model is 172-class and its accuracy is measured elsewhere
// (models/champion-classifier-metrics.json). What this suite needs is control
// over WHAT the classifier says, so the tracker's behaviour under each answer
// can be pinned — above all the answer that broke v0.5.8: a loaded model that
// scores the local champion 0.000 on every frame.

import { BlobCropBox, BlobScorer } from '../../../src/services/champion-classifier';
import { CaptureFrame } from '../../../src/core/capture-frame';
import { Point } from './scenes';

/** Whether a crop box (capture-frame coords) covers a point. */
function cropContains(crop: BlobCropBox, p: Point): boolean {
  return p.x >= crop.cropX && p.x < crop.cropX + crop.cropW
    && p.y >= crop.cropY && p.y < crop.cropY + crop.cropH;
}

/**
 * A loaded model that never recognises anything — NotOtakuu's Twisted Fate log
 * (v0.5.8, issue #13). Every downstream signal has to carry the lock on its own.
 */
export class ZeroScorer implements BlobScorer {
  runs = 0;
  isLoaded(): boolean { return true; }
  async scoreBlobsForLocalChampion(_frame: CaptureFrame, blobs: BlobCropBox[]): Promise<number[]> {
    this.runs++;
    return blobs.map(() => 0);
  }
}

/**
 * A model that is certain about one point on the minimap and silent about
 * everything else. Aim it at the self icon for a perfect classifier; aim it at
 * an ally or a decoy to model a confident misidentification.
 */
export class OracleScorer implements BlobScorer {
  runs = 0;
  constructor(private readonly target: () => Point | null) {}
  isLoaded(): boolean { return true; }
  async scoreBlobsForLocalChampion(_frame: CaptureFrame, blobs: BlobCropBox[]): Promise<number[]> {
    this.runs++;
    const t = this.target();
    return blobs.map(b => (t && cropContains(b, t) ? 1 : 0));
  }
}

/** A classifier that never finished loading — the no-classifier weighting. */
export class UnloadedScorer implements BlobScorer {
  runs = 0;
  isLoaded(): boolean { return false; }
  async scoreBlobsForLocalChampion(_frame: CaptureFrame, blobs: BlobCropBox[]): Promise<number[]> {
    this.runs++;
    return blobs.map(() => 0);
  }
}

/**
 * A model that is silent about every blob except on one inference run, where it
 * is briefly certain about one wrong point — a single-frame misclassification.
 *
 * This is the input the classifier EMA exists to absorb. v0.3.0's "snap up to
 * raw on any increase" branch let one such frame latch a blob's confidence at
 * 1.0, and the tracker then followed a minion wave or a structure with
 * conviction; v0.3.1 reverted it to a symmetric EMA that damps the spike to
 * 0.4. See nextClassifierEma in src/services/tracking-helpers.ts.
 */
export class SpikingScorer implements BlobScorer {
  runs = 0;
  constructor(
    private readonly spikeAt: number,
    private readonly target: () => Point,
  ) {}
  isLoaded(): boolean { return true; }
  async scoreBlobsForLocalChampion(_frame: CaptureFrame, blobs: BlobCropBox[]): Promise<number[]> {
    const run = this.runs++;
    if (run !== this.spikeAt) return blobs.map(() => 0);
    const t = this.target();
    return blobs.map(b => (cropContains(b, t) ? 1 : 0));
  }
}

/**
 * A model that cannot tell two teal blobs apart — it vouches for both.
 *
 * Not a contrived input: updateClassifierScores divides every raw score by the
 * largest one, so a weak model answering 0.060 and 0.055 for two allies hands
 * the tracker 1.00 and 0.92. Both clear CLS_FOLLOW_THRESHOLD, the identity gate
 * lets both through, and whatever the composite score does next is the only
 * thing choosing between them.
 */
export class IndiscriminateScorer implements BlobScorer {
  runs = 0;
  isLoaded(): boolean { return true; }
  async scoreBlobsForLocalChampion(_frame: CaptureFrame, blobs: BlobCropBox[]): Promise<number[]> {
    this.runs++;
    return blobs.map(() => 1);
  }
}
