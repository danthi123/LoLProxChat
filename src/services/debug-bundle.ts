import { invoke } from '@tauri-apps/api/core';
import { CaptureFrame } from '../core/capture-frame';
import { isLoggingEnabled } from '../core/logging';

/**
 * Per-game debug bundle (Debug on only): Rust collects this game's log lines,
 * and this saves what the tracker saw — the minimap every 10 s and at every
 * tracking event (lock, loss, re-acquisition), and the icon crops the champion
 * classifier scored, named with their scores. At the end of the game Rust zips
 * it all as `games/<lobby>_<start>.zip` in the log folder (game_bundle.rs).
 *
 * Two playtests' logs showed the classifier scoring nearly every icon 0.000;
 * these images are what can say why. Everything stays on the player's PC.
 */

export interface Rect { x: number; y: number; width: number; height: number }

export interface ScoredCrop {
  image: ImageData;
  /** Blob centre in minimap-region pixels. */
  cx: number;
  cy: number;
  raw: number;
  smoothed: number;
}

export interface TrackingDebugSink {
  /** Every CV tick; saves a snapshot when one is due or an event is pending. */
  onFrame(frame: CaptureFrame, region: Rect): void;
  /** A tracking event worth a snapshot of the next frame. */
  markEvent(tag: string): void;
  /** One classifier run's crops and scores; kept every few seconds. */
  onClassifierRun(crops: ScoredCrop[]): void;
}

const SNAPSHOT_EVERY_MS = 10_000;
const EVENT_SNAPSHOT_MIN_GAP_MS = 2_000;
const CROPS_EVERY_MS = 5_000;
const MAX_SNAPSHOTS = 300;
const MAX_CROP_RUNS = 400;

/** "vrb9uf_2026-10-07_17-05" in the player's local time. */
export function bundleName(roomId: string, start: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return roomId + '_' + start.getFullYear() + '-' + p(start.getMonth() + 1) + '-' + p(start.getDate()) +
    '_' + p(start.getHours()) + '-' + p(start.getMinutes());
}

/** "03-07.4" — minutes and seconds into the game, sortable. */
export function elapsedTag(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return String(m).padStart(2, '0') + '-' + (s - m * 60).toFixed(1).padStart(4, '0');
}

export class DebugBundle implements TrackingDebugSink {
  private readonly startMs = performance.now();
  private lastSnapshotMs = -Infinity;
  private lastCropsMs = -Infinity;
  private pendingTags: string[] = [];
  private snapshots = 0;
  private cropRuns = 0;
  private writing = 0;

  private constructor(readonly name: string) {}

  static async start(roomId: string): Promise<DebugBundle | null> {
    const name = bundleName(roomId, new Date());
    try {
      await invoke('bundle_start', { name });
      console.log('[Debug] Saving this game to games/' + name + '.zip in the log folder');
      return new DebugBundle(name);
    } catch (e) {
      console.warn('[Debug] Could not start the game bundle:', e);
      return null;
    }
  }

  /** Zip it. Logs flushed by the caller first, so the zip has the last lines. */
  static async finish(): Promise<void> {
    try {
      const zip = await invoke<string | null>('bundle_finish');
      if (zip) console.log('[Debug] Game saved as games/' + zip);
    } catch (e) {
      console.warn('[Debug] Could not zip the game bundle:', e);
    }
  }

  markEvent(tag: string): void {
    if (this.pendingTags.length < 4 && !this.pendingTags.includes(tag)) this.pendingTags.push(tag);
  }

  onFrame(frame: CaptureFrame, region: Rect): void {
    const now = performance.now();
    const periodic = now - this.lastSnapshotMs >= SNAPSHOT_EVERY_MS;
    const event = this.pendingTags.length > 0 && now - this.lastSnapshotMs >= EVENT_SNAPSHOT_MIN_GAP_MS;
    if ((!periodic && !event) || this.snapshots >= MAX_SNAPSHOTS || this.writing > 4) return;
    // Debug switched off mid-game stops the saving, not just the log.
    if (!isLoggingEnabled()) return;
    // '-', not '+': the Rust side accepts only [A-Za-z0-9._-] in a path.
    const tag = event ? this.pendingTags.join('-') : 'periodic';
    this.pendingTags = [];
    this.lastSnapshotMs = now;
    this.snapshots++;
    const image = cropFrame(frame, region);
    if (!image) return;
    this.save('minimap/' + elapsedTag(now - this.startMs) + '_' + tag + '.png', image);
  }

  onClassifierRun(crops: ScoredCrop[]): void {
    const now = performance.now();
    if (crops.length === 0 || now - this.lastCropsMs < CROPS_EVERY_MS || this.cropRuns >= MAX_CROP_RUNS) return;
    if (!isLoggingEnabled()) return;
    this.lastCropsMs = now;
    this.cropRuns++;
    const at = elapsedTag(now - this.startMs);
    crops.forEach((c, i) => {
      this.save('crops/' + at + '_' + i + '_at' + Math.round(c.cx) + 'x' + Math.round(c.cy) +
        '_raw' + c.raw.toFixed(3) + '_ema' + c.smoothed.toFixed(2) + '.png', c.image);
    });
  }

  private save(path: string, image: ImageData): void {
    this.writing++;
    void encodePng(image)
      .then((bytes) => invoke('bundle_add_file', bytes, { headers: { 'x-path': path } }))
      .catch(() => { /* a lost image is not worth a log line per frame */ })
      .finally(() => { this.writing--; });
  }
}

/** The minimap region of a capture frame, copied out. */
function cropFrame(frame: CaptureFrame, region: Rect): ImageData | null {
  const x0 = Math.max(0, Math.round(region.x));
  const y0 = Math.max(0, Math.round(region.y));
  const w = Math.min(frame.width - x0, Math.round(region.width));
  const h = Math.min(frame.height - y0, Math.round(region.height));
  if (w <= 0 || h <= 0) return null;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * frame.width + x0) * 4;
    out.set(frame.data.subarray(from, from + w * 4), y * w * 4);
  }
  return new ImageData(out, w, h);
}

async function encodePng(image: ImageData): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}
