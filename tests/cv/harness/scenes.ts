// Scene description -> synthesized capture frame, plus the ground truth that
// goes with it.
//
// Coordinates in a SceneSpec are REGION-relative (0,0 is the minimap's top-left
// corner), because that is the frame of reference a reader can reason about:
// "the self icon is a third of the way across the map". The renderer offsets
// them into capture-frame space.

import { MapType, MAP_DIMENSIONS, Position } from '../../../src/core/types';
import { FrameSource } from '../../../src/services/frame-source';
import {
  blankFrame,
  cameraRect,
  disc,
  encodeFrame,
  minionCluster,
  movementPath,
  ring,
  RED,
  TEAL,
} from './frames';

/** A borderless 1080p game window on the primary monitor. */
export const GAME_RECT = { x: 0, y: 0, width: 1920, height: 1080 };
/** League's MinimapScale, as read out of game.cfg. */
export const MINIMAP_SCALE = 1.0;

// What the production geometry (core/map-calibration.ts) resolves the above to.
// Hard-coded rather than imported so the harness has an independent opinion:
// the self-check asserts the tracker agrees, and a calibration change that
// moves the minimap fails there, loudly, instead of silently relabelling every
// ground-truth coordinate in this suite.
export const CAPTURE_SIZE = 432;
export const REGION = { x: 159, y: 159, width: 273, height: 273 };
/** Math.round(REGION.width * 0.087) — TrackingService.expectedIconDiam. */
export const ICON_DIAM = 24;

export const MAP: MapType = 'summoners_rift';

export interface Point {
  x: number;
  y: number;
}

export interface SceneSpec {
  /** The local champion. Omit to model an icon that is not currently visible. */
  self?: Point | null;
  /** Direction the movement-path trail points, i.e. where the champion came from. */
  selfTrail?: Point | null;
  allies?: Point[];
  enemies?: Point[];
  minions?: Point[];
  turrets?: Point[];
  camera?: { x: number; y: number; w: number; h: number } | null;
}

export interface RenderedScene {
  frame: ArrayBuffer;
  /** Self icon centre in region-relative pixels, or null when it is not drawn. */
  truth: Point | null;
}

export function renderScene(spec: SceneSpec): RenderedScene {
  const f = blankFrame(CAPTURE_SIZE, CAPTURE_SIZE);
  const ox = REGION.x;
  const oy = REGION.y;

  if (spec.camera) {
    cameraRect(f, ox + spec.camera.x, oy + spec.camera.y, spec.camera.w, spec.camera.h);
  }
  for (const p of spec.turrets ?? []) disc(f, ox + p.x, oy + p.y, 8, TEAL);
  for (const p of spec.minions ?? []) minionCluster(f, ox + p.x, oy + p.y);
  for (const p of spec.enemies ?? []) ring(f, ox + p.x, oy + p.y, ICON_DIAM, RED);
  for (const p of spec.allies ?? []) ring(f, ox + p.x, oy + p.y, ICON_DIAM, TEAL);

  if (spec.self) {
    // Trail first: the ring is drawn over it, so a trail aimed at the icon
    // cannot accidentally erase part of the border.
    if (spec.selfTrail) {
      movementPath(f, ox + spec.self.x, oy + spec.self.y, ICON_DIAM, spec.selfTrail.x, spec.selfTrail.y);
    }
    ring(f, ox + spec.self.x, oy + spec.self.y, ICON_DIAM, TEAL);
  }

  return { frame: encodeFrame(f), truth: spec.self ?? null };
}

export function renderScenes(specs: SceneSpec[]): RenderedScene[] {
  return specs.map(renderScene);
}

/**
 * Region-relative pixel -> game coordinates, derived here rather than by
 * calling TrackingService.pixelToGamePosition, so a bug in the conversion
 * cannot cancel itself out against the expectation.
 */
export function truthToGame(p: Point, map: MapType = MAP): Position {
  const dims = MAP_DIMENSIONS[map];
  return {
    x: (p.x / REGION.width) * dims.width,
    y: dims.height - (p.y / REGION.height) * dims.height,
  };
}

/** The inverse, so a reported position can be compared in pixels. */
export function gameToTruth(pos: Position, map: MapType = MAP): Point {
  const dims = MAP_DIMENSIONS[map];
  return {
    x: (pos.x / dims.width) * REGION.width,
    y: ((dims.height - pos.y) / dims.height) * REGION.height,
  };
}

/** A capture-frame point, for scorers that reason about crop boxes. */
export function toFramePoint(p: Point): Point {
  return { x: REGION.x + p.x, y: REGION.y + p.y };
}

/**
 * Plays a fixed list of frames, then repeats the last one forever — a tracker
 * driven past the end of its script keeps seeing a static minimap rather than
 * a capture failure, which would muddle every assertion after it.
 */
export class ScriptedFrameSource implements FrameSource {
  private index = 0;
  private frames: ArrayBuffer[];
  captureCount = 0;

  constructor(frames: ArrayBuffer[]) {
    this.frames = frames;
    if (frames.length === 0) throw new Error('ScriptedFrameSource: no frames');
  }

  /** Point the same tracker at a new script, e.g. after a respawn. */
  reload(frames: ArrayBuffer[]): void {
    if (frames.length === 0) throw new Error('ScriptedFrameSource: no frames');
    this.frames = frames;
    this.index = 0;
  }

  async capture(): Promise<ArrayBuffer> {
    this.captureCount++;
    const frame = this.frames[Math.min(this.index, this.frames.length - 1)];
    this.index++;
    return frame;
  }
}
