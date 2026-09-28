// The standing anti-cheat guard: docs/threat-model.md Part 1 — "Clients never
// see another client's raw position."
//
// Written as an invariant over EVERYTHING that reached each client rather than
// as a check of one message shape, because the way that promise gets broken is
// not a deliberate new coordinates message. It is a field quietly added to
// room_state, or to the relayed position frame, or a "fix" to the long-dead
// peer-avoidance signal that decides the tracker would score better if it knew
// where the allies were. A per-shape assertion would pass through all three.
//
// The honest limit, stated so a green run is not over-read: `signal` payloads
// are relayed opaquely by the server, so in this suite their contents are
// whatever our own FakePeerConnection wrote. That channel can only be policed
// server-side — see docs/_pending/test-architecture-b.md.

import { E2EClient, makeClient, startAll, waitForMesh, waitFor } from './harness/client';
import { inboundFor, resetTaps, volumeExchanges, volumesFor } from './harness/tap';
import { resetTauriFake } from './fakes/tauri-core';
import { emittedEvents, resetEventFake } from './fakes/tauri-event';
import { clearStoredPrefs } from './setup/dom';
import { player } from './fakes/game-state';

const FRAME_TYPES = ['room_state', 'peer_joined', 'peer_left', 'signal', 'position'];
const POSITION_BLOB_KEYS = ['summonerName', 'championName', 'team', 'isMuted', 'isDead'];

/** Every object anywhere in `value`, the root included. */
function objectsIn(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) objectsIn(item, out);
  } else if (value && typeof value === 'object') {
    out.push(value as Record<string, unknown>);
    for (const item of Object.values(value)) objectsIn(item, out);
  }
  return out;
}

/** A numeric x/y pair is what a leaked game coordinate looks like on the wire. */
function coordinateShaped(value: unknown): Record<string, unknown>[] {
  return objectsIn(value).filter((o) => typeof o.x === 'number' && typeof o.y === 'number');
}

let clients: E2EClient[] = [];

beforeEach(() => {
  clients = [];
  resetTaps();
  resetTauriFake();
  resetEventFake();
  clearStoredPrefs();
});

afterEach(async () => {
  for (const client of clients) client.stop();
  await new Promise((r) => setTimeout(r, 100));
});

describe('E9 nothing a client receives carries another player\'s coordinates', () => {
  it('holds across a full two-client session', async () => {
    const roster = [
      player('PlayerOne', 'CMPL', 'Ahri', 'ORDER'),
      player('PlayerTwo', 'CMPL', 'Zed', 'CHAOS'),
    ];
    const a = roster[0].summonerName;
    const b = roster[1].summonerName;
    const [one, two] = [makeClient(a, roster), makeClient(b, roster)];
    clients.push(one, two);

    one.tracker.moveTo(7000, 7000);
    two.tracker.moveTo(7400, 7000);
    await startAll([one, two]);
    await waitForMesh(one, two);
    // Wait until the proximity chain has actually run: an invariant that holds
    // because nothing happened proves nothing.
    await waitFor(() => volumesFor(a).some((e) => (e.response?.peerVolumes?.[b] ?? 0) > 0),
      'a live proximity exchange');
    await waitFor(() => inboundFor(a).some((m) => m.type === 'position'), 'a presence broadcast');

    for (const name of [a, b]) {
      const frames = inboundFor(name);
      expect(frames.length).toBeGreaterThan(0);

      // An `error` frame is a broken session, not a compliant one — a rate-limit
      // trip or a rejected join would otherwise satisfy a type allowlist while
      // the whole suite silently proves nothing.
      expect(frames.filter((f) => f.type === 'error')).toEqual([]);
      for (const frame of frames) expect(FRAME_TYPES).toContain(frame.type);

      for (const frame of frames.filter((f) => f.type === 'position')) {
        // The blob is a JSON string on the wire, relayed byte-for-byte by the
        // server, so it has to be parsed before its keys mean anything.
        const blob = JSON.parse(frame.blob);
        expect(Object.keys(blob).sort()).toEqual([...POSITION_BLOB_KEYS].sort());
      }

      // The structural sweep. `signal` is excluded and separately declared
      // above as out of this test's reach.
      for (const frame of frames.filter((f) => f.type !== 'signal')) {
        expect(coordinateShaped(frame)).toEqual([]);
      }
    }

    // The volume API answers with gains, never with the positions it derived
    // them from.
    expect(volumeExchanges.length).toBeGreaterThan(0);
    for (const exchange of volumeExchanges) {
      expect(Object.keys(exchange.response).sort()).toEqual(['myBlob', 'peerVolumes']);
      // myBlob is a legacy empty string, not a number — the numeric bound is
      // the peer gains only.
      expect(typeof exchange.response.myBlob).toBe('string');
      for (const volume of Object.values(exchange.response.peerVolumes) as number[]) {
        expect(typeof volume).toBe('number');
        expect(volume).toBeGreaterThanOrEqual(0);
        expect(volume).toBeLessThanOrEqual(1);
      }
      expect(coordinateShaped(exchange.response)).toEqual([]);
    }
  });

  it('keeps peer coordinates out of the overlay scene too', async () => {
    const roster = [
      player('PlayerOne', 'CMPL2', 'Ahri', 'ORDER'),
      player('PlayerTwo', 'CMPL2', 'Zed', 'CHAOS'),
    ];
    const [one, two] = [makeClient(roster[0].summonerName, roster), makeClient(roster[1].summonerName, roster)];
    clients.push(one, two);
    const panelUpdates: any[] = [];
    (globalThis as any).window.addEventListener('overlayUpdate',
      (event: any) => panelUpdates.push(event.detail));
    one.tracker.moveTo(7000, 7000);
    two.tracker.moveTo(7400, 7000);
    await startAll([one, two]);
    await waitForMesh(one, two);
    await waitFor(() => emittedEvents.some((e) => e.event === 'scanner:scene'), 'an overlay scene');

    // The scanner scene legitimately carries OUR OWN last position; what must
    // never appear there is a second one.
    const scenes = emittedEvents.filter((e) => e.event === 'scanner:scene');
    for (const event of scenes) {
      expect(coordinateShaped(event.payload).length).toBeLessThanOrEqual(1);
    }
    // ...and at least one really did carry it, so the bound above is a bound
    // rather than a statement about an empty payload.
    expect(scenes.some((e) => coordinateShaped(e.payload).length === 1)).toBe(true);

    // The panel payload lists every peer by name, champion, team and mute
    // state. It is the other thing an "improved" overlay would be tempted to
    // put a position into.
    expect(panelUpdates.length).toBeGreaterThan(0);
    for (const detail of panelUpdates) {
      expect(coordinateShaped(detail.nearbyPeers)).toEqual([]);
    }
  });
});
