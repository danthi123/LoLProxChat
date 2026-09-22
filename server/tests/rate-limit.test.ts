import { describe, it, expect, vi } from 'vitest';
import {
  TokenBucket,
  ConcurrencyLimiter,
  clientIp,
  isTrustedPeer,
  normalizeIp,
  parseCidr,
  ipInNet,
  parseTrustedProxies,
  parseTrustProxyHops,
  resolveProxyTrust,
  describeProxyTrust,
  playerKey,
  RejectionCounters,
} from '../src/rate-limit.js';

describe('TokenBucket', () => {
  it('allows up to capacity tokens immediately, then rejects', () => {
    const b = new TokenBucket({ capacity: 3, refillPerSec: 1 });
    const t = 1_000_000;
    expect(b.tryConsume('ip1', t)).toBe(true);
    expect(b.tryConsume('ip1', t)).toBe(true);
    expect(b.tryConsume('ip1', t)).toBe(true);
    expect(b.tryConsume('ip1', t)).toBe(false);  // bucket empty
  });

  it('refills tokens at the configured rate', () => {
    const b = new TokenBucket({ capacity: 5, refillPerSec: 10 });
    const t0 = 1_000_000;
    // Drain it
    for (let i = 0; i < 5; i++) expect(b.tryConsume('ip1', t0)).toBe(true);
    expect(b.tryConsume('ip1', t0)).toBe(false);
    // 200 ms later we should have ~2 tokens back
    expect(b.tryConsume('ip1', t0 + 200)).toBe(true);
    expect(b.tryConsume('ip1', t0 + 200)).toBe(true);
    expect(b.tryConsume('ip1', t0 + 200)).toBe(false);
  });

  it('caps refill at capacity (no infinite accumulation)', () => {
    const b = new TokenBucket({ capacity: 3, refillPerSec: 1 });
    const t0 = 0;
    expect(b.tryConsume('ip1', t0)).toBe(true);
    // 1 hour later, should not have 3600 tokens — capped at 3
    const t1 = t0 + 60 * 60 * 1000;
    expect(b.tryConsume('ip1', t1)).toBe(true);
    expect(b.tryConsume('ip1', t1)).toBe(true);
    expect(b.tryConsume('ip1', t1)).toBe(true);
    expect(b.tryConsume('ip1', t1)).toBe(false);
  });

  it('tracks per-key buckets independently', () => {
    const b = new TokenBucket({ capacity: 2, refillPerSec: 0 });
    const t = 0;
    expect(b.tryConsume('ip1', t)).toBe(true);
    expect(b.tryConsume('ip1', t)).toBe(true);
    expect(b.tryConsume('ip1', t)).toBe(false);
    // ip2 has its own bucket, full
    expect(b.tryConsume('ip2', t)).toBe(true);
    expect(b.tryConsume('ip2', t)).toBe(true);
    expect(b.tryConsume('ip2', t)).toBe(false);
  });

  it('pruneIdle drops buckets older than idleMs', () => {
    const b = new TokenBucket({ capacity: 1, refillPerSec: 0 });
    b.tryConsume('ip1', 0);
    b.tryConsume('ip2', 1000);
    b.tryConsume('ip3', 5000);
    expect(b.size).toBe(3);
    const removed = b.pruneIdle(/*idleMs*/ 2000, /*now*/ 5000);
    expect(removed).toBe(2);   // ip1 (5s old) + ip2 (4s old) gone
    expect(b.size).toBe(1);    // ip3 (0s old) stays
  });
});

describe('ConcurrencyLimiter', () => {
  it('grants up to max acquires per key, then rejects', () => {
    const c = new ConcurrencyLimiter(3);
    expect(c.acquire('ip1')).toBe(true);
    expect(c.acquire('ip1')).toBe(true);
    expect(c.acquire('ip1')).toBe(true);
    expect(c.acquire('ip1')).toBe(false);
    expect(c.count('ip1')).toBe(3);
  });

  it('release decrements the count', () => {
    const c = new ConcurrencyLimiter(2);
    c.acquire('ip1');
    c.acquire('ip1');
    expect(c.acquire('ip1')).toBe(false);
    c.release('ip1');
    expect(c.acquire('ip1')).toBe(true);
  });

  it('release on last drops the key entirely', () => {
    const c = new ConcurrencyLimiter(2);
    c.acquire('ip1');
    c.release('ip1');
    expect(c.size).toBe(0);
  });

  it('tracks per-key independently', () => {
    const c = new ConcurrencyLimiter(1);
    expect(c.acquire('ip1')).toBe(true);
    expect(c.acquire('ip2')).toBe(true);   // separate key, fresh count
    expect(c.acquire('ip1')).toBe(false);
    expect(c.acquire('ip2')).toBe(false);
  });
});

describe('clientIp', () => {
  it('ignores forwarding headers from a public peer (the direct-exposure bypass)', () => {
    // Asserts THE security property: a client reaching the published port
    // directly cannot choose its own bucket key. Before the private-peer gate
    // this returned '1.2.3.4' and every rotated header minted a fresh bucket.
    const ip = clientIp({
      headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' },
      socket: { remoteAddress: '203.0.113.9' },
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('ignores forwarding headers entirely when hops is 0 (TRUST_PROXY=off)', () => {
    // Asserts the kill switch overrides even a loopback peer.
    const ip = clientIp({
      headers: { 'x-forwarded-for': '1.2.3.4' },
      socket: { remoteAddress: '127.0.0.1' },
    }, 0);
    expect(ip).toBe('127.0.0.1');
  });

  it('takes the entry the outermost trusted proxy observed, not the leftmost', () => {
    // Asserts entries[len - hops]: with one proxy that is the rightmost entry,
    // which is the only one the proxy itself wrote. The leftmost is whatever
    // the requester sent.
    const ip = clientIp({
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('keeps the single-entry case working from a Docker bridge peer', () => {
    // Asserts the modern-Caddy path (sanitized XFF, one entry) still resolves
    // to the real client — the availability half of this change.
    const ip = clientIp({
      headers: { 'x-forwarded-for': '203.0.113.9' },
      socket: { remoteAddress: '172.17.0.1' },
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('indexes by hop count for a CDN chain (hops=2)', () => {
    // Asserts entries[len - 2] with Cloudflare → Caddy: the CDN edge is the
    // rightmost entry and the client is the one before it.
    const ip = clientIp({
      headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.9, 192.0.2.5' },
      socket: { remoteAddress: '127.0.0.1' },
    }, 2);
    expect(ip).toBe('203.0.113.9');
  });

  it('falls back to the rightmost entry when the list is shorter than hops', () => {
    // Asserts the clamp fails SAFE. Clamping to index 0 would hand a
    // misconfigured TRUST_PROXY the one entry the requester always controls.
    const ip = clientIp({
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
      socket: { remoteAddress: '127.0.0.1' },
    }, 3);
    expect(ip).toBe('203.0.113.9');
  });

  it('lets a list padded to exactly hops choose the bucket — why the count is deprecated', () => {
    // Pins the weakness TRUSTED_PROXIES exists to fix, so it cannot come back
    // silently on the path existing deployments still run. With hops=2 the
    // requester sends one junk entry, the proxy appends the real address, and
    // entries[len - 2] is the entry the requester wrote. Nothing validates it
    // as a proxy, so each rotation of that value mints a fresh bucket.
    const ip = clientIp({
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
      socket: { remoteAddress: '127.0.0.1' },
    }, 2);
    expect(ip).toBe('1.2.3.4');
  });

  it('rejects non-IP forwarded values and signals that it did', () => {
    // Asserts header text can never become a map key, and that the fallback is
    // not silent (CONTRIBUTING.md forbids the silent catch).
    for (const junk of ['not-an-ip', '<script>alert(1)</script>', 'x'.repeat(8192)]) {
      const onInvalid = vi.fn();
      const ip = clientIp({
        headers: { 'x-forwarded-for': junk },
        socket: { remoteAddress: '127.0.0.1' },
      }, 1, onInvalid);
      expect(ip).toBe('127.0.0.1');
      expect(onInvalid).toHaveBeenCalledTimes(1);
    }
  });

  it('unmaps ::ffff: forms and strips ports so one client gets one bucket', () => {
    const mapped = clientIp({
      headers: { 'x-forwarded-for': '::ffff:203.0.113.5' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const ported = clientIp({
      headers: { 'x-forwarded-for': '203.0.113.5:44321' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    expect(mapped).toBe('203.0.113.5');
    expect(ported).toBe('203.0.113.5');
  });

  it('keys IPv6 on the /64 prefix', () => {
    // Asserts a v6 client cannot rotate the host portion of its own prefix for
    // a fresh bucket per request — no header spoofing required for that one.
    const fromXff = (addr: string) => clientIp({
      headers: { 'x-forwarded-for': addr },
      socket: { remoteAddress: '127.0.0.1' },
    });
    expect(fromXff('2001:db8::1')).toBe('2001:db8:0:0::/64');
    // Same /64, different host portion and different spelling → same bucket.
    expect(fromXff('2001:0db8:0:0:dead:beef:0:9')).toBe(fromXff('2001:db8::1'));
    // Neighbouring /64 → its own bucket.
    expect(fromXff('2001:db8:0:1::1')).not.toBe(fromXff('2001:db8::1'));
  });

  it('uses x-real-ip when x-forwarded-for is absent', () => {
    // Asserts the nginx `proxy_set_header X-Real-IP` config resolves to the
    // client rather than to the proxy.
    const ip = clientIp({
      headers: { 'x-real-ip': '203.0.113.9' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('ignores x-real-ip from a public peer', () => {
    const ip = clientIp({
      headers: { 'x-real-ip': '1.2.3.4' },
      socket: { remoteAddress: '198.51.100.7' },
    });
    expect(ip).toBe('198.51.100.7');
  });

  it('keys on the proxy when x-real-ip and x-forwarded-for disagree', () => {
    // nginx replaces X-Real-IP but passes a client's X-Forwarded-For through;
    // Caddy sanitizes X-Forwarded-For but not X-Real-IP. A disagreement proves
    // one of them was injected, so neither is usable — a shared bucket is the
    // safe direction, an attacker-chosen one is not.
    const onInvalid = vi.fn();
    const ip = clientIp({
      headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' },
      socket: { remoteAddress: '127.0.0.1' },
    }, 1, onInvalid);
    expect(ip).toBe('127.0.0.1');
    expect(onInvalid).toHaveBeenCalledTimes(1);
  });

  it('uses the client address when both forwarding headers agree', () => {
    // The fixed nginx config sets both from $remote_addr, so the normal path
    // must not land in the conflict branch above.
    const ip = clientIp({
      headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('falls back to socket remoteAddress when no x-forwarded-for', () => {
    const ip = clientIp({
      headers: {},
      socket: { remoteAddress: '203.0.113.5' },
    });
    expect(ip).toBe('203.0.113.5');
  });

  it('ignores empty x-forwarded-for and falls back', () => {
    const ip = clientIp({
      headers: { 'x-forwarded-for': '' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    expect(ip).toBe('127.0.0.1');
  });

  it('gives a zone-suffixed peer its own bucket rather than "unknown"', () => {
    // net.isIP() rejects 'fe80::1%eth0'. Funnelling every such peer into one
    // shared key would turn WS_PER_IP into a global cap.
    const ip = clientIp({ headers: {}, socket: { remoteAddress: 'fe80::1%eth0' } });
    expect(ip).not.toBe('unknown');
  });

  it('ignores headers from an absent peer and keys on a constant', () => {
    // remoteAddress is undefined on a destroyed socket, not only on a unix
    // socket (there is no unix-socket deployment). Trusting that request's
    // headers would reopen the bypass.
    const ip = clientIp({ headers: { 'x-forwarded-for': '1.2.3.4' }, socket: {} });
    expect(ip).toBe('unknown');
  });
});

describe('isTrustedPeer', () => {
  it('accepts loopback, private and link-local peers', () => {
    // 172.17.0.1 is the Docker bridge the maintainer's own deployment proxies
    // through; misclassifying it collapses every user into one bucket.
    for (const addr of ['127.0.0.1', '::1', '10.0.0.5', '172.17.0.1', '172.31.255.254',
                        '192.168.1.1', '169.254.1.1', 'fc00::1', 'fd12:3456::1', 'fe80::1',
                        '::ffff:10.0.0.5']) {
      expect(isTrustedPeer(addr), addr).toBe(true);
    }
  });

  it('rejects public peers and the /12 boundary', () => {
    // 172.32.0.1 is one address past 172.16.0.0/12 and must not be trusted.
    for (const addr of ['8.8.8.8', '203.0.113.9', '172.32.0.1', '172.15.255.255',
                        '2606:4700::1', 'not-an-ip']) {
      expect(isTrustedPeer(addr), addr).toBe(false);
    }
  });

  it('rejects an absent peer (fail closed)', () => {
    expect(isTrustedPeer(undefined)).toBe(false);
    expect(isTrustedPeer('')).toBe(false);
  });
});

describe('normalizeIp', () => {
  it('validates, unmaps and strips', () => {
    expect(normalizeIp(' 203.0.113.5 ')).toBe('203.0.113.5');
    expect(normalizeIp('203.0.113.5:44321')).toBe('203.0.113.5');
    expect(normalizeIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
  });

  it('returns null for anything that is not an IP', () => {
    // The null is what keeps attacker text out of the limiter maps.
    for (const junk of ['', 'unknown', 'for=1.2.3.4', 'not-an-ip', '999.1.1.1', 'x'.repeat(4096)]) {
      expect(normalizeIp(junk), junk).toBeNull();
    }
  });
});

describe('parseTrustProxyHops', () => {
  it('defaults to one hop when unset', () => {
    // The default has to keep working for every proxied deployment that
    // upgrades without setting the variable.
    expect(parseTrustProxyHops(undefined)).toBe(1);
    expect(parseTrustProxyHops('')).toBe(1);
  });

  it('accepts the off spellings', () => {
    for (const v of ['off', 'OFF', 'false', '0', 'no']) {
      expect(parseTrustProxyHops(v), v).toBe(0);
    }
  });

  it('accepts a hop count and clamps absurd ones', () => {
    expect(parseTrustProxyHops('2')).toBe(2);
    expect(parseTrustProxyHops('99')).toBe(8);
  });

  it('falls back to one hop on garbage rather than to zero', () => {
    // Falling to 0 behind a real proxy would 429 the whole server.
    expect(parseTrustProxyHops('banana')).toBe(1);
    expect(parseTrustProxyHops('-3')).toBe(1);
  });
});

describe('playerKey', () => {
  it('joins ip and name with a separator neither can contain', () => {
    expect(playerKey('1.2.3.4', 'Ashe')).toBe('1.2.3.4\0Ashe');
  });

  it('bounds the key length against an unbounded name', () => {
    // The name is request text; without the truncation one source can park
    // 256 KB keys in the limiter map.
    const key = playerKey('1.2.3.4', 'n'.repeat(5000));
    expect(key.length).toBe('1.2.3.4'.length + 1 + 64);
  });

  it('falls back to the ip alone when the name is missing or not a string', () => {
    expect(playerKey('1.2.3.4', undefined)).toBe('1.2.3.4');
    expect(playerKey('1.2.3.4', '')).toBe('1.2.3.4');
    expect(playerKey('1.2.3.4', { evil: true })).toBe('1.2.3.4');
  });
});

describe('RejectionCounters', () => {
  it('accumulates per reason and keeps snapshot monotonic', () => {
    const c = new RejectionCounters();
    c.bump('turn_creds_ip');
    c.bump('turn_creds_ip');
    c.bump('ws_per_ip');
    expect(c.snapshot()).toEqual({ turn_creds_ip: 2, ws_per_ip: 1 });
    c.drainDeltas();
    expect(c.snapshot()).toEqual({ turn_creds_ip: 2, ws_per_ip: 1 });
  });

  it('drainDeltas reports the change since the previous call, then zeroes', () => {
    // The 60 s log line has to read "rejected in the last minute", not "ever".
    const c = new RejectionCounters();
    c.bump('xff_invalid');
    c.bump('xff_invalid');
    expect(c.drainDeltas()).toEqual({ xff_invalid: 2 });
    expect(c.drainDeltas()).toEqual({});
    c.bump('xff_invalid');
    expect(c.drainDeltas()).toEqual({ xff_invalid: 1 });
  });
});

describe('parseCidr and ipInNet', () => {
  it('treats a bare address as a full-length prefix', () => {
    const net = parseCidr('203.0.113.9')!;
    expect(net.prefix).toBe(32);
    expect(ipInNet('203.0.113.9', net)).toBe(true);
    expect(ipInNet('203.0.113.10', net)).toBe(false);
  });

  it('matches on the prefix boundary, including inside an octet', () => {
    const net = parseCidr('172.16.0.0/12')!;
    expect(ipInNet('172.16.0.1', net)).toBe(true);
    expect(ipInNet('172.31.255.254', net)).toBe(true);
    expect(ipInNet('172.15.255.255', net)).toBe(false);
    expect(ipInNet('172.32.0.1', net)).toBe(false);
  });

  it('matches IPv6 on a hextet-straddling prefix', () => {
    const net = parseCidr('fc00::/7')!;
    expect(ipInNet('fc00::1', net)).toBe(true);
    expect(ipInNet('fd12:3456::1', net)).toBe(true);
    expect(ipInNet('fe00::1', net)).toBe(false);
  });

  it('never matches across families', () => {
    expect(ipInNet('10.0.0.1', parseCidr('::/8')!)).toBe(false);
    expect(ipInNet('fc00::1', parseCidr('10.0.0.0/8')!)).toBe(false);
  });

  it('returns null for anything that is not a network', () => {
    // A typo has to shrink the trusted set, never widen it.
    for (const junk of ['', 'private', 'not-an-ip', '10.0.0.0/33', '10.0.0.0/-1',
                        '10.0.0.0/x', 'fc00::/129', '999.1.1.1/8']) {
      expect(parseCidr(junk), junk).toBeNull();
    }
  });
});

describe('parseTrustedProxies', () => {
  it('expands the private keyword to the peer-gate ranges', () => {
    const nets = parseTrustedProxies('private');
    for (const addr of ['127.0.0.1', '10.0.0.5', '172.17.0.1', '192.168.1.1',
                        '169.254.1.1', '::1', 'fc00::1', 'fe80::1']) {
      expect(nets.some((n) => ipInNet(addr, n)), addr).toBe(true);
    }
    expect(nets.some((n) => ipInNet('203.0.113.9', n))).toBe(false);
  });

  it('accepts a mixed comma or space separated list', () => {
    const nets = parseTrustedProxies('private, 198.51.100.0/24  2001:db8::/32');
    expect(nets.some((n) => ipInNet('198.51.100.7', n))).toBe(true);
    expect(nets.some((n) => ipInNet('2001:db8:1::5', n))).toBe(true);
  });

  it('drops unusable entries instead of widening the list', () => {
    const nets = parseTrustedProxies('banana, 10.0.0.0/8, 10.0.0.0/99');
    expect(nets).toHaveLength(1);
    expect(ipInNet('10.1.2.3', nets[0])).toBe(true);
  });

  it('drops a /0, which would trust every address on the internet', () => {
    // Trusting everything makes the walk stop nowhere and hands the bucket key
    // straight back to the requester — the bypass the list exists to close.
    expect(parseTrustedProxies('0.0.0.0/0')).toHaveLength(0);
    expect(parseTrustedProxies('::/0')).toHaveLength(0);
    expect(parseTrustedProxies('0.0.0.0/0, 10.0.0.0/8')).toHaveLength(1);
  });
});

describe('clientIp with a trusted-proxy list', () => {
  const PRIVATE = { nets: parseTrustedProxies('private'), hops: 1 };

  it('ignores padding and keys on the real client (the hop-count bypass, closed)', () => {
    // THE regression guard for this group. The requester sends '1.2.3.4', the
    // proxy appends the address it saw, and the walk stops at the rightmost
    // entry because it is not a listed proxy. No hop count to shift.
    const ip = clientIp({
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
      socket: { remoteAddress: '127.0.0.1' },
    }, PRIVATE);
    expect(ip).toBe('203.0.113.9');
  });

  it('is unmoved by any amount of padding', () => {
    const padded = ['9.9.9.9', '8.8.8.8', '1.1.1.1', '1.2.3.4'].join(', ');
    const ip = clientIp({
      headers: { 'x-forwarded-for': `${padded}, 203.0.113.9` },
      socket: { remoteAddress: '172.17.0.1' },
    }, PRIVATE);
    expect(ip).toBe('203.0.113.9');
  });

  it('walks past a listed CDN edge to the client behind it', () => {
    // Cloudflare → Caddy: the operator lists the CDN range alongside their own
    // proxy, and the walk passes the edge and stops at the player. The hop
    // count this replaces needed TRUST_PROXY=2 and a correct proxy config to
    // reach the same answer.
    const trust = { nets: parseTrustedProxies('private, 198.51.100.0/24'), hops: 1 };
    const ip = clientIp({
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 198.51.100.7' },
      socket: { remoteAddress: '127.0.0.1' },
    }, trust);
    expect(ip).toBe('203.0.113.9');
  });

  it('ignores headers from a peer that is not a listed proxy', () => {
    const ip = clientIp({
      headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' },
      socket: { remoteAddress: '203.0.113.9' },
    }, PRIVATE);
    expect(ip).toBe('203.0.113.9');
  });

  it('narrows trust to the listed networks, not to private ones generally', () => {
    // A list of one proxy must not accidentally re-admit every private peer,
    // which is what the LAN deployment in docs/self-hosting.md depends on.
    const trust = { nets: parseTrustedProxies('10.8.0.1'), hops: 1 };
    const ip = clientIp({
      headers: { 'x-forwarded-for': '1.2.3.4' },
      socket: { remoteAddress: '192.168.1.50' },
    }, trust);
    expect(ip).toBe('192.168.1.50');
  });

  it('keys on the proxy when every entry is one of ours', () => {
    // Nothing in the list identifies a client, so there is no client address to
    // take — a shared bucket beats a requester-chosen one.
    const onInvalid = vi.fn();
    const ip = clientIp({
      headers: { 'x-forwarded-for': '10.0.0.9, 172.17.0.1' },
      socket: { remoteAddress: '172.17.0.1' },
    }, PRIVATE, onInvalid);
    expect(ip).toBe('172.17.0.1');
    expect(onInvalid).toHaveBeenCalledTimes(1);
  });

  it('stops at an unparseable entry rather than stepping over it', () => {
    // Stepping over it would attribute the entry to its left to whoever wrote
    // the junk. The rightmost entry here is unusable, so nothing is believed.
    const onInvalid = vi.fn();
    const ip = clientIp({
      headers: { 'x-forwarded-for': '203.0.113.9, not-an-ip' },
      socket: { remoteAddress: '127.0.0.1' },
    }, PRIVATE, onInvalid);
    expect(ip).toBe('127.0.0.1');
    expect(onInvalid).toHaveBeenCalledTimes(1);
  });

  it('uses x-real-ip only when there is no list to walk', () => {
    const ip = clientIp({
      headers: { 'x-real-ip': '203.0.113.9' },
      socket: { remoteAddress: '127.0.0.1' },
    }, PRIVATE);
    expect(ip).toBe('203.0.113.9');
  });

  it('never lets x-real-ip override the walk', () => {
    // Caddy writes X-Forwarded-For and passes a client's X-Real-IP through
    // untouched, so the walk's answer has to win outright.
    const ip = clientIp({
      headers: { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '203.0.113.9' },
      socket: { remoteAddress: '127.0.0.1' },
    }, PRIVATE);
    expect(ip).toBe('203.0.113.9');
  });

  it('still buckets IPv6 clients by /64', () => {
    const ip = clientIp({
      headers: { 'x-forwarded-for': '2001:db8::dead:beef' },
      socket: { remoteAddress: '::1' },
    }, PRIVATE);
    expect(ip).toBe('2001:db8:0:0::/64');
  });

  it('honours the kill switch shape with an empty list', () => {
    const ip = clientIp({
      headers: { 'x-forwarded-for': '1.2.3.4' },
      socket: { remoteAddress: '127.0.0.1' },
    }, { nets: [], hops: 0 });
    expect(ip).toBe('127.0.0.1');
  });
});

describe('resolveProxyTrust', () => {
  it('defaults to the deprecated one-hop behaviour when neither var is set', () => {
    // Every existing deployment upgrades without editing its compose file.
    expect(resolveProxyTrust(undefined, undefined)).toEqual({ nets: [], hops: 1 });
  });

  it('keeps TRUST_PROXY working as a deprecated alias', () => {
    expect(resolveProxyTrust(undefined, '2')).toEqual({ nets: [], hops: 2 });
    expect(resolveProxyTrust(undefined, 'off')).toEqual({ nets: [], hops: 0 });
    expect(resolveProxyTrust('', 'off')).toEqual({ nets: [], hops: 0 });
  });

  it('prefers the list over the hop count when both are set', () => {
    const t = resolveProxyTrust('private', '2');
    expect(t.nets.length).toBeGreaterThan(0);
  });

  it('accepts the off spellings in TRUSTED_PROXIES too', () => {
    for (const v of ['off', 'OFF', 'false', '0', 'no']) {
      expect(resolveProxyTrust(v, undefined), v).toEqual({ nets: [], hops: 0 });
    }
  });

  it('falls back to the hop count when the list parses to nothing', () => {
    // Dropping to 0 here would collapse a proxied deployment into one bucket —
    // a typo in the new variable must not take the server down.
    expect(resolveProxyTrust('banana', '2')).toEqual({ nets: [], hops: 2 });
    expect(resolveProxyTrust('banana', undefined)).toEqual({ nets: [], hops: 1 });
  });
});

describe('describeProxyTrust', () => {
  it('names the mode the process actually resolved', () => {
    // The startup line is how an operator confirms which path is live without
    // inferring it from 429s.
    expect(describeProxyTrust(resolveProxyTrust('private', undefined))).toContain('right-to-left');
    expect(describeProxyTrust(resolveProxyTrust(undefined, '2'))).toContain('2 hop(s)');
    expect(describeProxyTrust(resolveProxyTrust(undefined, 'off'))).toContain('disabled');
  });
});
