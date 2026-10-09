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
import { setAllyProximity, setCameraListen, setSharedReset } from '../../src/services/audio-prefs';
import { SignalingService } from '../../src/services/signaling';
import { Player } from '../../src/core/types';
import { TrackingState } from '../../src/services/tracking';

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
  // Ally proximity and voice on camera both default ON (v0.5.18). Every test
  // here starts from plain proximity and turns on what it is about; the
  // defaults themselves are checked in E2 and in tests/services/audio-prefs.test.ts.
  setAllyProximity(false);
  setCameraListen(false);
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

describe('E2 allies are audible at any distance with ally proximity off', () => {
  it('asks the server for ally proximity on a fresh install', async () => {
    clearStoredPrefs();
    const { players, a, b } = roster('ORDER');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    one.tracker.moveTo(1000, 1000);
    two.tracker.moveTo(1200, 1000);
    await startAll([one, two]);
    await waitForMesh(one, two);

    const exchange = await waitFor(() => volumesFor(a)[0], 'a volume exchange');
    expect(exchange.request.allyProximity).toBe(true);
    await waitFor(() => one.tracker.cameraTrackingEnabled, 'camera tracking to be on by default');
  });

  it('holds a teammate at 1.0 across the whole map, and the server is what says so', async () => {
    const { players, a, b } = roster('ORDER');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    // Opposite corners of Summoner's Rift — about 17000 units apart, well past
    // the 1350 cross-team hearing range — and set before the first tick, so
    // there is no exchange in this test that the distance rule could also have
    // answered with 1.0.
    one.tracker.moveTo(1000, 1000);
    two.tracker.moveTo(13000, 13000);
    await startAll([one, two]);
    await waitForMesh(one, two);

    const exchange = await waitFor(
      () => volumesFor(a).find((e) => e.response?.peerVolumes?.[b] === 1),
      'the server to return the ally at 1.0',
    );
    expect(exchange.request.allyProximity).toBe(false);
    // The recorded setVolume history rather than the live field: a peer
    // connection is constructed at volume 1, so the field alone reads true
    // before the client has applied anything at all.
    await waitFor(() => one.peerFor(b)!.volumes.includes(1), 'the ally to be played at full volume');
  });

  it('fades the same teammate once the user opts into ally proximity (#22)', async () => {
    const { players, a, b } = roster('ORDER');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    one.tracker.moveTo(1000, 1000);
    two.tracker.moveTo(13000, 13000);
    await startAll([one, two]);
    await waitForMesh(one, two);

    await waitFor(() => one.peerFor(b)!.volumes.includes(1), 'the ally to be audible first');

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

describe('E2b a player the tracker loses is placed where they were last seen, for teammates only', () => {
  // A 2026-10-09 test heard other lanes "all the time": the moment a tracker
  // lost its player, every teammate went to full volume on both sides.
  it('scores the lost player\'s teammates from there, both ways, and drops the enemy', async () => {
    const tag = 'E2E' + (++tagSeq);
    const players = [
      player(A, tag, 'Ahri', 'ORDER'),
      player(B, tag, 'Zed', 'ORDER'),
      player('PlayerThree', tag, 'Lux', 'CHAOS'),
    ];
    const [a, b, c] = players.map((p) => p.summonerName);
    setAllyProximity(true);
    const [one, two, three] = track(makeClient(a, players), makeClient(b, players), makeClient(c, players));
    // B 1200 units from A: inside hearing range, outside the full-volume
    // plateau, so a distance score is told apart from the old 1.0.
    one.tracker.moveTo(7000, 7000);
    two.tracker.moveTo(8200, 7000);
    three.tracker.moveTo(7300, 7000);
    await startAll([one, two, three]);
    await waitForMesh(one, two);
    await waitForMesh(one, three);
    await waitFor(
      () => volumesFor(c).slice(-1).some((e) => (e.response?.peerVolumes?.[a] ?? 0) > 0.5),
      'the enemy to hear A up close',
    );

    one.tracker.lastSeen = { x: 7000, y: 7000 };
    one.tracker.state = TrackingState.SCANNING;

    // A asks for its teammates only, from where it was last seen, and gets B
    // by distance; the enemy beside it is neither asked for nor played.
    const lost = await waitFor(
      () => volumesFor(a).find((e) => e.request?.alliesOnly === true && b in (e.response?.peerVolumes ?? {})),
      'A to ask for its allies from its last-seen position',
    );
    expect(lost.request.myPosition).toEqual({ x: 7000, y: 7000 });
    expect(lost.response.peerVolumes[b]).toBeGreaterThan(0.3);
    expect(lost.response.peerVolumes[b]).toBeLessThan(0.8);
    expect(c in lost.response.peerVolumes).toBe(false);
    await waitFor(() => one.peerFor(c)!.volume === 0, 'A to stop hearing the enemy');

    // B scores A at the same place, not at the old full volume.
    const fromB = await waitFor(
      () => volumesFor(b).slice(-1).map((e) => e.response?.peerVolumes?.[a]).find((v) => v !== undefined && v < 0.8),
      'B to hear A by distance from where A was last seen',
    );
    expect(fromB).toBeGreaterThan(0.3);
    // And the enemy stops hearing A at all: the position was disowned.
    await waitFor(
      () => volumesFor(c).slice(-1).some((e) => !(a in (e.response?.peerVolumes ?? {}))),
      'the enemy to stop hearing A',
    );

    // B walking off out of range of that spot no longer hears A.
    two.tracker.moveTo(13000, 13000);
    await waitFor(
      () => volumesFor(b).slice(-1).some((e) => e.request?.myPosition?.x === 13000 && !(a in (e.response?.peerVolumes ?? {}))),
      'B, far from where A was last seen, to stop hearing A',
    );

    // A presses RESET, which drops the last sighting: both sides go back to
    // full team volume rather than keep scoring a place the user called wrong.
    one.tracker.lastSeen = null;
    await waitFor(
      () => volumesFor(b).slice(-1).some((e) => e.response?.peerVolumes?.[a] === 1),
      'B to hear A at full volume once A drops the sighting',
    );
    await waitFor(() => one.peerFor(b)!.volume === 1, 'A to hear B at full volume');
  });

  it('with nowhere to start from, a lost player hears its teammates at full volume, as before', async () => {
    const { players, a, b } = roster('ORDER');
    setAllyProximity(true);
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    one.tracker.moveTo(1000, 1000);
    two.tracker.moveTo(13000, 13000);
    await startAll([one, two]);
    await waitForMesh(one, two);
    await waitFor(() => one.peerFor(b)!.volume === 0, 'the far ally to be silent while A is placed');

    one.tracker.state = TrackingState.SCANNING; // lastSeen stays null
    const before = volumesFor(a).length;
    await waitFor(() => one.peerFor(b)!.volume === 1, 'A to hear the ally at full volume');
    expect(volumesFor(a).slice(before).some((e) => e.request?.alliesOnly)).toBe(false);
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
    // Anchored on A's own moved coordinate, and asserted absolutely rather than
    // only against `far`: an exchange sent before the move carries a start
    // position instead, and a distance reading taken off one of those describes
    // wherever the two clients happened to begin.
    const near = await waitFor(
      () => volumesFor(a).filter((e) => e.request?.myPosition?.x === 7000)
        // B's coords reach the server up to a tick behind A's, so the first
        // anchored exchanges carry no entry for B at all.
        .map((e) => e.response?.peerVolumes?.[b]).filter((v) => v !== undefined).pop(),
      'the enemy to be audible at 400 units',
    );
    expect(near).toBeGreaterThan(0.5);

    two.tracker.moveTo(8300, 7000);
    const far = await waitFor(
      () => volumesFor(a).filter((e) => e.request?.myPosition?.x === 7000)
        .map((e) => e.response?.peerVolumes?.[b])
        .filter((v) => v !== undefined && v < 0.5).pop(),
      'the enemy to fade at 1300 units',
    );

    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
    await waitFor(() => one.peerFor(b)!.volumes.includes(far), 'the faded volume to be applied');
  });
});

describe('E4 an enemy past vision range is held, then silenced (#27)', () => {
  it('keeps the last volume through the grace window before falling to zero', async () => {
    const { players, a, b } = roster('CHAOS');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    await startAll([one, two]);
    await waitForMesh(one, two);

    // In range FIRST, and waited on through the server's own answer:
    // resolveProximityTargets only holds a peer that has a previous last-seen
    // timestamp, and that timestamp is written when a response containing the
    // peer is applied. A peer that was never in one falls straight to 0 and the
    // grace path is never reached at all.
    one.tracker.moveTo(7000, 7000);
    two.tracker.moveTo(7400, 7000);
    const peer = one.peerFor(b)!;
    const inRange = await waitFor(
      () => volumesFor(a).filter((e) => e.request?.myPosition?.x === 7000)
        .map((e) => e.response?.peerVolumes?.[b]).filter((v) => v !== undefined && v > 0.5).pop(),
      'the server to place the enemy in range',
    );
    await waitFor(() => peer.volumes.includes(inRange), 'that in-range volume to be applied');

    two.tracker.moveTo(9000, 7000);
    await waitFor(
      () => volumesFor(a).slice(-1).some((e) => !(b in (e.response?.peerVolumes ?? {}))),
      'the server to drop the out-of-range enemy',
    );
    const atDrop = peer.volumes.length;

    await waitFor(() => peer.volume === 0, 'the enemy to fall silent after the grace window', 6000);

    // Several ticks of hold, not a single one — a one-tick hold would be
    // indistinguishable from the drop simply landing between two ticks. Each of
    // them has to be the volume the server last returned, which is what
    // separates a grace hold from any other way of arriving at a non-zero gain.
    const held: number[] = [];
    for (let i = atDrop; i < peer.volumes.length && peer.volumes[i] > 0; i++) held.push(peer.volumes[i]);
    expect(held.length).toBeGreaterThanOrEqual(3);
    for (const volume of held) expect(volume).toBe(inRange);
  });
});

describe('E5 voice on camera is mutual opt-in and one-way (#36)', () => {
  // The feature is an opt-in between two players, enforced server-side: each
  // client publishes its camera centre to room state over `coords`, the server
  // reads the requester's own from there too, and a camera counts for a pair
  // only when both sides have published one. It is one-way: the camera is a
  // point you listen from, never a point you are heard at.
  //
  // audio-prefs is process-global localStorage, so both clients here share one
  // toggle; the per-side matrix (one on, one off) is covered where the rule is
  // enforced, in server/tests/volumes.test.ts and server/tests/integration.test.ts.
  it('lets the player looking hear a distant enemy, without being heard back', async () => {
    const { players, a, b } = roster('CHAOS');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    // Positioned before the first tick: the distance the camera is supposed to
    // reach across is the whole subject, so it has to hold from the first
    // exchange rather than from whenever a move happens to land.
    one.tracker.moveTo(1000, 1000);
    two.tracker.moveTo(12000, 12000);
    await startAll([one, two]);
    await waitForMesh(one, two);
    await waitFor(() => volumesFor(b).length > 2, 'B to be computing volumes');

    // 15000 units apart — nothing either way while the feature is off.
    expect(volumesFor(a).filter((e) => b in (e.response?.peerVolumes ?? {}))).toEqual([]);
    expect(volumesFor(b).filter((e) => a in (e.response?.peerVolumes ?? {}))).toEqual([]);

    setCameraListen(true);
    await waitFor(() => one.tracker.cameraTrackingEnabled, 'camera tracking to be enabled');

    // A pans onto B. B is not looking anywhere in particular, so B publishes
    // its champion as its camera — which is what "opted in, nothing to report
    // this frame" looks like on the wire, and still counts as consent.
    one.tracker.lookAt(12000, 12100);

    const aHeard = await waitFor(
      () => volumesFor(a).map((e) => e.response?.peerVolumes?.[b]).filter((v) => v !== undefined).pop(),
      'A to hear the enemy under its camera',
    );
    expect(aHeard).toBeGreaterThan(0.9);
    await waitFor(() => one.peerFor(b)!.volume > 0.9, 'A to actually play the enemy');

    // B's camera is on B's own champion, nowhere near A, so B hears nothing:
    // A listening in does not make A audible.
    const bSince = volumesFor(b).length;
    await waitFor(() => volumesFor(b).length > bSince + 4, 'several more B exchanges to go by');
    expect(volumesFor(b).slice(bSince).filter((e) => a in (e.response?.peerVolumes ?? {}))).toEqual([]);
    expect(two.peerFor(a)!.volume).toBe(0);
  });

  it('reaches nobody while the setting is off, and never asks the server to', async () => {
    const { players, a, b } = roster('CHAOS');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    one.tracker.moveTo(1000, 1000);
    two.tracker.moveTo(12000, 12000);
    await startAll([one, two]);
    await waitForMesh(one, two);

    one.tracker.lookAt(12000, 12100);
    await waitFor(() => volumesFor(a).length > 4, 'several volume exchanges to go by');

    expect(volumesFor(a).filter((e) => b in (e.response?.peerVolumes ?? {}))).toEqual([]);
    expect(volumesFor(b).filter((e) => a in (e.response?.peerVolumes ?? {}))).toEqual([]);

    // And the request never names a listening point of its own. That field is
    // how the feature used to work, it let a client hear from somewhere its
    // peers were never scored against, and the server now ignores it — but the
    // client should not be sending it either.
    for (const e of [...volumesFor(a), ...volumesFor(b)]) {
      expect(e.request?.listenPosition).toBeUndefined();
    }
  });
});

describe('E5b a blind tracker does not cut the player out of everyone\'s audio', () => {
  // From a real two-client session: in forty seconds the tracker blinked four
  // times, every one of them "no own-team icons on the minimap at all", every
  // one recovered on its own within five seconds — and every one cut the other
  // player's audio dead for 1-4s, because the coordinate disown fired at 2s
  // and the server then had no position to score against. A real game always
  // draws four allies on the minimap, so "none at all" is the capture failing,
  // not the champion moving.
  it('keeps B hearing A through a 3s no-icon hold, and silences A on a 3s no-match hold', async () => {
    const { players, a, b } = roster('CHAOS');
    const [one, two] = track(makeClient(a, players), makeClient(b, players));
    await startAll([one, two]);
    await waitForMesh(one, two);

    one.tracker.moveTo(7000, 7000);
    two.tracker.moveTo(7400, 7000);
    await waitFor(
      () => volumesFor(b).slice(-1).some((e) => (e.response?.peerVolumes?.[a] ?? 0) > 0.5),
      'B to hear A at close range',
    );

    // Blind hold: the icon is gone from the capture, but we have no evidence
    // A moved. A keeps vouching for its position and B keeps hearing it.
    one.tracker.holdReason = 'no-blobs';
    one.tracker.holdSec = 3;
    const blindStarted = volumesFor(b).length;
    await waitFor(
      () => volumesFor(b).length > blindStarted + 3,
      'three more of B\'s volume exchanges to go by while A is blind',
    );
    for (const e of volumesFor(b).slice(blindStarted)) {
      expect(e.response?.peerVolumes?.[a]).toBeGreaterThan(0.5);
    }

    // Same duration, different reason: icons were on the minimap and none of
    // them was A. That IS a movement signal — a recall is the case that
    // matters — so A disowns its position and B stops hearing it.
    one.tracker.holdReason = 'no-match';
    await waitFor(
      () => volumesFor(b).slice(-1).some((e) => !(a in (e.response?.peerVolumes ?? {}))),
      'the server to forget A once A says it has moved',
    );
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

describe('E9 shared RESET reaches only the players who opted in', () => {
  it('relays a RESET to an opted-in player and never sends it to one who is not', async () => {
    // Three in one game. The setting is process-global here (one localStorage
    // for every client), so the third client is held opted out at its own
    // signaling layer: whatever the panel says, it tells the server "off".
    class OptedOut extends SignalingService {
      setSharedReset(): void { super.setSharedReset(false); }
    }
    setSharedReset(true);
    const tag = 'E2E' + (++tagSeq);
    const players = [
      player(A, tag, 'Ahri', 'ORDER'),
      player(B, tag, 'Zed', 'CHAOS'),
      player('PlayerThree', tag, 'Lux', 'ORDER'),
    ];
    const [a, b, c] = players.map(p => p.summonerName);
    const [one, two, three] = track(
      makeClient(a, players),
      makeClient(b, players),
      makeClient(c, players, { createSignaling: () => new OptedOut() }),
    );
    await startAll([one, two, three]);
    await waitForMesh(one, two);
    await waitForMesh(one, three);

    expect(socketFor(c)!.outbound.find((m) => m.type === 'join').sharedReset).toBe(false);
    one.orchestrator.resetPosition();
    await waitFor(() => two.tracker.rescans === 1, 'the opted-in player rescanning');
    // The relay names the sender and carries nothing else.
    expect(inboundFor(b).filter((m) => m.type === 'reset')).toEqual([{ type: 'reset', from: a }]);

    // Give the server every chance to have sent the other one too.
    await new Promise((r) => setTimeout(r, 300));
    expect(inboundFor(c).some((m) => m.type === 'reset')).toBe(false);
    expect(inboundFor(a).some((m) => m.type === 'reset')).toBe(false);
    expect(three.tracker.rescans).toBe(0);
    expect(one.tracker.resets).toBe(1);
  });
});
