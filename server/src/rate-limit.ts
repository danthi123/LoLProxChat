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
// of fresh buckets and none of the limits above mean anything. Three rules keep
// the choice away from the requester:
//
//   1. Forwarding headers are read only when the immediate TCP peer is one of
//      the operator's own proxies — an address in TRUSTED_PROXIES, or (in the
//      deprecated hop-count mode) loopback / private / link-local. A client
//      that reaches the published port directly arrives from somewhere else
//      and its headers are ignored outright.
//   2. `X-Forwarded-For` is walked RIGHT to LEFT and stops at the first entry
//      that isn't a listed proxy. Each entry was written by the hop to its
//      right, so the rightmost is the only one our own proxy vouches for and
//      everything left of the first stranger was appended by something we do
//      not control. This is the model `proxy-addr` (Express) uses.
//   3. A header-derived value has to parse as an IP address before it can
//      become a map key, so header text never lands in a `Map`.
//
// Rule 2 is why a list beats a hop count: counting hops assumes every entry is
// genuine, so a requester who pads the header with `hops - 1` junk entries
// moves the counted index onto a value they wrote. Walking until a stranger
// appears never lands left of the real client no matter how much padding
// precedes it. TRUST_PROXY (the count) is kept as a deprecated alias so
// existing deployments keep running across the upgrade.
//
// All of this assumes the container runtime hands the server the real source
// address. Rootless Docker / Podman rewrite it to the bridge gateway, which is
// private — see docs/self-hosting.md § "Client IP and rate limits".

/** Upper bound on TRUST_PROXY; a chain deeper than this is a typo, not a topology. */
const MAX_TRUST_PROXY_HOPS = 8;

/** Upper bound on TRUSTED_PROXIES entries; more than this is a paste error, not a fleet. */
const MAX_TRUSTED_PROXY_NETS = 64;

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

// ---------- Trusted-proxy networks ----------

/** An IP network. `parts` are address groups, `prefix` the significant bit count. */
export interface CidrNet {
  readonly v: 4 | 6;
  readonly parts: readonly number[];
  readonly prefix: number;
}

/** Bits per address group: octets for IPv4, hextets for IPv6. */
const GROUP_BITS = { 4: 8, 6: 16 } as const;

/** Split an already-validated address into its groups. */
function addressGroups(ip: string): { v: 4 | 6; parts: number[] } | null {
  const fam = isIP(ip);
  if (fam === 4) return { v: 4, parts: ip.split('.').map(Number) };
  if (fam !== 6) return null;
  const h = expandV6(ip);
  return h ? { v: 6, parts: h } : null;
}

/**
 * Parse one `address` or `address/length` entry. Returns null for anything that
 * isn't a network, which is what keeps a typo in TRUSTED_PROXIES from widening
 * trust instead of narrowing it. A `::ffff:` form normalizes to its IPv4
 * address first, so its prefix length must be an IPv4 one.
 */
export function parseCidr(raw: string): CidrNet | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const slash = s.lastIndexOf('/');
  const addr = normalizeIp(slash === -1 ? s : s.slice(0, slash));
  if (!addr) return null;
  const groups = addressGroups(addr);
  if (!groups) return null;
  const full = groups.parts.length * GROUP_BITS[groups.v];
  if (slash === -1) return { v: groups.v, parts: groups.parts, prefix: full };
  const n = Number(s.slice(slash + 1));
  if (!Number.isInteger(n) || n < 0 || n > full) return null;
  return { v: groups.v, parts: groups.parts, prefix: n };
}

/** True when `ip` falls inside `net`. Families never match across each other. */
export function ipInNet(ip: string, net: CidrNet): boolean {
  const a = addressGroups(ip);
  if (!a || a.v !== net.v) return false;
  const width = GROUP_BITS[net.v];
  let remaining = net.prefix;
  for (let i = 0; remaining > 0; i++) {
    const shift = width - Math.min(width, remaining);
    if (a.parts[i] >>> shift !== net.parts[i] >>> shift) return false;
    remaining -= width;
  }
  return true;
}

function inAnyNet(ip: string, nets: readonly CidrNet[]): boolean {
  return nets.some((n) => ipInNet(ip, n));
}

/**
 * The ranges a reverse proxy on the operator's own host or Docker network can
 * appear from. Spelled `private` in TRUSTED_PROXIES, and the whole definition
 * of a trusted peer in the deprecated hop-count mode. Matches what Caddy calls
 * `private_ranges` and Express calls `uniquelocal`.
 */
const PRIVATE_NETS: readonly CidrNet[] = [
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16',
  '::1/128', 'fc00::/7', 'fe80::/10',
].map((c) => parseCidr(c) as CidrNet);

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
  return ip !== null && inAnyNet(ip, PRIVATE_NETS);
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

/** The `off` spellings shared by TRUST_PROXY and TRUSTED_PROXIES. */
function isOff(v: string): boolean {
  const s = v.trim().toLowerCase();
  return s === 'off' || s === 'false' || s === 'no' || s === '0';
}

/**
 * Read TRUSTED_PROXIES: a comma- or space-separated list of the addresses and
 * CIDRs the operator's own proxies connect from, plus the keyword `private`
 * for the loopback/RFC1918/link-local set. Unusable entries are dropped with a
 * warning rather than widening the list.
 */
export function parseTrustedProxies(raw: string | undefined): CidrNet[] {
  const nets: CidrNet[] = [];
  for (const token of (raw ?? '').split(/[,\s]+/).filter((t) => t.length > 0)) {
    if (token.toLowerCase() === 'private') {
      nets.push(...PRIVATE_NETS);
      continue;
    }
    const net = parseCidr(token);
    if (!net) {
      console.warn(`[rate-limit] TRUSTED_PROXIES entry "${token}" is not an address or CIDR — ignoring it`);
      continue;
    }
    if (net.prefix === 0) {
      // A /0 claims every address on the internet is one of your proxies, which
      // makes the walk stop nowhere and hands the bucket key back to whoever
      // wrote the header — the exact bypass this list exists to close.
      console.warn(`[rate-limit] TRUSTED_PROXIES entry "${token}" covers every address — ignoring it`);
      continue;
    }
    nets.push(net);
  }
  if (nets.length > MAX_TRUSTED_PROXY_NETS) {
    console.warn(`[rate-limit] TRUSTED_PROXIES has ${nets.length} entries — using the first ${MAX_TRUSTED_PROXY_NETS}`);
    return nets.slice(0, MAX_TRUSTED_PROXY_NETS);
  }
  return nets;
}

/**
 * How much of a request's forwarding headers to believe. A non-empty `nets`
 * selects the right-to-left walk; otherwise `hops` drives the deprecated
 * count-based path (0 = ignore forwarding headers entirely).
 */
export interface ProxyTrust {
  readonly nets: readonly CidrNet[];
  readonly hops: number;
}

/**
 * Resolve the two environment variables into one trust decision. TRUSTED_PROXIES
 * wins where it is usable; TRUST_PROXY remains as a deprecated alias so a
 * deployment that upgrades without editing its compose file keeps the behaviour
 * it had. A TRUSTED_PROXIES that parses to nothing falls back to the hop count
 * rather than to 0, for the same reason parseTrustProxyHops does: dropping a
 * proxied deployment to 0 collapses every user into the proxy's bucket.
 */
export function resolveProxyTrust(
  trustedProxies: string | undefined,
  trustProxy: string | undefined,
): ProxyTrust {
  const listed = (trustedProxies ?? '').trim();
  if (listed && isOff(listed)) return { nets: [], hops: 0 };
  if (listed) {
    const nets = parseTrustedProxies(listed);
    if (nets.length > 0) {
      if ((trustProxy ?? '').trim()) {
        console.warn('[rate-limit] TRUST_PROXY is ignored while TRUSTED_PROXIES is set');
      }
      return { nets, hops: 1 };
    }
    console.warn('[rate-limit] TRUSTED_PROXIES had no usable entries — falling back to TRUST_PROXY');
  }
  const hops = parseTrustProxyHops(trustProxy);
  if ((trustProxy ?? '').trim() && hops > 0) {
    console.warn(
      '[rate-limit] TRUST_PROXY counts hops, which a padded X-Forwarded-For can shift — ' +
      'list your proxies in TRUSTED_PROXIES instead (docs/self-hosting.md § "Client IP and rate limits")',
    );
  }
  return { nets: [], hops };
}

/** One line for the startup log, so an operator can see what the process resolved. */
export function describeProxyTrust(trust: ProxyTrust): string {
  if (trust.nets.length > 0) {
    return `${trust.nets.length} trusted proxy network(s), X-Forwarded-For walked right-to-left`;
  }
  return trust.hops > 0
    ? `${trust.hops} hop(s), private peers only (TRUST_PROXY, deprecated)`
    : 'disabled (forwarding headers ignored)';
}

/**
 * Resolve the client address to key rate limits on. See the section comment
 * above for the trust rules. `onUntrustedForward` fires when a forwarding
 * header was present but unusable, which is the only signal that buckets are
 * being merged onto the proxy.
 *
 * `trust` accepts a bare hop count so the deprecated path stays callable and
 * directly testable.
 */
export function clientIp(
  req: { headers: Record<string, string | string[] | undefined>, socket: { remoteAddress?: string } },
  trust: number | ProxyTrust = 1,
  onUntrustedForward?: () => void,
): string {
  if (typeof trust !== 'number' && trust.nets.length > 0) {
    return clientIpByProxyList(req, trust.nets, onUntrustedForward);
  }
  return clientIpByHopCount(req, typeof trust === 'number' ? trust : trust.hops, onUntrustedForward);
}

/**
 * Walk X-Forwarded-For right to left and stop at the first entry that is not a
 * listed proxy. Padding the header cannot move that stop point: extra entries
 * only ever sit LEFT of the real client, which the walk has already passed.
 */
function clientIpByProxyList(
  req: { headers: Record<string, string | string[] | undefined>, socket: { remoteAddress?: string } },
  nets: readonly CidrNet[],
  onUntrustedForward?: () => void,
): string {
  const rawPeer = req.socket.remoteAddress;
  const fallback = socketKey(rawPeer);
  const peer = rawPeer ? normalizeIp(stripZone(rawPeer)) : null;
  // The peer address comes from the kernel. If it is not one of the operator's
  // proxies, nothing the request claims about who sent it can be believed.
  if (!peer || !inAnyNet(peer, nets)) return fallback;

  const entries = headerValue(req.headers['x-forwarded-for'])
    .split(',').map((e) => e.trim()).filter((e) => e.length > 0);

  for (let i = entries.length - 1; i >= 0; i--) {
    const ip = normalizeIp(entries[i]);
    // An unparseable entry hides whose address it was, so the entries further
    // left can no longer be attributed either. Stop rather than step over it.
    if (!ip) break;
    if (!inAnyNet(ip, nets)) return bucketKeyForIp(ip);
  }

  if (entries.length === 0) {
    // nginx configs that set only `X-Real-IP` leave no list to walk. Caddy is
    // the other way round — it writes X-Forwarded-For and passes a client's
    // X-Real-IP through untouched — so this header is read only when the walk
    // found nothing, never as a tiebreaker against it.
    const rawReal = headerValue(req.headers['x-real-ip']);
    const realIp = rawReal ? normalizeIp(rawReal) : null;
    if (realIp) return bucketKeyForIp(realIp);
    if (rawReal) onUntrustedForward?.();
    return fallback;
  }
  // Either an entry was unusable or every entry is one of our own proxies.
  // Neither identifies a client, so key on the proxy: a shared bucket beats a
  // requester-chosen one.
  onUntrustedForward?.();
  return fallback;
}

/**
 * Deprecated hop-count path, kept so TRUST_PROXY deployments survive the
 * upgrade. Retained weakness: it trusts the entry at a counted index, so a
 * requester who pads the header to exactly `hops` entries picks that index's
 * value themselves. TRUSTED_PROXIES is the fix; this is the compatibility path.
 */
function clientIpByHopCount(
  req: { headers: Record<string, string | string[] | undefined>, socket: { remoteAddress?: string } },
  hops: number,
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
