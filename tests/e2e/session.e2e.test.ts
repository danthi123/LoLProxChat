// Two clients, one real server, one game.
//
// Everything here is asserted from one of two places: the recorded
// /compute-volumes response (what the SERVER decided) or the gain the real
// AudioService applied to the peer connection (what the user would hear).
// Asserting only the second would be green even with the proximity chain
// missing entirely — positionTickInner applies 1.0 to allies locally, with no
// request at all, whenever tracking is SCANNING.

import { E2EClient, makeClient, startAll, waitFor, waitForMesh } from './harness/client';
import { inboundFor, lastVolumeFor, resetTaps, socketFor, socketsFor, volumesFor } from './harness/tap';
import { invokedCommands, resetTauriFake } from './fakes/tauri-core';
import { resetEventFake } from './fakes/tauri-event';
import { clearStoredPrefs } from './setup/dom';
import { player } from './fakes/game-state';
import { setAllyProximity, setCameraListen } from '../../src/services/audio-prefs';
import { Player } from '../../src/core/types';

const A = 'PlayerOne';
const B = 'PlayerTwo';

let clients: E2EClient[] = [];
let tagSeq = 0;

/**
 * A fresh roster per test. The room id is derived from the roster by the real
 * generateRoomId, so a unique tag line is what keeps one test's room from
 * colliding with the next one's on the server we share for the whole run.
 */
function roster(bTeam: 'ORDER' | 'CHAOS' = 'CHAOS'): { players: Player[]; a: string; b: string } {
  const tag = 'E2E' + (++tagSeq);
  const players = [
    player(A, tag, 'Ahri', 'ORDER'),
    player(B, tag, 'Zed', bTeam),
  ];
  return { players, a: players[0].summonerName, b: players[1].summonerName };
}

function track(...made: E2EClient[]): E2EClient[] {
  clients.push(...made);
  return made;
}

beforeEach(() => {
  clients = [];
  resetTaps();
  resetTauriFake();
  resetEventFake();
  clearStoredPrefs();
});

afterEach(async () => {
  for (const client of clients) client.stop();
  // Let the leave frames reach the server before the next test's join, so a
  // stale entry can't be mistaken for this test's peer.
  await new Promise((r) => setTimeout(r, 100));
});

describe('E1 join, presence and peer connection', () => {
  it('meets in the room and completes the handshake through the real server', async () => {
    const { players, a, b } = roster();
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    await startAll([one, two]);
    await waitForMesh(one, two);

    // Both clients derived the same room from the same roster, which is the
    // only reason they can see each other at all.
    const joinA = socketFor(a)!.outbound.find((m) => m.type === 'join');
    const joinB = socketFor(b)!.outbound.find((m) => m.type === 'join');
    expect(joinA.room).toBe(joinB.room);

    // Exactly one initiator per pair: 'PlayerOne#tag' < 'PlayerTwo#tag'.
    const peerAtoB = one.peerFor(b)!;
    const peerBtoA = two.peerFor(a)!;
    expect(peerAtoB.offersCreated).toBe(1);
    expect(peerBtoA.offersCreated).toBe(0);

    // B answers and never offers, whichever path built its connection — the
    // incoming offer, or its own connectToPeer winning the race with it.
    await waitFor(() => peerBtoA.offersHandled === 1, 'B to answer A\'s offer');
    await waitFor(() => peerAtoB.answersHandled === 1, 'A to receive B\'s answer');
    expect(peerBtoA.offersCreated).toBe(0);

    // ICE candidates carry no `.type` of their own, so they are the half of the
    // envelope that a missing wrapper drops silently.
    await waitFor(() => peerAtoB.remoteCandidates.length > 0, 'A to receive an ICE candidate');
    await waitFor(() => peerBtoA.remoteCandidates.length > 0, 'B to receive an ICE candidate');
    expect(peerAtoB.remoteCandidates[0]).toEqual({ candidate: 'fake-candidate-from-' + b });

    // Each side holds exactly one connection, for the other player only.
    expect([...one.peers.keys()]).toEqual([b]);
    expect([...two.peers.keys()]).toEqual([a]);
  });
});

describe('E2 allies are audible at any distance', () => {
  it('holds a teammate at 1.0 across the whole map, and the server is what says so', async () => {
    const { players, a, b } = roster('ORDER');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    await startAll([one, two]);
    await waitForMesh(one, two);

    // Opposite corners of Summoner's Rift — about 17000 units apart, well past
    // the 1350 cross-team hearing range.
    one.tracker.moveTo(1000, 1000);
    two.tracker.moveTo(13000, 13000);

    const exchange = await waitFor(
      () => volumesFor(a).find((e) => e.response?.peerVolumes?.[b] === 1),
      'the server to return the ally at 1.0',
    );
    expect(exchange.request.allyProximity).toBe(false);
    await waitFor(() => one.peerFor(b)!.volume === 1, 'the ally to be played at full volume');
  });

  it('fades the same teammate once the user opts into ally proximity (#22)', async () => {
    const { players, a, b } = roster('ORDER');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    await startAll([one, two]);
    await waitForMesh(one, two);

    one.tracker.moveTo(1000, 1000);
    two.tracker.moveTo(13000, 13000);
    await waitFor(() => one.peerFor(b)!.volume === 1, 'the ally to be audible first');

    // The only configuration whose answer the client-side SCANNING fallback
    // could not also have produced: an ally the server declines to return.
    setAllyProximity(true);
    const exchange = await waitFor(
      () => volumesFor(a).find((e) => e.request?.allyProximity === true
        && !(b in (e.response?.peerVolumes ?? {}))),
      'the server to drop the far ally under ally proximity',
    );
    expect(exchange.response.peerVolumes).toEqual({});
    await waitFor(() => one.peerFor(b)!.volume === 0, 'the far ally to fall silent');
  });
});

describe('E3 enemies fade with distance', () => {
  it('is loud at 400 units, faint at 1300, and never louder as they get further', async () => {
    const { players, a, b } = roster('CHAOS');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    await startAll([one, two]);
    await waitForMesh(one, two);

    one.tracker.moveTo(7000, 7000);
    two.tracker.moveTo(7400, 7000);
    const near = await waitFor(
      () => volumesFor(a).map((e) => e.response?.peerVolumes?.[b]).filter((v) => v > 0.5).pop(),
      'the enemy to be audible at 400 units',
    );

    two.tracker.moveTo(8300, 7000);
    const far = await waitFor(
      () => volumesFor(a).map((e) => e.response?.peerVolumes?.[b])
        .filter((v) => v !== undefined && v > 0 && v < 0.5).pop(),
      'the enemy to fade at 1300 units',
    );

    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
    await waitFor(() => one.peerFor(b)!.volume === far, 'the faded volume to be applied');
  });
});

describe('E4 an enemy past vision range is held, then silenced (#27)', () => {
  it('keeps the last volume through the grace window before falling to zero', async () => {
    const { players, a, b } = roster('CHAOS');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    await startAll([one, two]);
    await waitForMesh(one, two);

    // In range FIRST. resolveProximityTargets only holds a peer that has a
    // previous last-seen timestamp, so a peer that was never in a response
    // falls straight to 0 and the grace path is never reached at all.
    one.tracker.moveTo(7000, 7000);
    two.tracker.moveTo(7400, 7000);
    const peer = one.peerFor(b)!;
    await waitFor(() => peer.volume > 0.5, 'a settled in-range volume');

    two.tracker.moveTo(9000, 7000);
    await waitFor(
      () => volumesFor(a).slice(-1).some((e) => !(b in (e.response?.peerVolumes ?? {}))),
      'the server to drop the out-of-range enemy',
    );
    const atDrop = peer.volumes.length;
    expect(peer.volume).toBeGreaterThan(0);

    await waitFor(() => peer.volume === 0, 'the enemy to fall silent after the grace window', 6000);

    // Several ticks of hold, not a single one — a one-tick hold would be
    // indistinguishable from the drop simply landing between two ticks.
    let held = 0;
    for (let i = atDrop; i < peer.volumes.length && peer.volumes[i] > 0; i++) held++;
    expect(held).toBeGreaterThanOrEqual(3);
  });
});

describe('E5 voice on camera moves only the listener (#36)', () => {
  it('lets A hear a distant enemy from the camera while B still cannot hear A', async () => {
    const { players, a, b } = roster('CHAOS');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    // Positioned before the first tick: every scripted tracker starts at the
    // same default coordinate, and two champions standing on the same pixel are
    // audible to each other by the ordinary distance rule.
    one.tracker.moveTo(1000, 1000);
    two.tracker.moveTo(12000, 12000);
    await startAll([one, two]);
    await waitForMesh(one, two);
    await waitFor(() => volumesFor(b).length > 2, 'B to be computing volumes');

    // audio-prefs is process-global localStorage, so this toggle is on for BOTH
    // clients — there is no per-instance preference to set. The asymmetry being
    // proved is therefore not "only A opted in": it is that B's tracker has no
    // camera rectangle to report, so B keeps hearing from its champion. That
    // precondition is asserted rather than assumed.
    setCameraListen(true);
    await waitFor(() => one.tracker.cameraTrackingEnabled, 'camera tracking to be enabled');
    expect(two.tracker.getCameraPosition()).toBeNull();

    one.tracker.lookAt(12000, 12100);
    const heard = await waitFor(
      () => volumesFor(a).find((e) => e.request?.listenPosition
        && (e.response?.peerVolumes?.[b] ?? 0) > 0.9),
      'A to hear the enemy under its camera',
    );
    expect(heard.request.myPosition).toEqual({ x: 1000, y: 1000 });

    // B's own answer never mentions A: what A broadcast as coords is still A's
    // champion, 15000 units away.
    const bHeardA = volumesFor(b).filter((e) => a in (e.response?.peerVolumes ?? {}));
    expect(bHeardA).toEqual([]);
    await waitFor(() => one.peerFor(b)!.volume > 0.9, 'A to actually play the enemy');
  });
});

describe('E6 a peer leaving tears its connection down on both sides', () => {
  it('ends B\'s session and removes B from A\'s room, audio and volumes', async () => {
    const { players, a, b } = roster('ORDER');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    await startAll([one, two]);
    await waitForMesh(one, two);
    const peerAtoB = one.peerFor(b)!;
    const peerBtoA = two.peerFor(a)!;

    two.gameState.gameEnded();

    await waitFor(() => inboundFor(a).some((m) => m.type === 'peer_left' && m.name === b),
      'A to be told B left');
    await waitFor(() => peerAtoB.closed, 'A to close its connection to B');
    // B tore its own side down through the normal end-of-game path.
    expect(peerBtoA.closed).toBe(true);

    // A is still in a live session — a peer leaving is not a session ending.
    const before = volumesFor(a).length;
    await waitFor(() => volumesFor(a).length > before + 2, 'A to keep computing volumes');
    expect(volumesFor(a).slice(-1)[0].response.peerVolumes).toEqual({});
  });
});

describe('E7 reconnecting under the same name', () => {
  it('hands the name to the newer socket and routes signaling there', async () => {
    const { players, a, b } = roster('CHAOS');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    await startAll([one, two]);
    await waitForMesh(one, two);

    const room = socketFor(a)!.outbound.find((m) => m.type === 'join').room;
    const oldSocket = socketFor(b)!.socket;
    const closes: { code: number }[] = [];
    oldSocket.addEventListener('close', (event: any) => closes.push({ code: event.code }));

    // B restarts: a second socket joins the same room under the same name, and
    // the old one is still in the room because the server has not seen it go.
    const revived = new WebSocket('ws://127.0.0.1:31998/ws');
    const revivedInbound: any[] = [];
    revived.addEventListener('message', (event: any) => revivedInbound.push(JSON.parse(event.data)));
    await new Promise<void>((resolve) => revived.addEventListener('open', () => resolve()));
    revived.send(JSON.stringify({ type: 'join', room, name: b, team: 'CHAOS' }));
    await waitFor(() => revivedInbound.some((m) => m.type === 'room_state'),
      'the revived socket to be admitted');

    // 4000 is the takeover code the client treats as terminal — without it the
    // two connections evict each other forever.
    await waitFor(() => closes.length > 0, 'the old socket to be closed');
    expect(closes[0].code).toBe(4000);

    // The assertion that actually distinguishes the bug: client-side state is
    // keyed by name, so "A still has exactly one peer for B" is true whether or
    // not the server kept a stale entry shadowing the live one. Delivery is not.
    socketFor(a)!.socket.send(JSON.stringify({
      type: 'signal',
      to: b,
      payload: { type: 'ice-candidate', payload: { candidate: 'e7-probe' } },
    }));
    const delivered = await waitFor(
      () => revivedInbound.find((m) => m.type === 'signal'
        && m.payload?.payload?.candidate === 'e7-probe'),
      'the probe signal to reach the revived socket',
    );
    expect(delivered.from).toBe(a);
    expect(socketsFor(b)[0].inbound.some((m) => m.type === 'signal'
      && m.payload?.payload?.candidate === 'e7-probe')).toBe(false);

    revived.close();
  });
});

describe('E8 session teardown', () => {
  it('stops every loop it started, and a second session starts exactly one of each', async () => {
    const { players, a, b } = roster('ORDER');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    await startAll([one, two]);
    await waitForMesh(one, two);
    const peerAtoB = one.peerFor(b)!;
    await waitFor(() => volumesFor(a).length > 2, 'the first session to be computing volumes');

    one.gameState.gameEnded();
    await waitFor(() => one.tracker.stopped, 'tracking to stop');
    expect(peerAtoB.closed).toBe(true);
    // The scanner window is left floating over wherever the minimap last was
    // unless this fires.
    expect(invokedCommands()).toContain('hide_scanner');

    // The volume tick and the geometry poll are both cleared, so nothing keeps
    // asking the server after the game is over.
    await new Promise((r) => setTimeout(r, 120));
    const settled = volumesFor(a).length;
    await new Promise((r) => setTimeout(r, 300));
    expect(volumesFor(a).length).toBe(settled);

    // Second game, same process. A leaked tick from the first session would
    // double the request rate here.
    one.gameState.state = { ...one.gameState.state, isInGame: true, gameFlowPhase: 'InProgress' };
    await waitFor(() => volumesFor(a).length > settled, 'a second session to start');
    const atStart = volumesFor(a).length;
    await new Promise((r) => setTimeout(r, 500));
    const perHalfSecond = volumesFor(a).length - atStart;
    expect(perHalfSecond).toBeGreaterThanOrEqual(4);
    expect(perHalfSecond).toBeLessThanOrEqual(16);
  });
});
