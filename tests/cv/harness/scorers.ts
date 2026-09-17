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
