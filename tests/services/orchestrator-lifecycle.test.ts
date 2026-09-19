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
    expect(withOneSession).toBe(1);

    first.cleanup();
    expect(jest.getTimerCount()).toBe(0);

    const second = new AudioService(signaling, 'me', peerFactory);
    await second.initMicrophone();
    expect(jest.getTimerCount()).toBe(withOneSession);
    second.cleanup();
  });
});
