// Which teammate an own-team minimap icon belongs to, by comparing it with the
// exact icon art each teammate is wearing this game.
//
// The champion classifier has to tell 173 champions apart from a 30-pixel
// icon, and in real games it often cannot (the 2026-10-08 test: Gwen scored
// 0%, Kayn under 5%). The question the tracker actually needs answered is much
// smaller: which of my two to four teammates is this? Live Client Data says
// which skin each of them has on, and Community Dragon serves that skin's
// minimap icon — the very image the game draws. On the crops from that test,
// plain correlation against those icons labelled about half of all detected
// icons with a clear margin, and every one checked by eye was right; the rest
// were icons partly covered or merged, which it left undecided.
//
// Pure functions first (tested under node), then the browser glue that fetches,
// caches and decodes the icons, then the BlobScorer that folds the result into
// the classifier's score.

import type { CaptureFrame } from '../core/capture-frame';
import type { BlobCropBox, BlobScorer } from './champion-classifier';

/** Side of the square both templates and crops are compared at. */
export const MATCH_SIZE = 32;
/** Only the portrait inside this radius (fraction of the side) is compared:
 *  the border ring is team-coloured, not part of the art. */
const INNER_FRACTION = 0.36;
/** A match is believed only when the best teammate scores at least this... */
export const MATCH_MIN_SCORE = 0.6;
/** ...and beats the runner-up by at least this. */
export const MATCH_MIN_MARGIN = 0.2;
/** What the scorer reports for an icon matched to the local player: high
 *  enough to clear every raw-score gate in the tracker (FAR_REACQUIRE_MIN_RAW). */
export const SKIN_SELF_RAW = 0.95;
/** Background the transparent corners of an icon are composited onto. */
const ICON_BACKDROP = 30;
/** Zooms each icon is prepared at: the in-game icon shows a little less of the
 *  art than the full circle image, by an amount that varies with HUD scale. */
const TEMPLATE_ZOOMS = [0.8, 0.9, 1.0];
/** Crop sizes (fraction of the expected icon diameter) and centre offsets
 *  (px) searched around each blob: blob centres are off by a pixel or two. */
const CROP_SCALES = [0.95, 1.05, 1.15];
const CROP_SHIFTS = [-2, -1, 0, 1, 2];

let innerCache: Int32Array | null = null;
/** Indices of the pixels inside the compared circle, for a MATCH_SIZE square. */
export function innerIndices(): Int32Array {
  if (innerCache) return innerCache;
  const S = MATCH_SIZE;
  const c = (S - 1) / 2;
  const out: number[] = [];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (Math.hypot(x - c, y - c) <= S * INNER_FRACTION) out.push(y * S + x);
    }
  }
  innerCache = Int32Array.from(out);
  return innerCache;
}

/**
 * The inner circle of a MATCH_SIZE x MATCH_SIZE RGB image as a zero-mean,
 * unit-length vector, so that a dot product of two is their correlation —
 * insensitive to the overall brightness and contrast the minimap applies.
 */
export function normalizedInner(rgb: Float32Array): Float32Array {
  const idx = innerIndices();
  const v = new Float32Array(idx.length * 3);
  let sum = 0;
  for (let i = 0; i < idx.length; i++) {
    for (let c = 0; c < 3; c++) {
      const x = rgb[idx[i] * 3 + c];
      v[i * 3 + c] = x;
      sum += x;
    }
  }
  const mean = sum / v.length;
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] -= mean;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Resample the square of side `side` centred on (cx, cy) of an RGBA buffer to
 * MATCH_SIZE x MATCH_SIZE RGB, bilinear. Pixels outside the buffer read as
 * `fill`. Used for both minimap crops and icon templates, so the two are
 * prepared exactly alike.
 */
export function sampleSquare(
  data: ArrayLike<number>,
  width: number,
  height: number,
  cx: number,
  cy: number,
  side: number,
  fill = 0,
): Float32Array {
  const S = MATCH_SIZE;
  const out = new Float32Array(S * S * 3);
  const step = side / S;
  const x0 = cx - side / 2;
  const y0 = cy - side / 2;
  const px = (x: number, y: number, c: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? fill : data[(y * width + x) * 4 + c];
  for (let j = 0; j < S; j++) {
    const sy = y0 + (j + 0.5) * step - 0.5;
    const yA = Math.floor(sy);
    const fy = sy - yA;
    for (let i = 0; i < S; i++) {
      const sx = x0 + (i + 0.5) * step - 0.5;
      const xA = Math.floor(sx);
      const fx = sx - xA;
      for (let c = 0; c < 3; c++) {
        const top = px(xA, yA, c) * (1 - fx) + px(xA + 1, yA, c) * fx;
        const bottom = px(xA, yA + 1, c) * (1 - fx) + px(xA + 1, yA + 1, c) * fx;
        out[(j * S + i) * 3 + c] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return out;
}

/**
 * Template vectors for one icon image (RGBA, any size): its transparent
 * corners composited onto a dark backdrop, then the central `zoom` share of it
 * at each of TEMPLATE_ZOOMS.
 */
export function iconTemplates(rgba: ArrayLike<number>, width: number, height: number): Float32Array[] {
  const flat = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) flat[i * 4 + c] = rgba[i * 4 + c] * a + ICON_BACKDROP * (1 - a);
    flat[i * 4 + 3] = 255;
  }
  const side = Math.min(width, height);
  // Downsampling a 120px icon to 32 straight through bilinear aliases; halve
  // first until within 2x, the way a mip chain would.
  let src = flat;
  let w = width;
  let h = height;
  while (Math.min(w, h) >= MATCH_SIZE * 4) {
    const hw = Math.floor(w / 2);
    const hh = Math.floor(h / 2);
    const half = new Float32Array(hw * hh * 4);
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < hw; x++) {
        for (let c = 0; c < 4; c++) {
          half[(y * hw + x) * 4 + c] = (src[((2 * y) * w + 2 * x) * 4 + c] + src[((2 * y) * w + 2 * x + 1) * 4 + c] +
            src[((2 * y + 1) * w + 2 * x) * 4 + c] + src[((2 * y + 1) * w + 2 * x + 1) * 4 + c]) / 4;
        }
      }
    }
    src = half;
    w = hw;
    h = hh;
  }
  const scale = Math.min(w, h) / side;
  return TEMPLATE_ZOOMS.map(z =>
    normalizedInner(sampleSquare(src, w, h, w / 2, h / 2, side * scale * z, ICON_BACKDROP)));
}

/** One teammate's templates: every form of the skin they have on. */
export interface TemplateSet {
  /** Identifies the player (their summoner name). */
  id: string;
  vecs: Float32Array[];
}

export interface MatchScore { id: string; score: number }

/**
 * Correlate the icon centred near (cx, cy) in `frame` with every teammate's
 * templates, searching a few crop sizes and centre offsets. Best score per
 * teammate, highest first.
 */
export function matchIcon(
  frame: CaptureFrame,
  cx: number,
  cy: number,
  iconDiam: number,
  sets: TemplateSet[],
): MatchScore[] {
  const best = new Map<string, number>();
  for (const k of CROP_SCALES) {
    for (const dy of CROP_SHIFTS) {
      for (const dx of CROP_SHIFTS) {
        const v = normalizedInner(sampleSquare(frame.data, frame.width, frame.height, cx + dx, cy + dy, iconDiam * k));
        for (const set of sets) {
          let s = -Infinity;
          for (const t of set.vecs) s = Math.max(s, dot(v, t));
          if (s > (best.get(set.id) ?? -Infinity)) best.set(set.id, s);
        }
      }
    }
  }
  return [...best.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

/** Whose icon this is, when the match is clear; null when it is not. */
export function decideMatch(ranked: MatchScore[]): string | null {
  if (ranked.length === 0 || ranked[0].score < MATCH_MIN_SCORE) return null;
  const margin = ranked[0].score - (ranked[1]?.score ?? 0);
  return margin >= MATCH_MIN_MARGIN ? ranked[0].id : null;
}

// ---------- Which icon files show a given skin ----------

/**
 * The minimap icon files for `skinId` among a champion's HUD directory
 * listing: `<alias>_circle.png` for the base skin (or `_circle_0`),
 * `<alias>_circle_<n>.png` for skin n, and the same for each alternate form
 * (`kayn_ass_circle_15.png`, `kayn_slay_circle_15.png`), whose icon replaces
 * the base one when the champion transforms. A chroma has no icon of its own
 * and wears its parent skin's — the highest-numbered icon below its id.
 */
export function iconFilesForSkin(listing: string, alias: string, skinId: number): string[] {
  const a = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
  const re = new RegExp('\\b(' + a + '(?:_[a-z0-9]+)?)_circle(?:_(\\d+))?\\.png\\b', 'gi');
  const forms = new Map<string, Map<number, string>>();
  for (const m of listing.matchAll(re)) {
    const prefix = m[1].toLowerCase();
    const n = m[2] === undefined ? 0 : Number(m[2]);
    if (!forms.has(prefix)) forms.set(prefix, new Map());
    const byNum = forms.get(prefix)!;
    // An explicit _circle_0 and a bare _circle are both the base skin; keep the bare one.
    if (!byNum.has(n) || m[2] === undefined) byNum.set(n, m[0].toLowerCase());
  }
  const files: string[] = [];
  for (const byNum of forms.values()) {
    let pick = -1;
    for (const n of byNum.keys()) if (n <= skinId && n > pick) pick = n;
    if (pick >= 0) files.push(byNum.get(pick)!);
  }
  return files.sort();
}

/**
 * The Community Dragon directory name for a champion: `rawChampionName` is
 * `game_character_displayname_<Alias>` (Wukong is MonkeyKing). Falls back to
 * the display name with everything but letters and digits dropped, which is
 * the alias for nearly every champion.
 */
export function championAlias(rawChampionName: string | undefined, championName: string): string {
  const m = rawChampionName?.match(/^game_character_displayname_(.+)$/);
  return (m ? m[1] : championName).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---------- Fetching and caching (browser only) ----------

const CDRAGON = 'https://raw.communitydragon.org/latest/game/assets/characters';
const CACHE_NAME = 'lolproxchat-icons-v1';
const LISTING_MAX_AGE_MS = 7 * 24 * 3600_000;
const ICON_MAX_AGE_MS = 30 * 24 * 3600_000;
const FETCHED_AT = 'x-lolproxchat-fetched';

/**
 * GET through a persistent cache: each icon is downloaded once per install and
 * reused until it is a month old (a week for directory listings, which gain
 * entries with new skins). A stale copy is served when the network fails. The
 * request carries nothing but the file's path — no game, player or room.
 */
async function cachedFetch(url: string, maxAgeMs: number): Promise<Response> {
  let cache: Cache | null = null;
  try { cache = await caches.open(CACHE_NAME); } catch { cache = null; }
  const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
  if (hit && Date.now() - Number(hit.headers.get(FETCHED_AT) ?? 0) < maxAgeMs) return hit;
  try {
    const resp = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    if (cache) {
      const body = await resp.clone().blob();
      const headers = new Headers(resp.headers);
      headers.set(FETCHED_AT, String(Date.now()));
      await cache.put(url, new Response(body, { headers })).catch(() => undefined);
    }
    return resp;
  } catch (e) {
    if (hit) return hit;
    throw e;
  }
}

async function decodeRgba(blob: Blob): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { data: img.data, width: img.width, height: img.height };
}

export interface TeammateSkin {
  /** Summoner name: the id matches are reported under. */
  id: string;
  championName: string;
  rawChampionName?: string;
  skinId: number;
}

/** Fetch, cache and prepare every teammate's icon templates. A teammate whose
 *  icons cannot be had is left out (and logged); the rest still work. */
export async function loadTeamTemplates(team: TeammateSkin[]): Promise<TemplateSet[]> {
  const sets: TemplateSet[] = [];
  const notes: string[] = [];
  for (const p of team) {
    const alias = championAlias(p.rawChampionName, p.championName);
    try {
      const listing = await (await cachedFetch(`${CDRAGON}/${alias}/hud/`, LISTING_MAX_AGE_MS)).text();
      const files = iconFilesForSkin(listing, alias, p.skinId);
      if (files.length === 0) throw new Error('no minimap icon in the listing');
      const vecs: Float32Array[] = [];
      for (const f of files) {
        const img = await decodeRgba(await (await cachedFetch(`${CDRAGON}/${alias}/hud/${f}`, ICON_MAX_AGE_MS)).blob());
        vecs.push(...iconTemplates(img.data, img.width, img.height));
      }
      sets.push({ id: p.id, vecs });
      notes.push(p.championName + ' skin ' + p.skinId + ' (' + files.join(', ') + ')');
    } catch (e) {
      notes.push(p.championName + ' skin ' + p.skinId + ': unavailable (' + String(e) + ')');
    }
  }
  console.log('[Skins] Teammate icons: ' + notes.join('; '));
  return sets;
}

// ---------- The scorer ----------

/**
 * Wraps the champion classifier: an icon the skin match clearly says is the
 * local player scores SKIN_SELF_RAW, one it clearly says is a teammate scores
 * 0, and anything it is unsure of keeps the classifier's score. The tracker
 * normalizes, smooths and gates these exactly as it does the model's.
 *
 * Works before (and without) the model: until it loads, unsure icons score 0.
 */
export class SkinAwareScorer implements BlobScorer {
  private sets: TemplateSet[] = [];
  private tally = { self: 0, other: 0, unsure: 0 };
  private lastTallyLogMs = 0;

  constructor(private readonly selfId: string, private inner: BlobScorer | null = null) {}

  setInner(inner: BlobScorer): void { this.inner = inner; }

  /** Templates for the local player and their teammates; the local player's
   *  must be among them for a match to vouch for anyone. */
  setTemplates(sets: TemplateSet[]): void {
    this.sets = sets.some(s => s.id === this.selfId) && sets.length >= 2 ? sets : [];
    if (sets.length > 0 && this.sets.length === 0) {
      console.warn('[Skins] Not matching icons: need the local player\'s and at least one teammate\'s');
    }
  }

  isLoaded(): boolean {
    return this.sets.length > 0 || !!this.inner?.isLoaded();
  }

  lastCrops(): ImageData[] {
    return this.inner?.lastCrops?.() ?? [];
  }

  async scoreBlobsForLocalChampion(frame: CaptureFrame, blobs: BlobCropBox[]): Promise<number[]> {
    const model = this.inner?.isLoaded()
      ? await this.inner.scoreBlobsForLocalChampion(frame, blobs)
      : blobs.map(() => 0);
    if (this.sets.length === 0) return model;
    const scores = blobs.map((b, i) => {
      const side = Math.min(b.cropW, b.cropH);
      const who = decideMatch(matchIcon(frame, b.cropX + b.cropW / 2, b.cropY + b.cropH / 2, side, this.sets));
      if (who === this.selfId) { this.tally.self++; return Math.max(model[i], SKIN_SELF_RAW); }
      if (who !== null) { this.tally.other++; return 0; }
      this.tally.unsure++;
      return model[i];
    });
    const now = Date.now();
    if (now - this.lastTallyLogMs >= 60_000) {
      if (this.lastTallyLogMs > 0) {
        console.log('[Skins] Icons matched in the last minute: you ' + this.tally.self +
          ', a teammate ' + this.tally.other + ', unsure ' + this.tally.unsure);
      }
      this.lastTallyLogMs = now;
      this.tally = { self: 0, other: 0, unsure: 0 };
    }
    return scores;
  }
}
