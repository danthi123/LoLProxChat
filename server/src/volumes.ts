const crypto = globalThis.crypto;

// Per-request diagnostic logging for the tiered-volume path. Off unless the
// server is started with DEBUG_VOLUMES=1. Logs each /compute-volumes
// decision (requester team/range + per-peer team/distance/result) so
// cross-client issues (e.g. asymmetric audibility) are diagnosable from the
// server alone instead of needing both clients' debug logs.
const DEBUG_VOLUMES = process.env.DEBUG_VOLUMES === '1';

// Max cross-team hearing distance ≈ a champion's standard sight range, so an
// enemy fades in (very faintly) about when they'd enter your vision and grows
// louder as they close. Game units (Summoner's Rift is ~14870x14980).
const MAX_HEARING_RANGE = 1350;

// Inside this radius an enemy is simply audible, with no distance attenuation
// at all. It sits just past the distance two ranged laners hold against each
// other, because the pure-falloff curve put a normal ranged trade at roughly
// half volume while a melee trade sat near full — so the people the feature is
// for could not hold a conversation in lane without walking into each other.
//
// This is deliberately NOT a change to what is audible: MAX_HEARING_RANGE is
// the compliance boundary (see docs/compliance.md) and is untouched. The only
// thing that changes is loudness inside a radius a player could already hear
// across. It also narrows the volume side channel rather than widening it —
// inside the plateau, volume no longer encodes distance at all.
const FULL_VOLUME_RANGE = 900;
// Max age of an encrypted position blob the server will accept before
// rejecting it as stale. Tuned to absorb common Windows-clock drift
// (NTP service can lag 10-30s in the wild — we saw this in issue #7
// where one user's clock was ~12s behind real time and every blob was
// being rejected, breaking proximity audio entirely on the other side).
// Security tradeoff: this is the replay window for a captured blob.
// 30s is fine because the volume side-channel is already coarsened by
// quantization + jitter (see docs/threat-model.md Part 1).
const BLOB_MAX_AGE_MS = 30_000;

// v0.1 request shape — peers field carries encrypted XY blobs from each peer.
// Kept for back-compat during the v0.2 transition; clients still on the old
// path send this. See computeVolumes() below.
export interface VolumeRequest {
  myPosition: { x: number; y: number };
  peers: Record<string, string>; // name -> encrypted blob (base64)
}

// v0.2 request shape — peers are read from server-side room state instead
// of being shipped in the request. See computeVolumesFromRoom() below.
export interface VolumeRequestV2 {
  myPosition: { x: number; y: number };
  roomId: string;
  name: string;
  // When true, the requester hears allies by proximity (same distance falloff as
  // enemies) instead of always at full volume. Per-user preference; optional for
  // backward compatibility — absent means global/full (the default, #22).
  allyProximity?: boolean;
  // "Voice on camera" (#36). When present, THIS is the point the requester
  // hears the map from — the centre of their in-game camera rather than their
  // champion. Strictly listen-only: it is used solely to score what this
  // requester hears, and never replaces the champion position that peers
  // measure their own distance against (that one lives in room state, fed by
  // `coords`). Absent means "hear from my champion", the default.
  listenPosition?: { x: number; y: number };
}

export interface VolumeResponse {
  myBlob: string;   // v0.1 path only; v0.2 returns "" since there's nothing to broadcast
  peerVolumes: Record<string, number>;
}

/**
 * How stale a peer's last-reported XY can be before the server skips them in
 * volume computation. The client sends coords on every positionTick (~10 Hz)
 * and stops sending after CV has been holding/extrapolating for >2 s, so a
 * 5 s window means at most ~3 s of phantom audio after a peer drops or
 * loses tracking — short enough to avoid hearing players who are no longer
 * where the server thinks they are, generous enough to absorb a brief WSS
 * stall without flickering them silent.
 */
const STALE_POSITION_MS = 5_000;

// ---------- helpers ----------

function isFinitePoint(p: unknown): p is { x: number; y: number } {
  return !!p && typeof p === 'object' &&
    typeof (p as any).x === 'number' && typeof (p as any).y === 'number' &&
    isFinite((p as any).x) && isFinite((p as any).y);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(byte)) throw new Error('Invalid hex in encryption key');
    bytes[i / 2] = byte;
  }
  return bytes;
}

async function importKey(hexKey: string): Promise<CryptoKey> {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error('ENCRYPTION_KEY must be 64 hex chars (256-bit)');
  }
  const keyBytes = hexToBytes(hexKey);
  return crypto.subtle.importKey('raw', keyBytes.buffer as ArrayBuffer, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

// ---------- public API ----------

export function calculateVolume(distance: number): number {
  if (distance >= MAX_HEARING_RANGE) return 0.0;
  if (distance <= FULL_VOLUME_RANGE) return 1.0;
  // Quadratic falloff across the outer band only, so an enemy still fades
  // rather than cutting out at the edge of the radius.
  //
  // Reverted v0.1.26 quantization (5 buckets) + ±5% jitter in v0.1.33:
  // The bucket transitions produced audible "cliffs" in real gameplay,
  // especially when peer CV was jittering between teal blobs near each
  // other (issue #14 / #7 logs). The anti-cheat precision-protection
  // argument was marginal at our user scale; jitter alone wasn't
  // restoring smoothness because each new sample still crossed bucket
  // boundaries. Reverted to continuous output; client-side EMA handles
  // transitions naturally. See docs/threat-model.md Part 1 for the
  // updated mitigation table.
  const t = (distance - FULL_VOLUME_RANGE) / (MAX_HEARING_RANGE - FULL_VOLUME_RANGE);
  return Math.max(0, 1 - t * t);
}

export async function encryptPosition(
  hexKey: string,
  x: number,
  y: number,
): Promise<string> {
  const key = await importKey(hexKey);
  const timestamp = Date.now();
  const payload = new TextEncoder().encode(
    JSON.stringify({ x, y, t: timestamp }),
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    payload,
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return Buffer.from(combined).toString('base64');
}

export async function decryptPosition(
  hexKey: string,
  blob: string,
): Promise<{ x: number; y: number } | null> {
  try {
    const key = await importKey(hexKey);
    const combined = new Uint8Array(Buffer.from(blob, 'base64'));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    );
    const payload = JSON.parse(new TextDecoder().decode(decrypted));
    if (typeof payload.t !== 'number') {
      return null;
    }
    const ageMs = Date.now() - payload.t;
    if (Math.abs(ageMs) > BLOB_MAX_AGE_MS) {
      // Surface clock skew as a structured log so we can spot patterns in
      // user-reported voice issues (silent rejection used to swallow this).
      console.warn(
        '[volumes] blob rejected: age=' + ageMs +
        'ms exceeds limit ' + BLOB_MAX_AGE_MS + 'ms (client clock skew?)',
      );
      return null;
    }
    return { x: payload.x, y: payload.y };
  } catch {
    return null;
  }
}

export async function computeVolumes(
  body: VolumeRequest,
  encryptionKey: string,
): Promise<VolumeResponse> {
  // Validate input
  if (
    !body.myPosition ||
    typeof body.myPosition.x !== 'number' ||
    typeof body.myPosition.y !== 'number' ||
    !isFinite(body.myPosition.x) ||
    !isFinite(body.myPosition.y)
  ) {
    throw new Error('Invalid position');
  }
  if (body.peers && typeof body.peers !== 'object') {
    throw new Error('Invalid peers');
  }

  const myBlob = await encryptPosition(
    encryptionKey,
    body.myPosition.x,
    body.myPosition.y,
  );

  const peerVolumes: Record<string, number> = {};
  for (const [name, peerBlob] of Object.entries(body.peers ?? {})) {
    const peerPos = await decryptPosition(encryptionKey, peerBlob);
    if (!peerPos) {
      peerVolumes[name] = 0;
      continue;
    }
    const dx = body.myPosition.x - peerPos.x;
    const dy = body.myPosition.y - peerPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    peerVolumes[name] = calculateVolume(distance);
  }

  return { myBlob, peerVolumes };
}

// ---------- v0.2 path: positions live in server-side room state ----------

/**
 * Reads peer XY positions from server-side room state (populated by
 * 'coords' WSS messages) and computes pairwise distance volumes for the
 * requester. No encryption involved on either side — the request is on
 * HTTPS, the room state lives in process memory.
 *
 * `getPositions` is injected so this stays unit-testable without a real
 * RoomManager. Pass `(roomId, exceptName) => rooms.getRoomPositions(...)`
 * from the HTTP handler.
 */
export function computeVolumesFromRoom(
  body: VolumeRequestV2,
  getPositions: (roomId: string, exceptName: string, staleMs: number) => Record<string, { x: number; y: number }>,
): VolumeResponse {
  if (
    !body.myPosition ||
    typeof body.myPosition.x !== 'number' ||
    typeof body.myPosition.y !== 'number' ||
    !isFinite(body.myPosition.x) ||
    !isFinite(body.myPosition.y)
  ) {
    throw new Error('Invalid position');
  }
  if (typeof body.roomId !== 'string' || !body.roomId) {
    throw new Error('Invalid roomId');
  }
  if (typeof body.name !== 'string' || !body.name) {
    throw new Error('Invalid name');
  }

  const positions = getPositions(body.roomId, body.name, STALE_POSITION_MS);
  const peerVolumes: Record<string, number> = {};
  for (const [name, pos] of Object.entries(positions)) {
    const dx = body.myPosition.x - pos.x;
    const dy = body.myPosition.y - pos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    peerVolumes[name] = calculateVolume(distance);
  }

  // v0.2 doesn't produce a myBlob — there's nothing for the requester to
  // re-broadcast (server already has their position from the most recent
  // 'coords' message). Return empty string for type-shape compatibility
  // with the legacy response.
  return { myBlob: '', peerVolumes };
}

// ---------- v0.3 path: tiered proximity (team-aware) ----------

export interface TieredRoomClient {
  name: string;
  team?: 'ORDER' | 'CHAOS';
  position?: { x: number; y: number; updatedMs: number };
}

/**
 * v0.3 tiered proximity. Server-authoritative team filter.
 *
 * Allies (same team as requester) always come back at 1.0 regardless of
 * distance. Cross-team peers (enemies) come back at their distance-based
 * volume out to MAX_HEARING_RANGE (≈ a champion's vision range): they fade
 * in very faintly as they enter that radius and grow louder as they close.
 * Out-of-range peers are absent from the response entirely (the server
 * simply doesn't tell the requester they exist — a modified client cannot
 * bypass the cutoff to hear distant enemies).
 *
 * When the requester has no team set (legacy v0.2 client), every peer goes
 * through the same distance falloff (team-blind).
 */
export function computeTieredVolumes(
  body: VolumeRequestV2,
  getRoomClients: (roomId: string) => TieredRoomClient[],
): VolumeResponse {
  if (!body.myPosition ||
      typeof body.myPosition.x !== 'number' || typeof body.myPosition.y !== 'number' ||
      !isFinite(body.myPosition.x) || !isFinite(body.myPosition.y)) {
    throw new Error('Invalid position');
  }
  if (typeof body.roomId !== 'string' || !body.roomId) throw new Error('Invalid roomId');
  if (typeof body.name !== 'string' || !body.name) throw new Error('Invalid name');

  // The point this requester hears FROM. `listenPosition` (camera centre, #36)
  // when the client sent one, otherwise their champion position. Validated the
  // same way as myPosition — a malformed one falls back rather than throwing,
  // so an older/broken client still gets normal proximity audio.
  const listenFrom = isFinitePoint(body.listenPosition)
    ? body.listenPosition!
    : body.myPosition;

  const clients = getRoomClients(body.roomId);
  const me = clients.find(c => c.name === body.name);
  if (!me) {
    if (DEBUG_VOLUMES) {
      console.log('[volumes] req name=' + JSON.stringify(body.name) +
        ' NOT FOUND in room ' + body.roomId + ' (known: ' +
        clients.map(c => JSON.stringify(c.name)).join(',') + ')');
    }
    return { myBlob: '', peerVolumes: {} };
  }

  // Cross-team peers are audible out to MAX_HEARING_RANGE (≈ vision range),
  // fading to silence at the edge. `legacy` (no team) means we can't tell
  // allies from enemies, so everyone goes through the distance falloff.
  const legacy = me.team === undefined;
  const range = MAX_HEARING_RANGE;

  const cutoff = Date.now() - STALE_POSITION_MS;
  const peerVolumes: Record<string, number> = {};
  const trace: string[] = [];

  for (const peer of clients) {
    if (peer.name === me.name) continue;

    if (!legacy && peer.team === me.team && !body.allyProximity) {
      // Global ally voice (default): always full volume, no proximity. We even
      // skip the staleness check — an ally in SCANNING / long-hold hasn't
      // reported coords recently but is still actively transmitting audio. What
      // makes that safe is that a truly-gone peer is removed from room state:
      // RoomManager.leave on a clean close, and the WebSocket heartbeat
      // (server/src/heartbeat.ts) for a half-open socket that never fires one.
      // Without the heartbeat this branch holds a vanished ally at 1.0 for as
      // long as the OS takes to time the TCP connection out.
      // (When the requester opts into allyProximity, allies fall through to the
      // distance falloff below, exactly like cross-team peers.)
      peerVolumes[peer.name] = 1.0;
      if (DEBUG_VOLUMES) trace.push(peer.name + '[ally team=' + peer.team + ']=1.0');
      continue;
    }

    if (!peer.position) {
      if (DEBUG_VOLUMES) trace.push(peer.name + '[cross team=' + peer.team + ' NO-POS]=skip');
      continue;
    }
    if (peer.position.updatedMs < cutoff) {
      if (DEBUG_VOLUMES) trace.push(peer.name + '[cross team=' + peer.team + ' STALE]=skip');
      continue;
    }

    const dx = listenFrom.x - peer.position.x;
    const dy = listenFrom.y - peer.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist >= range) {
      if (DEBUG_VOLUMES) trace.push(peer.name + '[cross team=' + peer.team + ' dist=' + Math.round(dist) + ' >= range=' + range + ']=skip');
      continue;
    }
    peerVolumes[peer.name] = calculateVolume(dist);
    if (DEBUG_VOLUMES) trace.push(peer.name + '[cross team=' + peer.team + ' dist=' + Math.round(dist) + ']=' + calculateVolume(dist).toFixed(2));
  }

  if (DEBUG_VOLUMES) {
    const listenTag = listenFrom === body.myPosition
      ? ''
      : ' listenFrom=camera(' + Math.round(listenFrom.x) + ',' + Math.round(listenFrom.y) + ')';
    console.log('[volumes] req me=' + JSON.stringify(me.name) +
      ' team=' + me.team + ' legacy=' + legacy + ' range=' + range + listenTag +
      ' | ' + (trace.length ? trace.join(' ') : '(no peers)'));
  }

  return { myBlob: '', peerVolumes };
}
