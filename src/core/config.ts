// Injected at build time via webpack.DefinePlugin — see .env.example
declare const __PROXCHAT_SERVER__: string;

export const SERVER_URL: string = typeof __PROXCHAT_SERVER__ !== 'undefined'
  ? __PROXCHAT_SERVER__
  : 'https://proxchat.dant123.com';

// Derive WebSocket URL from SERVER_URL (http→ws, https→wss)
export const WS_URL: string = SERVER_URL.replace(/^http/, 'ws') + '/ws';

// Default STUN-only ICE servers (fallback if TURN credentials unavailable)
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

// NOTE: unlike the rest of core/, this module holds mutable state (the ICE
// server cache below). `_resetIceServerCacheForTests` exists so a test can put
// it back to a known state, mirroring `_cloudflareCacheForTests` on the server.
interface IceServerCache {
  servers: RTCIceServer[];
  expiresAtMs: number;
}

let iceCache: IceServerCache | null = null;
let iceInFlight: Promise<RTCIceServer[]> | null = null;

// Every peer in a lobby is connected within a few seconds of game start, so a
// short TTL is enough to collapse that whole burst (~9 requests per client)
// into one — which matters because /turn-credentials is bucketed per IP at 60
// tokens refilling at 1/sec and a 5-stack shares one household NAT.
// Deliberately kept well under the server's CACHE_REFRESH_LEAD_MS (5 min, see
// server/src/turn.ts): it only serves a Cloudflare credential while more than
// that much life remains, so 60s leaves most of the margin intact. This is a
// margin, not a guarantee — the server's stale-grace path can hand out an
// already-expired credential during a Cloudflare outage, in which case the
// credential is dead with or without our cache. If CACHE_REFRESH_LEAD_MS is
// ever lowered, lower this with it.
const ICE_CACHE_TTL_MS = 60 * 1000;

/**
 * Fetch ICE servers with TURN credentials from the signaling server.
 * TURN secret never touches the client — HMAC generation happens server-side.
 *
 * Successful responses are cached in memory only (never localStorage: TURN
 * credentials are bearer credentials for the operator's relay). Concurrent
 * callers share one request.
 */
export function getIceServers(): Promise<RTCIceServer[]> {
  if (iceCache && Date.now() < iceCache.expiresAtMs) {
    return Promise.resolve(iceCache.servers);
  }
  if (iceInFlight) return iceInFlight;
  const inFlight = fetchIceServers().finally(() => {
    if (iceInFlight === inFlight) iceInFlight = null;
  });
  iceInFlight = inFlight;
  return inFlight;
}

async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const resp = await fetch(`${SERVER_URL}/turn-credentials`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.iceServers && data.iceServers.length > 0) {
      iceCache = { servers: data.iceServers, expiresAtMs: Date.now() + ICE_CACHE_TTL_MS };
      return data.iceServers;
    }
    // A 200 carrying an empty list is what the server returns when TURN isn't
    // configured at all, and when Cloudflare is unreachable with no usable
    // cache. Until now that was silent — it reads as "working, just quiet" but
    // means no relay, i.e. no voice behind a symmetric NAT.
    console.warn('[Config] Server returned no TURN servers, using STUN only');
  } catch (e) {
    console.warn('[Config] Failed to fetch TURN credentials, using STUN only:', e);
  }
  // Nothing is cached on this path on purpose. An ICE server list is frozen
  // into each RTCPeerConnection at construction and never re-read (not even by
  // an ICE restart), so a peer built on the STUN fallback stays STUN-only for
  // the whole game. Caching the fallback would turn one dropped request into
  // every peer of that game being relay-less; retrying per peer keeps a
  // transient failure a one-peer problem.
  return ICE_SERVERS;
}

/** Test-only: drop the cache and any in-flight request. */
export function _resetIceServerCacheForTests(): void {
  iceCache = null;
  iceInFlight = null;
}
