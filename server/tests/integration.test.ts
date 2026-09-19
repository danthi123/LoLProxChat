import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket, type ClientOptions } from 'ws';

// End-to-end integration test: spawns the ACTUAL built server (dist/index.js)
// as a subprocess and drives it with real WebSocket + HTTP clients. Unit
// tests cover the volume math with injected getters; this proves the full
// chain wires up — WS join (team) → WS coords (hearCrossTeam) → HTTP
// /compute-volumes (tiered math) — against a real running process.
//
// Requires a build first (`npm run build`). The vitest config / CI should
// run build before this. If dist/ is stale the test exercises stale code,
// so always build immediately before.

const PORT = 31999;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
// Valid 64-hex key so the (unused-in-tiered-path) ENCRYPTION_KEY import is happy.
const TEST_KEY = 'a'.repeat(64);

let server: ChildProcess;

function waitForListening(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 10_000);
    proc.stdout?.on('data', (buf: Buffer) => {
      if (buf.toString().includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('exit', (code) => reject(new Error(`server exited early with code ${code}`)));
  });
}

/** Open a WS, join a room with a team, resolve once room_state is received. */
function joinRoomAt(
  url: string,
  room: string,
  name: string,
  team: 'ORDER' | 'CHAOS',
  opts?: ClientOptions,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    const timer = setTimeout(() => reject(new Error(`${name} join timed out`)), 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', room, name, team }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'room_state') {
        clearTimeout(timer);
        resolve(ws);
      }
    });
    ws.on('error', reject);
  });
}

function joinRoom(room: string, name: string, team: 'ORDER' | 'CHAOS'): Promise<WebSocket> {
  return joinRoomAt(WS_URL, room, name, team);
}

/** Collect every message of one type that arrives on an already-open socket. */
function collect(ws: WebSocket, type: string): string[] {
  const seen: string[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === type) seen.push(JSON.stringify(msg));
  });
  return seen;
}

/** Resolve with the first message of `type` to arrive, or reject on timeout. */
function nextMessage(ws: WebSocket, type: string, timeoutMs: number, label: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
}

function sendCoords(ws: WebSocket, x: number, y: number): void {
  ws.send(JSON.stringify({ type: 'coords', x, y }));
}

/** What a client sends when its tracker has lost the player (#recall lag). */
function disownCoords(ws: WebSocket, x: number, y: number): void {
  ws.send(JSON.stringify({ type: 'coords', x, y, stale: true }));
}

async function computeVolumesAt(
  base: string,
  myPosition: { x: number; y: number },
  roomId: string,
  name: string,
  listenPosition?: { x: number; y: number },
) {
  const resp = await fetch(`${base}/compute-volumes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ myPosition, roomId, name, ...(listenPosition ? { listenPosition } : {}) }),
  });
  expect(resp.ok).toBe(true);
  return resp.json() as Promise<{ myBlob: string; peerVolumes: Record<string, number> }>;
}

function computeVolumes(
  myPosition: { x: number; y: number },
  roomId: string,
  name: string,
  listenPosition?: { x: number; y: number },
) {
  return computeVolumesAt(BASE, myPosition, roomId, name, listenPosition);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Blank TURN config so /turn-credentials answers from memory. Inherited creds
// from a developer's shell would turn these into network-dependent tests.
const NO_TURN = {
  TURN_KEY_ID: '',
  TURN_KEY_API_TOKEN: '',
  TURN_SERVER: '',
  TURN_SECRET: '',
};

/** Fire `count` /turn-credentials requests in parallel and return the statuses. */
async function floodTurnCreds(
  base: string,
  count: number,
  headers: (i: number) => Record<string, string>,
): Promise<number[]> {
  const responses = await Promise.all(
    Array.from({ length: count }, (_, i) => fetch(`${base}/turn-credentials`, { headers: headers(i) })),
  );
  // Drain the bodies so the sockets are released before the next case.
  await Promise.all(responses.map((r) => r.text()));
  return responses.map((r) => r.status);
}

beforeAll(async () => {
  server = spawn('node', ['dist/index.js'], {
    env: { ...process.env, ...NO_TURN, PORT: String(PORT), ENCRYPTION_KEY: TEST_KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForListening(server);
}, 15_000);

afterAll(() => {
  server?.kill('SIGKILL');
});

describe('tiered proximity — end-to-end against the real server', () => {
  it('serves the v0.3 tiered path (myBlob is empty) for room-shaped requests', async () => {
    const result = await computeVolumes({ x: 0, y: 0 }, 'solo-room', 'Nobody');
    expect(result.myBlob).toBe('');
    expect(result.peerVolumes).toEqual({});
  });

  it('allies are always audible; cross-team enemies fade out at vision range', async () => {
    const room = 'r-tiered';
    const alice = await joinRoom(room, 'Alice', 'ORDER');
    const ally = await joinRoom(room, 'AllyFar', 'ORDER');
    const enemyClose = await joinRoom(room, 'EnemyClose', 'CHAOS');
    const enemyEdge = await joinRoom(room, 'EnemyEdge', 'CHAOS');
    const enemyBeyond = await joinRoom(room, 'EnemyBeyond', 'CHAOS');

    sendCoords(alice, 0, 0);
    // Ally far away — distance shouldn't matter for same-team
    sendCoords(ally, 9000, 9000);
    // Enemy close → clearly audible
    sendCoords(enemyClose, 400, 0);
    // Enemy just inside the edge of vision range (1350u) → faintly audible
    sendCoords(enemyEdge, 1340, 0);
    // Enemy beyond vision range → omitted entirely
    sendCoords(enemyBeyond, 1500, 0);

    await sleep(500); // let the coords WS messages land in room state

    const result = await computeVolumes({ x: 0, y: 0 }, room, 'Alice');
    expect(result.peerVolumes.AllyFar).toBe(1.0);               // ally, always full
    expect(result.peerVolumes.EnemyClose).toBeGreaterThan(0.5);  // close → loud
    expect(result.peerVolumes.EnemyEdge).toBeGreaterThan(0);     // < 1350u → audible
    expect(result.peerVolumes.EnemyEdge).toBeLessThan(0.1);      // ...but very quiet
    expect(result.peerVolumes.EnemyBeyond).toBeUndefined();      // > 1350u → omitted

    alice.close(); ally.close(); enemyClose.close(); enemyEdge.close(); enemyBeyond.close();
  });

  it('"voice on camera" moves what the requester hears, not what peers hear (#36)', async () => {
    const room = 'r-camera';
    const alice = await joinRoom(room, 'CamAlice', 'ORDER');
    const enemy = await joinRoom(room, 'CamEnemy', 'CHAOS');

    // Alice's champion is at the origin; the enemy is 5000u away — far outside
    // the 1350u cross-team range, so normally inaudible in both directions.
    sendCoords(alice, 0, 0);
    sendCoords(enemy, 5000, 0);
    await sleep(500);

    const withoutCamera = await computeVolumes({ x: 0, y: 0 }, room, 'CamAlice');
    expect(withoutCamera.peerVolumes.CamEnemy).toBeUndefined();

    // Alice pans her camera over to the enemy → she hears them.
    const withCamera = await computeVolumes({ x: 0, y: 0 }, room, 'CamAlice', { x: 5000, y: 0 });
    expect(withCamera.peerVolumes.CamEnemy).toBe(1.0);

    // ...and the enemy still does NOT hear Alice, because their distance is
    // measured against Alice's champion position in room state. Listen-only.
    const enemyView = await computeVolumes({ x: 5000, y: 0 }, room, 'CamEnemy');
    expect(enemyView.peerVolumes.CamAlice).toBeUndefined();

    alice.close(); enemy.close();
  });

  it('a disowned position stops cross-team audio at once, without leaving the room', async () => {
    // A recall is an instant teleport the tracker cannot follow, so the client
    // says "this is only the last place I saw myself". Before the flag existed
    // the server kept serving that position for its whole staleness window and
    // the enemy went on hearing them from where they used to be.
    const room = 'r-stale';
    const me = await joinRoom(room, 'StaleMe', 'ORDER');
    const enemy = await joinRoom(room, 'StaleEnemy', 'CHAOS');
    const ally = await joinRoom(room, 'StaleAlly', 'ORDER');

    sendCoords(me, 0, 0);
    sendCoords(enemy, 300, 0);   // well inside the range → clearly audible
    sendCoords(ally, 9000, 0);
    await sleep(400);

    const before = await computeVolumes({ x: 300, y: 0 }, room, 'StaleEnemy');
    expect(before.peerVolumes.StaleMe).toBeGreaterThan(0);

    // The tracker loses StaleMe, who disowns the position it last had.
    disownCoords(me, 0, 0);
    await sleep(400);

    const after = await computeVolumes({ x: 300, y: 0 }, room, 'StaleEnemy');
    expect(after.peerVolumes.StaleMe).toBeUndefined();

    // ...but they are still in the room, still audible to their own team,
    // which is scored by membership rather than distance.
    const allyView = await computeVolumes({ x: 9000, y: 0 }, room, 'StaleAlly');
    expect(allyView.peerVolumes.StaleMe).toBe(1.0);

    me.close(); enemy.close(); ally.close();
  });

  it('an older client that never sends the flag is unaffected', async () => {
    // Back-compat in the direction that matters: pre-0.5.9 clients keep the
    // old behaviour, where a position lingers until the staleness window.
    const room = 'r-nostale';
    const me = await joinRoom(room, 'OldMe', 'ORDER');
    const enemy = await joinRoom(room, 'OldEnemy', 'CHAOS');
    sendCoords(me, 0, 0);
    sendCoords(enemy, 300, 0);
    await sleep(400);
    const seen = await computeVolumes({ x: 300, y: 0 }, room, 'OldEnemy');
    expect(seen.peerVolumes.OldMe).toBeGreaterThan(0);
    me.close(); enemy.close();
  });

  it('legacy v0.1 clients (no team on join) still get team-blind volumes', async () => {
    const room = 'r-legacy';
    // Join WITHOUT a team field — simulates a v0.2.x client
    const a = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      const t = setTimeout(() => reject(new Error('legacy join timeout')), 5000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room, name: 'Legacy' })));
      ws.on('message', (d) => { if (JSON.parse(d.toString()).type === 'room_state') { clearTimeout(t); resolve(ws); } });
      ws.on('error', reject);
    });
    const other = await joinRoom(room, 'OtherTeamless', 'CHAOS');

    sendCoords(a, 0, 0);
    // Teamless requester: legacy fallback uses team-blind vision-range falloff.
    // Place the other peer at 1000u — within the 1350u range.
    sendCoords(other, 1000, 0);
    await sleep(500);

    const result = await computeVolumes({ x: 0, y: 0 }, room, 'Legacy');
    // Even though Legacy never sent a team, the other peer at 1000u is audible
    // because the legacy path ignores teams and uses the full 1200u range.
    expect(result.peerVolumes.OtherTeamless).toBeGreaterThan(0);

    a.close(); other.close();
  });

  it('rate-limits per player (ip + name) so housemates on one IP do not starve each other', async () => {
    // The no-audio bug: a shared per-IP bucket 429'd every client behind one
    // household NAT (each client polls /compute-volumes independently, so a
    // 2+ stack blew the per-IP cap). Now each (ip, name) has its own budget.
    const room = 'r-ratelimit';
    const post = (name: string) =>
      fetch(`${BASE}/compute-volumes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ myPosition: { x: 0, y: 0 }, roomId: room, name }),
      });

    // 220 near-simultaneous requests as "Hog" — above the 180 per-player
    // capacity, so some are rejected once Hog's own bucket drains.
    const hog = await Promise.all(Array.from({ length: 220 }, () => post('Hog')));
    expect(hog.filter((r) => r.status === 429).length).toBeGreaterThan(0);

    // A different player from the SAME IP still gets through — separate bucket.
    const housemate = await post('Housemate');
    expect(housemate.status).toBe(200);
  });

  it('a reconnect under the same name takes over signaling', async () => {
    const room = 'r-takeover';
    const alice = await joinRoom(room, 'Alice', 'ORDER');
    const bob1 = await joinRoom(room, 'Bob', 'CHAOS');

    const bob1Closed = new Promise<number>((resolve) => bob1.on('close', resolve));
    const alicePeerLeft = collect(alice, 'peer_left');
    const bob1Signals = collect(bob1, 'signal');

    // Bob reconnects on a NEW socket without the old one having closed —
    // exactly the zombie the client's backoff loop leaves behind when the old
    // connection is half-open.
    const bob2 = await joinRoom(room, 'Bob', 'CHAOS');
    const bob2Signal = nextMessage(bob2, 'signal', 3000, 'Bob2 never received the signal');

    // The server hands the old socket a distinct close code so the client can
    // tell a takeover from an ordinary drop and stop reconnecting.
    expect(await bob1Closed).toBe(4000);

    alice.send(JSON.stringify({ type: 'signal', to: 'Bob', payload: { sdp: 'offer' } }));
    expect((await bob2Signal).from).toBe('Alice');
    // Before the fix the signal is routed to the stale entry and lands nowhere.
    expect(bob1Signals).toEqual([]);

    await sleep(300);
    // ...and no peer_left for a name that is still in the room, which would
    // make Alice tear down the connection she just established.
    expect(alicePeerLeft).toEqual([]);

    alice.close();
    bob2.close();
  }, 15_000);

  it('keys the rate limit on the entry the proxy wrote, not the one the client sent', async () => {
    // The end-to-end proof that the bypass is closed on the DEFAULT config
    // (loopback peer, one hop). The rightmost entry is what a real proxy
    // appends; rotating everything to its left used to mint a fresh bucket per
    // request, so all 90 returned 200. TURN_CREDS holds 60 and refills at 1/s.
    const statuses = await floodTurnCreds(BASE, 90, (i) => ({
      'x-forwarded-for': `198.51.100.${i}, 203.0.113.77`,
    }));
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(20);
  });

  it('never lets non-IP header text become a bucket key', async () => {
    // Rotating garbage falls back to the socket peer — one bucket, not 90.
    const statuses = await floodTurnCreds(BASE, 90, (i) => ({
      'x-forwarded-for': `not-an-ip-${i}`,
    }));
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(20);
  });

  it('still gives proxied clients their own buckets', async () => {
    // The availability guard: a genuine one-hop proxy forwards one entry per
    // client, and each of those must keep its own budget. If this ever starts
    // 429ing, the fix has collapsed a whole server onto the proxy's address.
    const statuses = await floodTurnCreds(BASE, 90, (i) => ({
      'x-forwarded-for': `198.51.100.${i}`,
    }));
    expect(statuses.filter((s) => s === 429).length).toBe(0);
  });
});

// TRUST_PROXY=off has to be set at startup, so the kill switch needs its own
// process. This instance ignores forwarding headers entirely.
describe('TRUST_PROXY=off ignores forwarding headers', () => {
  const OFF_PORT = 31997;
  const OFF_BASE = `http://127.0.0.1:${OFF_PORT}`;
  const OFF_WS_URL = `ws://127.0.0.1:${OFF_PORT}`;
  let offServer: ChildProcess;
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    offServer = spawn('node', ['dist/index.js'], {
      env: {
        ...process.env,
        ...NO_TURN,
        PORT: String(OFF_PORT),
        ENCRYPTION_KEY: TEST_KEY,
        TRUST_PROXY: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForListening(offServer);
  }, 15_000);

  afterAll(() => {
    for (const ws of openSockets) ws.close();
    offServer?.kill('SIGKILL');
  });

  it('rate-limits /turn-credentials despite a distinct X-Forwarded-For per request', async () => {
    const statuses = await floodTurnCreds(OFF_BASE, 90, (i) => ({
      'x-forwarded-for': `198.51.100.${i}`,
    }));
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(20);
  });

  it('enforces the per-IP WebSocket cap despite a rotating X-Forwarded-For', async () => {
    // The WS limiter is the one where a bypass is worth the most: it grants
    // unbounded CONCURRENT connections rather than a throughput increment.
    // WS_PER_IP is 20, so at least 5 of 25 must be refused with 1008.
    const probe = (i: number) => new Promise<number | 'open'>((resolve) => {
      const ws = new WebSocket(OFF_WS_URL, { headers: { 'x-forwarded-for': `198.51.100.${i}` } });
      openSockets.push(ws);
      const timer = setTimeout(() => resolve('open'), 2000);
      ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
      ws.on('error', () => { clearTimeout(timer); resolve('open'); });
    });

    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => probe(i)));
    expect(results.filter((r) => r === 1008).length).toBeGreaterThanOrEqual(5);
  }, 20_000);
});

// The heartbeat needs its own server: the sweep interval is fixed at startup,
// and 30 s is far too long for a test.
describe('half-open connections are reaped', () => {
  const REAP_PORT = 31998;
  const REAP_BASE = `http://127.0.0.1:${REAP_PORT}`;
  const REAP_WS_URL = `ws://127.0.0.1:${REAP_PORT}`;
  let reapServer: ChildProcess;

  beforeAll(async () => {
    reapServer = spawn('node', ['dist/index.js'], {
      env: {
        ...process.env,
        ...NO_TURN,
        PORT: String(REAP_PORT),
        ENCRYPTION_KEY: TEST_KEY,
        HEARTBEAT_MS: '250',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForListening(reapServer);
  }, 15_000);

  afterAll(() => {
    reapServer?.kill('SIGKILL');
  });

  it('drops a silent client from the room and from its allies\' volumes', async () => {
    const room = 'r-reap';
    const watcher = await joinRoomAt(REAP_WS_URL, room, 'Watcher', 'ORDER');
    // autoPong:false leaves the TCP connection up while the client never
    // answers a ping — the application-level shape of a half-open socket.
    // Without the heartbeat nothing ever removes it and this test times out.
    const ghost = await joinRoomAt(REAP_WS_URL, room, 'Ghost', 'ORDER', { autoPong: false });

    const left = await nextMessage(watcher, 'peer_left', 5000, 'Ghost was never reaped');
    expect(left.name).toBe('Ghost');

    // The assertion that ties the heartbeat to the harm it exists to prevent:
    // computeTieredVolumes skips the staleness check for allies, so a zombie
    // ally is only removed from the volume response by actually leaving room
    // state. Watcher is on Ghost's team, so this is the ally branch.
    const result = await computeVolumesAt(REAP_BASE, { x: 0, y: 0 }, room, 'Watcher');
    expect(result.peerVolumes.Ghost).toBeUndefined();

    ghost.close();
    watcher.close();
  }, 20_000);
});
