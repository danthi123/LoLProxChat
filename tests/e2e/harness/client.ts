// One end-to-end client: a real Orchestrator, a real AudioService, a real
// SignalingService and a real VolumeClient, talking to the real built server.
//
// Faked: the Tauri command surface (module-mapped), WebAudio, WebRTC, the
// League polls, and the CV tracker. Everything between them — session creation,
// room derivation, the join handshake, presence broadcast, coords, the
// /compute-volumes request, the grace window and the per-peer gain — is
// production code.

import { Orchestrator, OrchestratorDeps } from '../../../src/services/orchestrator';
import { AudioService } from '../../../src/services/audio';
import { SignalingService } from '../../../src/services/signaling';
import { VolumeClient } from '../../../src/services/volume-client';
import { TrackingState } from '../../../src/services/tracking';
import { PeerConnection } from '../../../src/services/peer-connection';
import { Player } from '../../../src/core/types';
import { ScriptedGameState, SUMMONERS_RIFT_GAME_DATA } from '../fakes/game-state';
import { ScriptedTracker } from '../fakes/tracker';
import { FakePeerConnection } from '../fakes/peer';
import { inboundFor } from './tap';

export interface E2EClient {
  name: string;
  orchestrator: Orchestrator;
  gameState: ScriptedGameState;
  tracker: ScriptedTracker;
  /** Null until startSession has built it (i.e. until the client has joined). */
  audio: AudioService | null;
  peers: Map<string, FakePeerConnection>;
  /** Every volume map the orchestrator handed to AudioService, in order. */
  volumesApplied: Record<string, number>[];
  peerFor(remoteName: string): FakePeerConnection | undefined;
  stop(): void;
}

/**
 * The three getters positionTickInner checks before it will talk to the server
 * (orchestrator.ts: SCANNING short-circuit, (0,0) guard, 2s hold guard). Called
 * on construction and re-callable after a test moves the tracker, so a script
 * that silently disables the network path fails here instead of as a timeout
 * three assertions later.
 */
export function assertTrackerReportsToServer(tracker: ScriptedTracker): void {
  if (tracker.getState() !== TrackingState.LOCKED) {
    throw new Error('scripted tracker must be LOCKED to reach /compute-volumes, is ' + tracker.getState());
  }
  const position = tracker.getLastPosition();
  if (!position || (position.x === 0 && position.y === 0)) {
    throw new Error('scripted tracker must report a non-zero position to reach /compute-volumes');
  }
  if (tracker.getHoldDurationSec() > 2) {
    throw new Error('scripted tracker hold must stay <= 2s to reach /compute-volumes');
  }
}

export function makeClient(
  localName: string,
  roster: Player[],
  overrides: Partial<OrchestratorDeps> = {},
): E2EClient {
  const gameState = new ScriptedGameState(localName, roster, SUMMONERS_RIFT_GAME_DATA);
  const tracker = new ScriptedTracker({ x: 0, y: 0, width: 1920, height: 1080 });
  const peers = new Map<string, FakePeerConnection>();
  const volumesApplied: Record<string, number>[] = [];

  const client: E2EClient = {
    name: localName,
    gameState,
    tracker,
    peers,
    volumesApplied,
    audio: null,
    orchestrator: null as unknown as Orchestrator,
    peerFor: (remoteName) => peers.get(remoteName),
    stop: () => { /* replaced below */ },
  };

  const deps: Partial<OrchestratorDeps> = {
    createGameState: () => gameState,
    createSignaling: () => new SignalingService(),
    createAudio: (signaling, name) => {
      const audio = new AudioService(signaling, name, async (remoteName) => {
        const peer = new FakePeerConnection(name, remoteName);
        peers.set(remoteName, peer);
        return peer as unknown as PeerConnection;
      });
      // Wrap rather than replace: the real applyPeerVolumes still runs, this
      // only records what it was asked to apply.
      const applyPeerVolumes = audio.applyPeerVolumes.bind(audio);
      audio.applyPeerVolumes = (volumes) => {
        volumesApplied.push(volumes);
        applyPeerVolumes(volumes);
      };
      client.audio = audio;
      return audio;
    },
    createTracking: () => tracker as unknown as import('../../../src/services/tracking').TrackingService,
    createClassifier: async () => null,
    createVolumeClient: () => new VolumeClient(),
    // Fast enough that a test waits tens of milliseconds rather than seconds;
    // the config poll is pushed out of the way because nothing here changes
    // game.cfg and a 5s re-read is pure noise.
    timings: { gameStatePollMs: 50, volumeTickMs: 50, configPollMs: 60_000 },
    ...overrides,
  };

  assertTrackerReportsToServer(tracker);
  client.orchestrator = new Orchestrator(deps);
  client.stop = () => client.orchestrator.stop();
  return client;
}

/** Resolve once `predicate` holds, or throw naming what was last seen. */
export async function waitFor<T>(
  predicate: () => T | undefined | null | false,
  label: string,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    last = predicate();
    if (last) return last as T;
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for ' + label + ' (last value: ' + JSON.stringify(last) + ')');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Start every client and wait until each has been accepted into the room. */
export async function startAll(clients: E2EClient[]): Promise<void> {
  for (const client of clients) client.orchestrator.start();
  for (const client of clients) {
    await waitFor(
      () => inboundFor(client.name).some((m) => m.type === 'room_state'),
      client.name + ' to join the room',
    );
  }
}

/** Wait until both sides hold a peer connection for each other. */
export async function waitForMesh(a: E2EClient, b: E2EClient): Promise<void> {
  await waitFor(() => a.peerFor(b.name) && b.peerFor(a.name), 'peers on both sides');
}
