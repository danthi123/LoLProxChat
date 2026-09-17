// Pixel synthesis for the CV simulation suite.
//
// Everything here draws into a buffer shaped exactly like the one
// src-tauri/src/capture.rs sends over the IPC, so the frames go through the
// real decoder, the real colour classification and the real blob detector.
// Nothing downstream knows it is looking at synthesized pixels.
//
// The colours are the ones classifyPixel() actually tests for, and the ring
// geometry is pinned by tests/cv/harness-selfcheck.test.ts — see the notes on
// `ring` for why thickness is load-bearing.

import { CAPTURE_FRAME_HEADER_BYTES } from '../../../src/core/capture-frame';

export type Rgb = [number, number, number];

/** Dark minimap fog. Classifies as "neither teal nor red". */
export const BACKGROUND: Rgb = [30, 40, 45];
/** Ally border: r < 100, g > 120, b > 120, g + b > 280. */
export const TEAL: Rgb = [40, 200, 190];
/** Enemy border: r > 140, g < 100, b < 100. */
export const RED: Rgb = [220, 60, 60];
/** Camera rectangle and movement-path trail: every channel > 200. */
export const WHITE: Rgb = [235, 235, 235];

export interface SynthFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function blankFrame(width: number, height: number, fill: Rgb = BACKGROUND): SynthFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

export function setPixel(f: SynthFrame, x: number, y: number, rgb: Rgb): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= f.width || py >= f.height) return;
  const i = (py * f.width + px) * 4;
  f.data[i] = rgb[0];
  f.data[i + 1] = rgb[1];
  f.data[i + 2] = rgb[2];
  f.data[i + 3] = 255;
}

/**
 * A champion icon: the coloured ring around the portrait, which is all the CV
 * ever sees of it.
 *
 * `thickness` is not a cosmetic choice. TrackingService.dilate() fattens every
 * border before blob detection, and filterIconBlobs() rejects anything whose
 * fillRatio exceeds 0.40 — so a ring drawn too thick produces no icon blobs at
 * all and the whole simulation goes vacuously green. The self-check test pins
 * the measured ratios for thickness 1, 2 and 3 at the default icon diameter.
 */
export function ring(
  f: SynthFrame,
  cx: number,
  cy: number,
  diam: number,
  color: Rgb,
  thickness = 1,
): void {
  const rOuter = diam / 2;
  const rInner = rOuter - thickness;
  const lo = Math.floor(-rOuter - 1);
  const hi = Math.ceil(rOuter + 1);
  for (let dy = lo; dy <= hi; dy++) {
    for (let dx = lo; dx <= hi; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= rOuter && d > rInner) setPixel(f, cx + dx, cy + dy, color);
    }
  }
}

/** A filled disc — a turret's map icon, and the shape filterIconBlobs must reject. */
export function disc(f: SynthFrame, cx: number, cy: number, radius: number, color: Rgb): void {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (Math.hypot(dx, dy) <= radius) setPixel(f, cx + dx, cy + dy, color);
    }
  }
}

/**
 * A minion wave: several small filled dots close enough that dilate() merges
 * them into one dense blob. The other shape that must never win a lock.
 */
export function minionCluster(f: SynthFrame, cx: number, cy: number, count = 8): void {
  disc(f, cx, cy, 2, TEAL);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    disc(f, cx + Math.cos(angle) * 6, cy + Math.sin(angle) * 6, 2, TEAL);
  }
}

/**
 * League's camera viewport: a white rectangle outline. Both edge pairs are
 * longer than buildWhiteMasks' 12px run threshold, which is what gets them
 * classified as viewport rather than as movement-path evidence.
 */
export function cameraRect(f: SynthFrame, x: number, y: number, w: number, h: number): void {
  for (let i = 0; i < w; i++) {
    setPixel(f, x + i, y, WHITE);
    setPixel(f, x + i, y + h - 1, WHITE);
  }
  for (let i = 0; i < h; i++) {
    setPixel(f, x, y + i, WHITE);
    setPixel(f, x + w - 1, y + i, WHITE);
  }
}

/**
 * The white trail League draws behind the local champion — the strongest
 * non-classifier signal for "this icon is you".
 *
 * It has to start OUTSIDE the icon's bounding box: countWhiteNearBlob skips
 * every pixel inside the blob's own bbox and samples only a
 * max(4, 0.3 * diam) annulus around it. A trail drawn snug against the
 * portrait scores zero, every teal blob ties, and SCANNING locks onto whichever
 * ally happens to come first in raster order — a suite that tracks the wrong
 * champion perfectly and passes.
 */
export function movementPath(
  f: SynthFrame,
  cx: number,
  cy: number,
  diam: number,
  dirX: number,
  dirY: number,
  len = 8,
): void {
  const mag = Math.hypot(dirX, dirY) || 1;
  const ux = dirX / mag;
  const uy = dirY / mag;
  // Perpendicular: two pixels per step, so the count clears the 8-pixel
  // saturation point of whitePixelScore even after rounding collisions.
  const px = -uy;
  const py = ux;
  const start = diam / 2 + 2;
  for (let t = 0; t < len; t++) {
    const r = start + t;
    setPixel(f, cx + ux * r, cy + uy * r, WHITE);
    setPixel(f, cx + ux * r + px, cy + uy * r + py, WHITE);
  }
}

/**
 * Frame the pixels the way capture.rs does: little-endian width, little-endian
 * height, then top-down row-major RGBA. Going through the wire format means the
 * simulation exercises decodeCaptureFrame too, rather than bypassing it.
 */
export function encodeFrame(f: SynthFrame): ArrayBuffer {
  const buf = new ArrayBuffer(CAPTURE_FRAME_HEADER_BYTES + f.width * f.height * 4);
  const header = new DataView(buf, 0, CAPTURE_FRAME_HEADER_BYTES);
  header.setUint32(0, f.width, true);
  header.setUint32(4, f.height, true);
  new Uint8ClampedArray(buf, CAPTURE_FRAME_HEADER_BYTES).set(f.data);
  return buf;
}
