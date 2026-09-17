// Simple in-memory token-bucket rate limiter. No external dependency.
//
// Per-IP and per-connection limits are tracked in maps; idle buckets are
// pruned by a periodic sweep. The state is process-local — if you scale to
// multiple replicas, swap this for Redis or a CRDT bucket. We deliberately
// don't reach for an external dep here: the signaling server is supposed to
// stay ~500 LOC and trivially self-hostable.
//
// Limits are tuned for a real LoL game: 10 Hz position broadcasts, occasional
// signaling bursts at game start, premades sharing a household NAT (so >1
// connection per IP is normal). See `LIMITS` below.

import { isIP } from 'node:net';

export interface RateLimitConfig {
  /** Maximum tokens the bucket can hold. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucket {
  private buckets = new Map<string, Bucket>();
  private readonly cfg: RateLimitConfig;

  constructor(cfg: RateLimitConfig) {
    this.cfg = cfg;
  }

  /**
   * Try to consume one token for the given key. Returns true if granted,
   * false if the bucket is empty (request should be rejected with 429).
   */
  tryConsume(key: string, now: number = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.cfg.capacity, lastRefillMs: now };
      this.buckets.set(key, b);
    }
    // Refill since last visit
    const elapsedSec = (now - b.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      b.tokens = Math.min(this.cfg.capacity, b.tokens + elapsedSec * this.cfg.refillPerSec);
      b.lastRefillMs = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Drop buckets that haven't been touched in `idleMs`. Call periodically to
   * prevent unbounded growth when lots of unique IPs hit the server briefly.
   */
  pruneIdle(idleMs: number, now: number = Date.now()): number {
    let removed = 0;
    for (const [k, b] of this.buckets) {
      if (now - b.lastRefillMs > idleMs) {
        this.buckets.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  /** Snapshot for /health diagnostics or tests. */
  get size(): number {
    return this.buckets.size;
  }
}

/** Per-connection concurrency counter. Used to cap WS connections per IP. */
export class ConcurrencyLimiter {
  private counts = new Map<string, number>();

  constructor(public readonly max: number) {}

  acquire(key: string): boolean {
    const cur = this.counts.get(key) ?? 0;
    if (cur >= this.max) return false;
    this.counts.set(key, cur + 1);
    return true;
  }

  release(key: string): void {
    const cur = this.counts.get(key) ?? 0;
    if (cur <= 1) this.counts.delete(key);
    else this.counts.set(key, cur - 1);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  get size(): number {
    return this.counts.size;
  }
}

/**
 * Limits tuned for the real workload:
 *
 * /turn-credentials — clients call this once per peer connection (≈ once
 *   per game; maybe again on ICE restart). 60/min per IP is far above what
 *   any legit client should ever need but bounds the worst-case Cloudflare
 *   quota burn from a malicious script.
 *
 * /compute-volumes — each client polls this independently during gameplay.
 *   Keyed per PLAYER (ip + name), NOT per IP: multiple players behind one
 *   household NAT each get their own budget. (A shared per-IP bucket silently
 *   429'd everyone in a 2+ stack — every client polls, so two clients at the
 *   10 Hz poll alone exceeded the old 15/sec per-IP cap → no audio for anyone.)
 *   The per-player budget (90/sec) covers the max settable scan rate (60 Hz)
 *   with headroom; a per-IP backstop (400/sec) bounds the total from any one
 *   source (incl. a client spoofing many names).
 *
 * /ws connections per IP — premades from a single household + buffer for
 *   reconnect-during-restart situations. 20 covers most real cases; CG-NAT
 *   ISPs (mobile, some apartments) sharing one IP among many subscribers
 *   would benefit from a higher number — adjust here if you self-host into
 *   such an environment.
 *
 * /ws messages per connection — position broadcasts run at the client's scan
 *   rate (up to 60 Hz) + signaling bursts at game start + occasional
 *   ICE-candidate batches. 100/sec sustained keeps headroom above the 60 Hz
 *   coord stream while still preventing flood-relay abuse through a legit
 *   joiner. (Per-connection, so household NAT sharing doesn't collapse it.)
 */
export const LIMITS = {
  TURN_CREDS: { capacity: 60, refillPerSec: 1 },                  // 60/min, no burst
  // Keyed per PLAYER (ip + name): each genuine client polls independently, so
  // a 90/sec sustained budget covers the max settable scan rate (60 Hz) with
  // 50% headroom. A modified client is bounded to this per name.
  COMPUTE_VOLUMES_PER_PLAYER: { capacity: 180, refillPerSec: 90 },
  // Per-IP backstop for the same endpoint: a full 5-stack premade on one NAT
  // at the max scan rate is 5*60 = 300/sec; 400/sec leaves headroom while
  // bounding the worst case from any single source (incl. name-spoofing).
  COMPUTE_VOLUMES_PER_IP: { capacity: 800, refillPerSec: 400 },
  WS_MESSAGES: { capacity: 200, refillPerSec: 100 },             // 60 Hz coords + signaling headroom
  WS_PER_IP: 20,
  BODY_BYTES: 256 * 1024,                                        // /compute-volumes body cap
  WS_PAYLOAD_BYTES: 64 * 1024,                                   // single WS message cap
} as const;

// ---------- Client IP ----------
//
// Every limiter above is keyed by what `clientIp()` returns, so that string is
// the security boundary: whoever gets to choose it can mint an unlimited supply
// of fresh buckets and none of the limits above mean anything. Two rules keep
// the choice away from the requester:
//
//   1. Forwarding headers are read only when the immediate TCP peer is
//      loopback / private / link-local — i.e. the connection came from a
//      reverse proxy on the operator's own host or Docker bridge. A client that
//      reaches the published port directly arrives with a public address and
//      its headers are ignored outright. Caddy (`trusted_proxies
//      private_ranges`) and Express (`trust proxy: 'uniquelocal'`) draw the
//      same line.
//   2. A header-derived value has to parse as an IP address before it can
//      become a map key, so header text never lands in a `Map`.
//
// The gate assumes the container runtime hands the server the real source
// address. Rootless Docker / Podman rewrite it to the bridge gateway, which is
// private — see docs/self-hosting.md § "Client IP and rate limits".

/** Upper bound on TRUST_PROXY; a chain deeper than this is a typo, not a topology. */
const MAX_TRUST_PROXY_HOPS = 8;

/** Longest name fragment kept in a per-player bucket key. */
const MAX_PLAYER_KEY_NAME = 64;

/** Drop an IPv6 zone id (`fe80::1%eth0`) — it is meaningful only on this host. */
function stripZone(addr: string): string {
  const pct = addr.indexOf('%');
  return pct === -1 ? addr : addr.slice(0, pct);
}

/**
 * Expand an IPv6 address to its eight hextets. Callers validate with `isIP()`
 * first, so `null` is defensive rather than a real input class.
 */
function expandV6(addr: string): number[] | null {
  let s = addr;
  // A trailing dotted quad (`::ffff:1.2.3.4`, `64:ff9b::8.8.8.8`) is two hextets.
  const lastColon = s.lastIndexOf(':');
  const dotted = s.slice(lastColon + 1);
  if (dotted.includes('.')) {
    const octets = dotted.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    s = s.slice(0, lastColon + 1) +
      (((octets[0] << 8) | octets[1]).toString(16)) + ':' +
      (((octets[2] << 8) | octets[3]).toString(16));
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  const parts = [...head, ...new Array(fill).fill('0'), ...tail];
  const out = parts.map((p) => parseInt(p, 16));
  if (out.length !== 8 || out.some((v) => !Number.isInteger(v) || v < 0 || v > 0xffff)) return null;
  return out;
}

/**
 * Parse an address that came from a request header. Returns null for anything
 * that isn't an IP — that null is what stops attacker text from becoming a
 * bucket key. Ports and brackets are stripped and `::ffff:` forms unmapped so
 * one client can't occupy two buckets by varying the spelling.
 */
export function normalizeIp(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1];
  else if (s.includes('.') && s.includes(':') && s.indexOf(':') === s.lastIndexOf(':')) s = s.slice(0, s.indexOf(':'));
  if (s.startsWith('::ffff:')) {
    const mapped = s.slice('::ffff:'.length);
    if (isIP(mapped) === 4) s = mapped;
  }
  return isIP(s) ? s : null;
}

/**
 * Bucket key for an address. IPv6 collapses to its /64 because that is the
 * smallest block a client is guaranteed to own: residential ISPs hand out a
 * /64 or larger and so does every VPS, so keying on all 128 bits would let any
 * v6 client rotate the host portion for a fresh bucket per request — no header
 * spoofing needed. Expanding the hextets also canonicalizes the spelling, so
 * `2001:db8::1` and `2001:0db8:0:0:0:0:0:1` can't be two keys for one host.
 */
function bucketKeyForIp(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const h = expandV6(ip);
  if (!h) return ip;
  return h.slice(0, 4).map((v) => v.toString(16)).join(':') + '::/64';
}

/**
 * Bucket key for the immediate TCP peer. The kernel supplies this, not the
 * request, so a form `isIP()` doesn't recognise (an unusual zone id, say) keeps
 * its own key rather than being funnelled into one shared 'unknown' bucket
 * alongside every other such client.
 */
function socketKey(raw: string | undefined): string {
  if (!raw) return 'unknown';
  const bare = stripZone(raw.trim());
  if (!bare) return 'unknown';
  const ip = normalizeIp(bare);
  return ip ? bucketKeyForIp(ip) : bare;
}

function headerValue(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v.join(',');
  return typeof v === 'string' ? v : '';
}

/** True when the peer address belongs to a range only the operator's own network uses. */
export function isTrustedPeer(addr: string | undefined): boolean {
  // A destroyed socket reports no remote address. There is no unix-socket
  // deployment here (the server is `createServer(...).listen(PORT)`), so an
  // absent peer is a torn-down TCP connection, not a local one — trusting its
  // headers would reopen the bypass in the one path nobody looks at again.
  if (!addr) return false;
  const ip = normalizeIp(stripZone(addr));
  if (!ip) return false;
  if (isIP(ip) === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 127) return true;                               // 127.0.0.0/8
    if (o[0] === 10) return true;                                // 10.0.0.0/8
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;   // 172.16.0.0/12
    if (o[0] === 192 && o[1] === 168) return true;               // 192.168.0.0/16
    if (o[0] === 169 && o[1] === 254) return true;               // 169.254.0.0/16
    return false;
  }
  const h = expandV6(ip);
  if (!h) return false;
  if ((h[0] & 0xfe00) === 0xfc00) return true;                   // fc00::/7 unique-local
  if ((h[0] & 0xffc0) === 0xfe80) return true;                   // fe80::/10 link-local
  return h.every((v, i) => (i === 7 ? v === 1 : v === 0));       // ::1
}

/**
 * Read TRUST_PROXY. Unset means one proxy in front, which is what every
 * deployment in docs/self-hosting.md runs; `off` ignores forwarding headers
 * entirely. A bad value falls back to 1 rather than to 0, because silently
 * dropping to 0 behind a real proxy collapses every user into the proxy's
 * bucket — 429s and no audio for the whole server.
 */
export function parseTrustProxyHops(raw: string | undefined): number {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return 1;
  if (v === 'off' || v === 'false' || v === 'no' || v === '0') return 0;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1) return Math.min(n, MAX_TRUST_PROXY_HOPS);
  console.warn(`[rate-limit] TRUST_PROXY="${raw}" is neither a hop count nor "off" — using 1`);
  return 1;
}

/**
 * Resolve the client address to key rate limits on. See the section comment
 * above for the trust rules. `onUntrustedForward` fires when a forwarding
 * header was present but unusable, which is the only signal that buckets are
 * being merged onto the proxy.
 */
export function clientIp(
  req: { headers: Record<string, string | string[] | undefined>, socket: { remoteAddress?: string } },
  hops: number = 1,
  onUntrustedForward?: () => void,
): string {
  const fallback = socketKey(req.socket.remoteAddress);
  if (hops <= 0 || !isTrustedPeer(req.socket.remoteAddress)) return fallback;

  // X-Real-IP is only meaningful one hop out: with a CDN in front it holds the
  // edge's address, not the client's.
  const rawReal = hops === 1 ? headerValue(req.headers['x-real-ip']) : '';
  const realIp = rawReal ? normalizeIp(rawReal) : null;

  const rawXff = headerValue(req.headers['x-forwarded-for']);
  const entries = rawXff.split(',').map((e) => e.trim()).filter((e) => e.length > 0);
  // `hops` counts the proxies of yours that APPEND to the list, so the address
  // your outermost trusted proxy observed is entries[len - hops]: with one
  // proxy that is the rightmost entry and nothing is discarded. A list shorter
  // than `hops` means the chain isn't what TRUST_PROXY claims — take the
  // rightmost entry, never entries[0], which is the one value a requester can
  // always write for themselves.
  const pick = entries.length > 0
    ? entries[entries.length >= hops ? entries.length - hops : entries.length - 1]
    : '';
  const xffIp = pick ? normalizeIp(pick) : null;

  if (realIp && xffIp && bucketKeyForIp(realIp) !== bucketKeyForIp(xffIp)) {
    // Disagreement means one of the two was written by the requester: nginx's
    // `proxy_set_header X-Real-IP` replaces, but a client's X-Forwarded-For
    // passes through untouched unless the config sets it; Caddy sanitizes
    // X-Forwarded-For but leaves X-Real-IP alone. Neither is believable here,
    // so key on the proxy — a shared bucket beats an attacker-chosen one.
    onUntrustedForward?.();
    return fallback;
  }
  if (realIp) return bucketKeyForIp(realIp);
  if (xffIp) return bucketKeyForIp(xffIp);
  if (entries.length > 0 || rawReal) onUntrustedForward?.();
  return fallback;
}

/**
 * Bucket key for the per-player /compute-volumes limit. A NUL joins the parts —
 * an IP never contains one and neither does a name the client can type, so
 * distinct (ip, name) pairs never collide — and the name is truncated because
 * it is unbounded request text that would otherwise sit in the limiter map at
 * up to the body cap's size. Truncation bounds entry SIZE, not entry COUNT; the
 * per-IP backstop bounds the rate at which one source can create them.
 */
export function playerKey(ip: string, name: unknown): string {
  if (typeof name !== 'string' || !name) return ip;
  return ip + '\0' + name.slice(0, MAX_PLAYER_KEY_NAME);
}

/**
 * Why a request was turned away. `xff_invalid` is not a rejected request: it
 * counts forwarding headers that couldn't be used, which is what an operator
 * needs to see when a proxy misconfiguration starts merging buckets.
 */
export type RejectReason =
  | 'turn_creds_ip'
  | 'compute_volumes_ip'
  | 'compute_volumes_player'
  | 'body_too_large'
  | 'ws_per_ip'
  | 'ws_messages'
  | 'xff_invalid';

/**
 * Aggregate rejection counts. Deliberately counts only — no IPs and no player
 * names, so this stays inside the no-per-user-logging promise in
 * docs/threat-model.md while still turning a silent 429 storm into something
 * visible in `docker logs`.
 */
export class RejectionCounters {
  private totals = new Map<RejectReason, number>();
  private reported = new Map<RejectReason, number>();

  bump(reason: RejectReason): void {
    this.totals.set(reason, (this.totals.get(reason) ?? 0) + 1);
  }

  /** Process-lifetime totals, monotonic. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.totals);
  }

  /** Counts since the previous call, for periodic logging. Empty when nothing moved. */
  drainDeltas(): Record<string, number> {
    const deltas: Record<string, number> = {};
    for (const [reason, total] of this.totals) {
      const delta = total - (this.reported.get(reason) ?? 0);
      if (delta > 0) {
        deltas[reason] = delta;
        this.reported.set(reason, total);
      }
    }
    return deltas;
  }
}
