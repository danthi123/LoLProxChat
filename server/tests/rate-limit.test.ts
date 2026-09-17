import { describe, it, expect, vi } from 'vitest';
import {
  TokenBucket,
  ConcurrencyLimiter,
  clientIp,
  isTrustedPeer,
  normalizeIp,
  parseTrustProxyHops,
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
