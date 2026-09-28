import { getIceServers, ICE_SERVERS, _resetIceServerCacheForTests } from '../../src/core/config';

// getIceServers is on the peer-creation path: every PeerConnection.create awaits
// it, so a full lobby fired ~9 requests per client at game start against a 60-token
// per-IP bucket. These tests pin the two properties that collapse that burst
// (share one in-flight request, cache the success) and — just as important — that
// a FAILED fetch is not cached: an ICE server list is frozen into each
// RTCPeerConnection at construction, so caching the STUN fallback would strand
// every peer of that game without a relay.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const TURN_SERVERS = [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }];

const fetchMock = jest.fn();
(globalThis as any).fetch = fetchMock;

function okWith(iceServers: unknown) {
  return { ok: true, json: async () => ({ iceServers }) };
}

describe('getIceServers', () => {
  let nowMs: number;

  beforeEach(() => {
    _resetIceServerCacheForTests();
    fetchMock.mockReset();
    nowMs = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    jest.spyOn(console, 'warn').mockImplementation(() => { /* keep test output clean */ });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('concurrent callers share a single request', async () => {
    // Asserts the in-flight dedup: ten peers created in the same tick must
    // produce one HTTP request, not ten. Pre-fix this was ten.
    const d = deferred<any>();
    fetchMock.mockReturnValue(d.promise);

    const calls = Array.from({ length: 10 }, () => getIceServers());
    d.resolve(okWith(TURN_SERVERS));
    const results = await Promise.all(calls);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toEqual(TURN_SERVERS);
  });

  test('a second call inside the TTL is served from cache', async () => {
    // Asserts the success cache: a sequential second caller does not refetch.
    fetchMock.mockResolvedValue(okWith(TURN_SERVERS));

    await getIceServers();
    nowMs += 59_000;
    const second = await getIceServers();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(TURN_SERVERS);
  });

  test('a call after the TTL refetches', async () => {
    // Asserts the cache actually expires — credentials must not be pinned for
    // the whole process lifetime.
    fetchMock.mockResolvedValue(okWith(TURN_SERVERS));

    await getIceServers();
    nowMs += 61_000;
    await getIceServers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a non-ok response returns the STUN fallback and is NOT cached', async () => {
    // Asserts there is no negative caching. The next peer must get its own
    // attempt, so one 429 or dropped request costs one peer, not the lobby.
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

    const first = await getIceServers();
    expect(first).toEqual(ICE_SERVERS);

    const second = await getIceServers();
    expect(second).toEqual(ICE_SERVERS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('HTTP 200 with an empty iceServers list falls back, logs, and is NOT cached', async () => {
    // This is what the server returns when TURN is unconfigured (the default
    // self-hosted setup) and when Cloudflare is unreachable with no usable
    // cache. It is structurally a success, so it must not take the cached
    // success path — and it used to return STUN with no diagnostic at all.
    fetchMock.mockResolvedValue(okWith([]));

    const first = await getIceServers();
    expect(first).toEqual(ICE_SERVERS);
    expect(console.warn).toHaveBeenCalled();

    const second = await getIceServers();
    expect(second).toEqual(ICE_SERVERS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a successful fetch after a failure is cached normally', async () => {
    // Guards the recovery path: the failure must not leave the module wedged
    // with a stale in-flight promise.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    fetchMock.mockResolvedValue(okWith(TURN_SERVERS));

    await getIceServers();
    const recovered = await getIceServers();
    expect(recovered).toEqual(TURN_SERVERS);

    await getIceServers();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
