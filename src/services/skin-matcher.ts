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
 *  (px, at most MAX_SHIFT either way) searched around each blob: blob centres
 *  are off by a pixel or two. The search is coarse first (every other pixel),
 *  then a pixel either way around each teammate's best coarse spot. */
const CROP_SCALES = [0.95, 1.05, 1.15];
const COARSE_SHIFTS = [-2, 0, 2];
const MAX_SHIFT = 2;
/** Below this best coarse score the icon is left undecided without refining.
 *  Refining can lift a score by more than the 0.1 between this and
 *  MATCH_MIN_SCORE (up to 0.28 on the real-game fixtures), so this only ever
 *  errs towards "unsure" — never towards naming someone. */
const REFINE_MIN = MATCH_MIN_SCORE - 0.1;

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
  // Index of each corner's pixel, or -1 outside the buffer (reads as fill).
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? -1 : (y * width + x) * 4;
  for (let j = 0; j < S; j++) {
    const sy = y0 + (j + 0.5) * step - 0.5;
    const yA = Math.floor(sy);
    const fy = sy - yA;
    for (let i = 0; i < S; i++) {
      const sx = x0 + (i + 0.5) * step - 0.5;
      const xA = Math.floor(sx);
      const fx = sx - xA;
      const p00 = at(xA, yA), p10 = at(xA + 1, yA), p01 = at(xA, yA + 1), p11 = at(xA + 1, yA + 1);
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const o = (j * S + i) * 3;
      for (let c = 0; c < 3; c++) {
        out[o + c] = (p00 < 0 ? fill : data[p00 + c]) * w00 + (p10 < 0 ? fill : data[p10 + c]) * w10 +
          (p01 < 0 ? fill : data[p01 + c]) * w01 + (p11 < 0 ? fill : data[p11 + c]) * w11;
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
  /** Identifies the player: unique within the game (summoner names may be
   *  blank or repeated in streamer mode, so the orchestrator does not use them). */
  id: string;
  vecs: Float32Array[];
}

export interface MatchScore { id: string; score: number }

/**
 * Correlate the icon centred near (cx, cy) in `frame` with every teammate's
 * templates, searching a few crop sizes and centre offsets. Best score per
 * teammate, highest first; when nobody comes close to a match, the coarse
 * scores. Every teammate is refined, not just the leader: a runner-up left at
 * its coarse score would understate it and inflate the margin.
 */
export function matchIcon(
  frame: CaptureFrame,
  cx: number,
  cy: number,
  iconDiam: number,
  sets: TemplateSet[],
): MatchScore[] {
  const best = sets.map(() => -Infinity);
  const where = sets.map(() => ({ k: 0, dx: 0, dy: 0 }));
  const tried = new Set<string>();
  const tryAt = (k: number, dx: number, dy: number): void => {
    const key = k + ',' + dx + ',' + dy;
    if (tried.has(key)) return;
    tried.add(key);
    const v = normalizedInner(sampleSquare(frame.data, frame.width, frame.height, cx + dx, cy + dy, iconDiam * k));
    sets.forEach((set, si) => {
      for (const t of set.vecs) {
        const s = dot(v, t);
        if (s > best[si]) { best[si] = s; where[si] = { k, dx, dy }; }
      }
    });
  };
  for (const k of CROP_SCALES) for (const dy of COARSE_SHIFTS) for (const dx of COARSE_SHIFTS) tryAt(k, dx, dy);
  if (Math.max(-Infinity, ...best) >= REFINE_MIN) {
    // Seeds fixed before refining: tryAt moves `where` as it goes, and
    // refining around a moved spot would walk the search outwards.
    const seeds = where.map(w => ({ ...w }));
    const clamp = (d: number): number => Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, d));
    for (const { k, dx, dy } of seeds) {
      for (let ddy = -1; ddy <= 1; ddy++) for (let ddx = -1; ddx <= 1; ddx++) tryAt(k, clamp(dx + ddx), clamp(dy + ddy));
    }
  }
  return sets.map((set, si) => ({ id: set.id, score: best[si] })).sort((a, b) => b.score - a.score);
}

/** Whose icon is in `box` (as tracking.ts cuts it, iconCropBox), when the
 *  match is clear; null when it is not. */
export function whoseIcon(frame: CaptureFrame, box: BlobCropBox, sets: TemplateSet[]): string | null {
  const side = Math.min(box.cropW, box.cropH);
  return decideMatch(matchIcon(frame, box.cropX + box.cropW / 2, box.cropY + box.cropH / 2, side, sets));
}

/** Whose icon this is, when the match is clear; null when it is not. */
export function decideMatch(ranked: MatchScore[]): string | null {
  if (ranked.length === 0 || ranked[0].score < MATCH_MIN_SCORE) return null;
  const margin = ranked[0].score - (ranked[1]?.score ?? 0);
  return margin >= MATCH_MIN_MARGIN ? ranked[0].id : null;
}

// ---------- Which icon files show a given skin ----------

/** Champions whose base-skin icon still carries their pre-release codename
 *  (Community Dragon's listing for Anivia has `cryophoenix_circle.png` and no
 *  `anivia_circle.png`) — or, for Orianna, a misspelling. */
const LEGACY_BASE_NAMES: Record<string, string> = {
  anivia: 'cryophoenix',
  blitzcrank: 'steamgolem',
  chogath: 'greenterror',
  orianna: 'oriana',
  rammus: 'armordillo',
  shaco: 'jester',
  zilean: 'chronokeeper',
};
/** `<alias>_<name>_circle.png` files that are ability icons, not minimap
 *  icons of a form the champion takes. */
const NOT_FORMS = new Set(['certaindeath', 'whirlingdeath', 'trueshotbarrage']);

/**
 * The minimap icon files for `skinId` among a champion's HUD directory
 * listing (checked against every champion's listing in October 2026):
 *
 * - `<alias>_circle.png` (or `_circle_0`) is the base skin and
 *   `<alias>_circle_<n>.png` skin n. Seven champions' base icon goes by an old
 *   codename (LEGACY_BASE_NAMES), and Xin Zhao's redrawn icons are
 *   `xinzhaorework_circle_<n>`, which count as his ordinary ones.
 * - Each alternate form has its own set — `kayn_ass_circle_15.png`,
 *   `quinnvalor_circle.png` — whose icon replaces the base one when the
 *   champion transforms. Ability icons in the same folder are left out.
 * - Some skins have several icons for one number — `kayle_circle_4_lvl11`,
 *   `lux_circle_7_fire`, `kaisa_circle_71_form2` — all of which are kept.
 *
 * A chroma has no icon of its own and wears its parent skin's: the highest
 * number at or below its id, chosen separately for each form.
 */
export function iconFilesForSkin(listing: string, alias: string, skinId: number): string[] {
  const a = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
  const legacy = LEGACY_BASE_NAMES[a];
  const forms = new Map<string, Map<number, Set<string>>>();
  for (const m of listing.matchAll(/(?<![a-z0-9_])([a-z0-9_]+?)_circle(?:_(\d+))?((?:_[a-z0-9]+)*)\.png/gi)) {
    const prefix = m[1].toLowerCase();
    let form: string;
    if (prefix === legacy) form = '';
    else if (prefix.startsWith(a)) {
      form = prefix.slice(a.length).replace(/^_/, '');
      if (form === 'rework') form = '';
      if (NOT_FORMS.has(form)) continue;
    } else continue;
    const n = m[2] === undefined ? 0 : Number(m[2]);
    if (!forms.has(form)) forms.set(form, new Map());
    const byNum = forms.get(form)!;
    if (!byNum.has(n)) byNum.set(n, new Set());
    byNum.get(n)!.add(m[0].toLowerCase());
  }
  const files = new Set<string>();
  for (const byNum of forms.values()) {
    let pick = -1;
    for (const n of byNum.keys()) if (n <= skinId && n > pick) pick = n;
    if (pick >= 0) for (const f of byNum.get(pick)!) files.add(f);
  }
  return [...files].sort();
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
const FETCH_TIMEOUT_MS = 10_000;

/**
 * GET through a persistent cache: each icon is downloaded once per install and
 * reused until it is a month old (a week for directory listings, which gain
 * entries with new skins). A stale copy is served when the network fails. The
 * request names nothing of ours — no game, player or room — but which files
 * are asked for, and when, does say which champions and skins a team has on;
 * see docs/threat-model.md. Gives up after FETCH_TIMEOUT_MS, or when `signal`
 * aborts.
 */
async function cachedFetch(url: string, maxAgeMs: number, signal?: AbortSignal): Promise<Response> {
  let cache: Cache | null = null;
  try { cache = await caches.open(CACHE_NAME); } catch { cache = null; }
  const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
  if (hit && Date.now() - Number(hit.headers.get(FETCHED_AT) ?? 0) < maxAgeMs) return hit;
  try {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const resp = await fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    if (cache) {
      const body = await resp.clone().blob();
      const headers = new Headers(resp.headers);
      headers.set(FETCHED_AT, String(Date.now()));
      await cache.put(url, new Response(body, { headers })).catch(() => undefined);
    }
    return resp;
  } catch (e) {
    if (hit && !signal?.aborted) return hit;
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
  /** The id matches are reported under (TemplateSet.id). */
  id: string;
  championName: string;
  rawChampionName?: string;
  skinId: number;
}

/** Fetch, cache and prepare every teammate's icon templates, all at once. A
 *  teammate whose icons cannot be had is left out (and logged); SkinAwareScorer
 *  then declines to match at all. Aborting `signal` (the game ended) stops the
 *  downloads and rejects. */
export async function loadTeamTemplates(team: TeammateSkin[], signal?: AbortSignal): Promise<TemplateSet[]> {
  const results = await Promise.all(team.map(async (p): Promise<{ set: TemplateSet | null; note: string }> => {
    const alias = championAlias(p.rawChampionName, p.championName);
    try {
      const listing = await (await cachedFetch(`${CDRAGON}/${alias}/hud/`, LISTING_MAX_AGE_MS, signal)).text();
      const files = iconFilesForSkin(listing, alias, p.skinId);
      if (files.length === 0) throw new Error('no minimap icon in the listing');
      const images = await Promise.all(files.map(async f =>
        decodeRgba(await (await cachedFetch(`${CDRAGON}/${alias}/hud/${f}`, ICON_MAX_AGE_MS, signal)).blob())));
      const vecs = images.flatMap(img => iconTemplates(img.data, img.width, img.height));
      return { set: { id: p.id, vecs }, note: p.championName + ' skin ' + p.skinId + ' (' + files.join(', ') + ')' };
    } catch (e) {
      return { set: null, note: p.championName + ' skin ' + p.skinId + ': unavailable (' + String(e) + ')' };
    }
  }));
  signal?.throwIfAborted();
  console.log('[Skins] Teammate icons: ' + results.map(r => r.note).join('; '));
  return results.flatMap(r => (r.set ? [r.set] : []));
}

// ---------- The scorer ----------

/**
 * Wraps the champion classifier: an icon the skin match clearly says is the
 * local player scores SKIN_SELF_RAW, one it clearly says is a teammate scores
 * 0, and anything it is unsure of keeps the classifier's score. The tracker
 * normalizes, smooths and gates these exactly as it does the model's.
 *
 * Only ever stands in front of a loaded model (isLoaded is the model's), so an
 * unsure icon is scored no differently from a game without skin matching.
 * Matches anything only once it has icons for every player on the team: with
 * one missing, that player's icon could pass for someone else's and clear the
 * margin against the rest.
 */
export class SkinAwareScorer implements BlobScorer {
  private sets: TemplateSet[] = [];
  private tally = { self: 0, other: 0, unsure: 0 };
  private lastTallyLogMs = 0;
  private verdicts: Array<'self' | 'teammate' | null> = [];

  /** `teamIds`: every player on the local player's team, `selfId` among them. */
  constructor(
    private readonly selfId: string,
    private readonly teamIds: string[],
    private inner: BlobScorer | null = null,
  ) {}

  setInner(inner: BlobScorer): void { this.inner = inner; }

  setTemplates(sets: TemplateSet[]): void {
    const have = new Set(sets.filter(s => s.vecs.length > 0).map(s => s.id));
    const missing = this.teamIds.filter(id => !have.has(id));
    const complete = missing.length === 0 && this.teamIds.includes(this.selfId) && this.teamIds.length >= 2 &&
      new Set(this.teamIds).size === this.teamIds.length;
    this.sets = complete ? sets.filter(s => this.teamIds.includes(s.id)) : [];
    if (!complete) {
      console.warn('[Skins] Not matching icons: ' + (missing.length > 0
        ? 'no icons for ' + missing.length + ' of ' + this.teamIds.length + ' players on the team'
        : 'the team roster is unusable'));
    }
  }

  isLoaded(): boolean {
    return !!this.inner?.isLoaded();
  }

  /** Whether icons are being matched (for tests and the log). */
  isMatching(): boolean {
    return this.sets.length > 0;
  }

  lastVerdicts(): Array<'self' | 'teammate' | null> {
    return this.verdicts;
  }

  lastCrops(): ImageData[] {
    return this.inner?.lastCrops?.() ?? [];
  }

  async scoreBlobsForLocalChampion(frame: CaptureFrame, blobs: BlobCropBox[]): Promise<number[]> {
    this.verdicts = blobs.map(() => null);
    if (!this.inner?.isLoaded()) return blobs.map(() => 0);
    const model = await this.inner.scoreBlobsForLocalChampion(frame, blobs);
    if (this.sets.length === 0) return model;
    const verdicts: Array<'self' | 'teammate' | null> = [];
    const scores = blobs.map((b, i) => {
      const who = whoseIcon(frame, b, this.sets);
      if (who === this.selfId) { this.tally.self++; verdicts.push('self'); return Math.max(model[i], SKIN_SELF_RAW); }
      if (who !== null) { this.tally.other++; verdicts.push('teammate'); return 0; }
      this.tally.unsure++;
      verdicts.push(null);
      return model[i];
    });
    this.verdicts = verdicts;
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
