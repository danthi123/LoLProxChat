// Real-art rendering for the CV simulation suite.
//
// The rest of the harness draws flat coloured rings on flat fog. That proves
// the state machine, but nothing about League's actual minimap: terrain whose
// river and jungle colours can land inside the teal box, and champion
// portraits whose art can merge with or break up the border ring. This renders
// the same SceneSpec on the real Summoner's Rift minimap with real champion
// portraits inside the rings.
//
// The art is Riot's and is not committed. scripts/make-cv-fixtures.py builds
// tests/cv/fixtures-real/ from the icon scrape; loadRealArt() returns null when
// it has not been run, and tests using it skip, saying so.

import * as fs from 'fs';
import * as path from 'path';
import { SynthFrame, blankFrame, encodeFrame, movementPath, ring, RED, TEAL, Rgb } from './frames';
import { CAPTURE_SIZE, ICON_DIAM, Point, REGION, RenderedScene, SceneSpec } from './scenes';

const DIR = path.join(__dirname, '..', 'fixtures-real');

export interface RealArt {
  background: Uint8Array; // REGION.width x REGION.height RGBA
  portraits: Map<string, Uint8Array>; // portraitDiam x portraitDiam RGBA
  portraitDiam: number;
  champions: string[];
}

export function loadRealArt(): RealArt | null {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
    if (index.region !== REGION.width || index.champions.length < 4) return null;
    const portraits = new Map<string, Uint8Array>();
    for (const name of index.champions) {
      portraits.set(name, new Uint8Array(fs.readFileSync(path.join(DIR, name + '.rgba'))));
    }
    return {
      background: new Uint8Array(fs.readFileSync(path.join(DIR, 'background-sr.rgba'))),
      portraits,
      portraitDiam: index.portraitDiam,
      champions: index.champions,
    };
  } catch {
    return null;
  }
}

/** Which portrait each role wears: self first, then enemies, then allies. */
export interface Cast {
  self: string;
  enemies: string[];
  allies: string[];
}

export function defaultCast(art: RealArt): Cast {
  const [self, enemy, ...rest] = art.champions;
  return { self, enemies: [enemy, ...rest.slice(0, 3)], allies: rest.slice(3) };
}

function blend(f: SynthFrame, x: number, y: number, rgba: ArrayLike<number>, i: number): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= f.width || py >= f.height) return;
  const a = rgba[i + 3] / 255;
  if (a === 0) return;
  const o = (py * f.width + px) * 4;
  for (let c = 0; c < 3; c++) f.data[o + c] = Math.round(f.data[o + c] * (1 - a) + rgba[i + c] * a);
}

function icon(f: SynthFrame, art: RealArt, name: string, at: Point, border: Rgb, thickness: number): void {
  const d = art.portraitDiam;
  const img = art.portraits.get(name)!;
  const x0 = REGION.x + at.x - d / 2;
  const y0 = REGION.y + at.y - d / 2;
  for (let y = 0; y < d; y++) {
    for (let x = 0; x < d; x++) blend(f, x0 + x + 0.5, y0 + y + 0.5, img, (y * d + x) * 4);
  }
  ring(f, REGION.x + at.x, REGION.y + at.y, ICON_DIAM, border, thickness);
}

export function renderReal(spec: SceneSpec, art: RealArt, cast = defaultCast(art), thickness = 2): RenderedScene {
  const f = blankFrame(CAPTURE_SIZE, CAPTURE_SIZE);
  for (let y = 0; y < REGION.height; y++) {
    for (let x = 0; x < REGION.width; x++) {
      const i = (y * REGION.width + x) * 4;
      const o = ((REGION.y + y) * f.width + REGION.x + x) * 4;
      f.data[o] = art.background[i];
      f.data[o + 1] = art.background[i + 1];
      f.data[o + 2] = art.background[i + 2];
    }
  }
  (spec.allies ?? []).forEach((p, i) => icon(f, art, cast.allies[i % cast.allies.length], p, TEAL, thickness));
  (spec.enemies ?? []).forEach((p, i) => icon(f, art, cast.enemies[i % cast.enemies.length], p, RED, thickness));
  if (spec.self) {
    if (spec.selfTrail) {
      movementPath(f, REGION.x + spec.self.x, REGION.y + spec.self.y, ICON_DIAM, spec.selfTrail.x, spec.selfTrail.y);
    }
    icon(f, art, cast.self, spec.self, TEAL, thickness);
  }
  (spec.enemiesOnTop ?? []).forEach((p, i) => icon(f, art, cast.enemies[i % cast.enemies.length], p, RED, thickness));
  return { frame: encodeFrame(f), truth: spec.self ?? null };
}

/** The raw frame, for eyeballing a scene (write it out and convert to PNG). */
export function rawFrame(scene: RenderedScene): Uint8Array {
  return new Uint8Array(scene.frame, 8);
}
