import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';

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
function joinRoom(room: string, name: string, team: 'ORDER' | 'CHAOS'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
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

function sendCoords(ws: WebSocket, x: number, y: number): void {
  ws.send(JSON.stringify({ type: 'coords', x, y }));
}

async function computeVolumes(
  myPosition: { x: number; y: number },
  roomId: string,
  name: string,
  listenPosition?: { x: number; y: number },
) {
  const resp = await fetch(`${BASE}/compute-volumes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ myPosition, roomId, name, ...(listenPosition ? { listenPosition } : {}) }),
  });
  expect(resp.ok).toBe(true);
  return resp.json() as Promise<{ myBlob: string; peerVolumes: Record<string, number> }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  server = spawn('node', ['dist/index.js'], {
    env: { ...process.env, PORT: String(PORT), ENCRYPTION_KEY: TEST_KEY },
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
    // Enemy near the edge of vision range (1350u) → faintly audible
    sendCoords(enemyEdge, 1300, 0);
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
});
