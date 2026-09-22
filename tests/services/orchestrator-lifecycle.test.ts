// The session lifecycle, in the FAST suite.
//
// This is the transition table the game-state poll drives — League closing, a
// game starting, death and respawn, a game ending — plus the teardown that has
// to leave nothing running. None of it needs I/O: with the dependency seam and
// fake timers it is a state machine over a scripted poll, so it belongs in the
// run that gates every commit rather than in the slow e2e job, which is
// non-blocking by design.
//
// The end-to-end counterpart (two clients, a real server, real volumes) is
// tests/e2e/session.e2e.test.ts.

jest.mock('@tauri-apps/api/core', () => ({
  invoke: jest.fn(async (command: string) => {
    if (command === 'get_game_window_info') {
      return {
        found: true,
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        matchedBy: 'class',
        windowTitle: 'League of Legends (TM) Client',
        processName: 'League of Legends.exe',
        virtualScreen: { x: 0, y: 0, width: 1920, height: 1080 },
        primaryScreen: { x: 0, y: 0, width: 1920, height: 1080 },
        error: null,
      };
    }
    if (command === 'read_league_config_file') return '[HUD]\nMinimapScale=1.0\n';
    return undefined;
  }),
}));
jest.mock('@tauri-apps/api/event', () => ({ emit: jest.fn(async () => undefined) }));

import { invoke } from '@tauri-apps/api/core';
import { Orchestrator, OrchestratorDeps, defaultDeps } from '../../src/services/orchestrator';
import { AudioService } from '../../src/services/audio';
import { GameStateService } from '../../src/services/game-state';
import { SignalingService } from '../../src/services/signaling';
import { TrackingService, TrackingState } from '../../src/services/tracking';
import { VolumeClient } from '../../src/services/volume-client';
import { PeerConnection } from '../../src/services/peer-connection';
import { Player } from '../../src/core/types';
import { installDomShims } from '../e2e/setup/dom';
import { installWebAudioFakes } from '../e2e/fakes/webaudio';
import { FakePeerConnection } from '../e2e/fakes/peer';
import { ScriptedGameState, player } from '../e2e/fakes/game-state';
import { ScriptedTracker } from '../e2e/fakes/tracker';

installDomShims();
installWebAudioFakes();

const invokeMock = invoke as unknown as jest.Mock;

const ROSTER: Player[] = [
  player('PlayerOne', 'LIFE', 'Ahri', 'ORDER'),
  player('PlayerTwo', 'LIFE', 'Zed', 'CHAOS'),
];
const LOCAL = ROSTER[0].summonerName;

interface Harness {
  orchestrator: Orchestrator;
  gameState: ScriptedGameState;
  tracker: ScriptedTracker;
  audio: { cleanup: jest.Mock; applyPeerVolumes: jest.Mock };
  signaling: { joinRoom: jest.Mock; leaveRoom: jest.Mock };
  volumeCalls: number;
}

/** Let every pending promise chain settle without letting an interval fire. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await jest.advanceTimersByTimeAsync(0);
}

function makeHarness(): Harness {
  const gameState = new ScriptedGameState(LOCAL, ROSTER, { gameMode: 'CLASSIC', mapNumber: 11 });
  const tracker = new ScriptedTracker({ x: 0, y: 0, width: 1920, height: 1080 });
  const audio = {
    initMicrophone: jest.fn(async () => undefined),
    setSelfMuted: jest.fn(),
    setMuteAll: jest.fn(),
    isSelfMuted: jest.fn(() => false),
    isPlayerMuted: jest.fn(() => false),
    applyPeerVolumes: jest.fn(),
    hasPeer: jest.fn(() => false),
    connectToPeer: jest.fn(async () => undefined),
    handleSignal: jest.fn(async () => undefined),
    disconnectPeer: jest.fn(),
    cleanup: jest.fn(),
  };
  const signaling = {
    joinRoom: jest.fn(),
    leaveRoom: jest.fn(),
    broadcastPosition: jest.fn(),
    sendCoords: jest.fn(),
    sendSignal: jest.fn(),
  };
  const harness: Harness = {
    gameState,
    tracker,
    audio: audio as unknown as Harness['audio'],
    signaling: signaling as unknown as Harness['signaling'],
    volumeCalls: 0,
    orchestrator: null as unknown as Orchestrator,
  };
  const deps: Partial<OrchestratorDeps> = {
    createGameState: () => gameState,
    createSignaling: () => signaling as unknown as SignalingService,
    createAudio: () => audio as unknown as AudioService,
    createTracking: () => tracker as unknown as TrackingService,
    createClassifier: async () => null,
    createVolumeClient: () => ({
      computeVolumes: async () => {
        harness.volumeCalls++;
        return { peerVolumes: {} };
      },
    }) as unknown as VolumeClient,
    timings: { gameStatePollMs: 3000, volumeTickMs: 100, configPollMs: 5000 },
  };
  harness.orchestrator = new Orchestrator(deps);
  return harness;
}

/** Start the orchestrator and run one game-state poll to completion. */
async function startInGame(): Promise<Harness> {
  const harness = makeHarness();
  harness.orchestrator.start();
  await settle();
  return harness;
}

beforeEach(() => {
  jest.useFakeTimers();
  invokeMock.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => { /* keep output readable */ });
  jest.spyOn(console, 'warn').mockImplementation(() => { /* ditto */ });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('defaultDeps', () => {
  // The seam's own top risk: a default written slightly differently from the
  // expression it replaced changes production while every test, which injects
  // its own fakes, stays green.
  it('builds the real services', () => {
    const deps = defaultDeps();
    expect(deps.createGameState()).toBeInstanceOf(GameStateService);
    expect(deps.createSignaling()).toBeInstanceOf(SignalingService);
    expect(deps.createAudio(new SignalingService(), 'me')).toBeInstanceOf(AudioService);
    expect(deps.createTracking({ x: 0, y: 0, width: 1920, height: 1080 }, 'summoners_rift'))
      .toBeInstanceOf(TrackingService);
    expect(deps.createVolumeClient()).toBeInstanceOf(VolumeClient);
  });

  it('keeps the shipped cadences', () => {
    expect(defaultDeps().timings).toEqual({
      gameStatePollMs: 3000,
      volumeTickMs: 100,
      configPollMs: 5000,
    });
  });
});

describe('the game-state poll', () => {
  it('starts a session when a game is already in progress', async () => {
    const h = await startInGame();
    expect(h.signaling.joinRoom).toHaveBeenCalledTimes(1);
    expect(h.tracker.started).toBe(true);
    // Session start pushed capture geometry and read the minimap scale.
    expect(invokeMock.mock.calls.map((c) => c[0])).toContain('get_game_window_info');
    expect(h.tracker.appliedMinimapScale).toBe(1);
  });

  it('does not start a second session while one is live', async () => {
    const h = await startInGame();
    await jest.advanceTimersByTimeAsync(9000);
    expect(h.signaling.joinRoom).toHaveBeenCalledTimes(1);
  });

  it('ends the session when the game ends', async () => {
    const h = await startInGame();
    h.gameState.gameEnded();
    await jest.advanceTimersByTimeAsync(3000);
    await settle();
    expect(h.signaling.leaveRoom).toHaveBeenCalledTimes(1);
    expect(h.audio.cleanup).toHaveBeenCalledTimes(1);
    expect(h.tracker.stopped).toBe(true);
    expect(invokeMock.mock.calls.map((c) => c[0])).toContain('hide_scanner');
  });

  it('ends the session when League itself closes', async () => {
    const h = await startInGame();
    h.gameState.leagueClosed();
    await jest.advanceTimersByTimeAsync(3000);
    await settle();
    expect(h.signaling.leaveRoom).toHaveBeenCalledTimes(1);
    expect(h.audio.cleanup).toHaveBeenCalledTimes(1);
  });

  it('drives the tracker through death and respawn', async () => {
    const h = await startInGame();
    expect(h.tracker.deaths).toBe(0);

    h.gameState.setDead(true);
    await jest.advanceTimersByTimeAsync(3000);
    await settle();
    expect(h.tracker.deaths).toBe(1);
    expect(h.tracker.getState()).toBe(TrackingState.DEAD);

    h.gameState.setDead(false);
    await jest.advanceTimersByTimeAsync(3000);
    await settle();
    expect(h.tracker.respawns).toBe(1);

    // Edge-triggered: a poll that repeats the same state is not another death.
    await jest.advanceTimersByTimeAsync(6000);
    await settle();
    expect(h.tracker.deaths).toBe(1);
    expect(h.tracker.respawns).toBe(1);
  });

  it('starts a fresh session for the next game without stacking the old one\'s loops', async () => {
    const h = await startInGame();
    const duringSession = jest.getTimerCount();

    h.gameState.gameEnded();
    await jest.advanceTimersByTimeAsync(3000);
    await settle();
    // Only the game-state poll survives a session; the volume tick and the
    // geometry poll are both cleared.
    expect(jest.getTimerCount()).toBe(1);
    expect(duringSession).toBe(3);

    h.gameState.state = { ...h.gameState.state, isInGame: true, gameFlowPhase: 'InProgress' };
    await jest.advanceTimersByTimeAsync(3000);
    await settle();
    expect(h.signaling.joinRoom).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(duringSession);
  });

  it('stops every loop it owns on stop()', async () => {
    const h = await startInGame();
    h.orchestrator.stop();
    await settle();
    expect(jest.getTimerCount()).toBe(0);
    expect(h.audio.cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('the volume tick', () => {
  it('reaches the server once tracking is locked and the position is fresh', async () => {
    const h = await startInGame();
    h.tracker.moveTo(7000, 7000);
    await jest.advanceTimersByTimeAsync(300);
    await settle();
    expect(h.volumeCalls).toBeGreaterThan(0);
  });

  it('stops reporting while the tracker has been holding for more than 2s', async () => {
    const h = await startInGame();
    h.tracker.moveTo(7000, 7000);
    await jest.advanceTimersByTimeAsync(300);
    await settle();
    const beforeHold = h.volumeCalls;

    h.tracker.holdSec = 5;
    await jest.advanceTimersByTimeAsync(500);
    await settle();
    expect(h.volumeCalls).toBe(beforeHold);
  });

  // How long we keep vouching for a held position depends on why the tracker
  // lost us. These came out of a real two-client session: in forty seconds the
  // tracker blinked four times, every one of them "no own-team icons on the
  // minimap at all", every one recovered within five seconds — and every one
  // cut the other player's audio dead for 1-4s because the disown fired at 2s
  // and the server then had nothing to score against.
  describe('how fast we disown a held position', () => {
    const coordsCalls = (h: Harness) =>
      (h.signaling as unknown as { sendCoords: jest.Mock }).sendCoords.mock.calls;
    const staleCalls = (h: Harness) => coordsCalls(h).filter(c => c[2] === true);

    async function heldFor(seconds: number, reason: 'no-blobs' | 'no-match') {
      const h = await startInGame();
      h.tracker.moveTo(7000, 7000);
      await jest.advanceTimersByTimeAsync(300);
      await settle();
      const reported = h.volumeCalls;
      (h.signaling as unknown as { sendCoords: jest.Mock }).sendCoords.mockClear();

      h.tracker.holdReason = reason;
      h.tracker.holdSec = seconds;
      await jest.advanceTimersByTimeAsync(500);
      await settle();
      return { h, reported };
    }

    it('keeps reporting through a 3s hold with no icons on the minimap', async () => {
      // A real game always draws four allies, so "none at all" is the capture
      // failing, not us moving. The last position is still very likely right.
      const { h, reported } = await heldFor(3, 'no-blobs');
      expect(h.volumeCalls).toBeGreaterThan(reported);
      expect(staleCalls(h)).toHaveLength(0);
    });

    it('gives up on a no-icon hold once it passes the tracker\'s own limit', async () => {
      const { h, reported } = await heldFor(6, 'no-blobs');
      expect(h.volumeCalls).toBe(reported);
      expect(staleCalls(h)).toHaveLength(1);
    });

    it('disowns a 3s hold where icons were there and none was us', async () => {
      // This one IS a movement signal — a recall is the case that matters.
      const { h, reported } = await heldFor(3, 'no-match');
      expect(h.volumeCalls).toBe(reported);
      expect(staleCalls(h)).toHaveLength(1);
    });

    it('disowns once per episode, and vouches again after recovery', async () => {
      const { h } = await heldFor(3, 'no-match');
      await jest.advanceTimersByTimeAsync(1000);
      await settle();
      expect(staleCalls(h)).toHaveLength(1);

      h.tracker.holdSec = 0;
      await jest.advanceTimersByTimeAsync(300);
      await settle();
      const fresh = coordsCalls(h).filter(c => c[2] !== true);
      expect(fresh.length).toBeGreaterThan(0);

      h.tracker.holdSec = 3;
      await jest.advanceTimersByTimeAsync(300);
      await settle();
      expect(staleCalls(h)).toHaveLength(2);
    });

    it('disowns when the tracker gives up and falls back to SCANNING', async () => {
      // Forced re-acquisition is the tracker saying it no longer believes its
      // own extrapolation. Without this the server went on serving that
      // position for another STALE_POSITION_MS after it had been written off.
      const h = await startInGame();
      h.tracker.moveTo(7000, 7000);
      await jest.advanceTimersByTimeAsync(300);
      await settle();
      (h.signaling as unknown as { sendCoords: jest.Mock }).sendCoords.mockClear();

      h.tracker.state = TrackingState.SCANNING;
      await jest.advanceTimersByTimeAsync(500);
      await settle();
      expect(staleCalls(h)).toHaveLength(1);
    });
  });

  it('keeps applying volumes while holding, so peers do not stay frozen', async () => {
    // Not reporting our position is right; not touching the volume pipeline at
    // all is not. This path used to return before applyPeerVolumes, which left
    // every peer at the gain they happened to have when the tracker lost us —
    // so after a recall a player went on hearing everyone audible from the lane
    // they had just left, for as long as the tracker stayed lost.
    const h = await startInGame();
    (h.orchestrator as any).peerStates = new Map([
      ['Ally',  { summonerName: 'Ally',  championName: 'Lux',  team: 'ORDER', isMuted: false, isDead: false }],
      ['Enemy', { summonerName: 'Enemy', championName: 'Zed',  team: 'CHAOS', isMuted: false, isDead: false }],
    ]);
    h.tracker.moveTo(7000, 7000);
    await jest.advanceTimersByTimeAsync(300);
    await settle();

    h.audio.applyPeerVolumes.mockClear();
    h.tracker.holdSec = 5;
    await jest.advanceTimersByTimeAsync(500);
    await settle();

    expect(h.audio.applyPeerVolumes).toHaveBeenCalled();
    const calls = h.audio.applyPeerVolumes.mock.calls;
    const applied = calls[calls.length - 1][0];
    // Teammates need no coordinates to be scored, so they stay audible.
    expect(applied.Ally).toBe(1.0);
    // The enemy is scored by distance, and we have no position to measure from,
    // so they are omitted — which fades them rather than holding them.
    expect(applied.Enemy).toBeUndefined();
  });
});

describe('the audio level monitor', () => {
  // Before v0.5.8 nothing cleared it, so every game left another 2s logging
  // loop running against a closed AudioContext for the life of the process.
  it('leaves nothing running across two sessions', async () => {
    const peerFactory = async (remoteName: string) =>
      new FakePeerConnection('me', remoteName) as unknown as PeerConnection;
    const signaling = { sendSignal: jest.fn() } as unknown as SignalingService;

    const first = new AudioService(signaling, 'me', peerFactory);
    await first.initMicrophone();
    const withOneSession = jest.getTimerCount();
    // Two per session: the 2s level monitor and the 20Hz volume glide. The
    // number matters far less than the two assertions below — that cleanup
    // returns to zero, and that a second session does not accumulate.
    expect(withOneSession).toBe(2);

    first.cleanup();
    expect(jest.getTimerCount()).toBe(0);

    const second = new AudioService(signaling, 'me', peerFactory);
    await second.initMicrophone();
    expect(jest.getTimerCount()).toBe(withOneSession);
    second.cleanup();
  });
});
