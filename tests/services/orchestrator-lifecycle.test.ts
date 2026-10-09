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
import {
  Orchestrator, OrchestratorDeps, defaultDeps, STATUS_MIC_BLOCKED, SHARED_RESET_RECEIVE_MS,
} from '../../src/services/orchestrator';
import { setAllyProximity, setSharedReset } from '../../src/services/audio-prefs';
import { AudioService } from '../../src/services/audio';
import { GameStateService } from '../../src/services/game-state';
import { SignalingService } from '../../src/services/signaling';
import { TrackingService, TrackingState } from '../../src/services/tracking';
import { VolumeClient } from '../../src/services/volume-client';
import { PeerConnection } from '../../src/services/peer-connection';
import { Player } from '../../src/core/types';
import { installDomShims, clearStoredPrefs } from '../e2e/setup/dom';
import { setLoggingEnabled } from '../../src/core/logging';
import { installWebAudioFakes } from '../e2e/fakes/webaudio';
import { FakePeerConnection } from '../e2e/fakes/peer';
import { ScriptedGameState, player } from '../e2e/fakes/game-state';
import { ScriptedTracker } from '../e2e/fakes/tracker';
import { SkinAwareScorer, TeammateSkin, TemplateSet } from '../../src/services/skin-matcher';
import type { BlobScorer } from '../../src/services/champion-classifier';

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

function makeHarness(
  audioOverrides: Record<string, unknown> = {},
  roster: Player[] = ROSTER,
  extraDeps: Partial<OrchestratorDeps> = {},
): Harness {
  const gameState = new ScriptedGameState(roster[0].summonerName, roster, { gameMode: 'CLASSIC', mapNumber: 11 });
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
    ...audioOverrides,
  };
  const signaling = {
    joinRoom: jest.fn(),
    leaveRoom: jest.fn(),
    broadcastPosition: jest.fn(),
    sendCoords: jest.fn(),
    sendSignal: jest.fn(),
    setSharedReset: jest.fn(),
    setOnRemoteReset: jest.fn(),
    requestResetAll: jest.fn(() => true),
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
    ...extraDeps,
  };
  harness.orchestrator = new Orchestrator(deps);
  return harness;
}

/** Start the orchestrator and run one game-state poll to completion. */
async function startInGame(audioOverrides: Record<string, unknown> = {}): Promise<Harness> {
  const harness = makeHarness(audioOverrides);
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

describe('the Debug game bundle', () => {
  afterEach(() => setLoggingEnabled(false));

  it('opens one zip per game, named after the lobby, and closes it when the game ends', async () => {
    setLoggingEnabled(true);
    const h = await startInGame();
    const roomId = (h.orchestrator as unknown as { session: { roomId: string } }).session.roomId;
    const starts = invokeMock.mock.calls.filter((c) => c[0] === 'bundle_start');
    expect(starts).toHaveLength(1);
    expect(starts[0][1].name.startsWith(roomId + '_')).toBe(true);

    h.gameState.state = { ...h.gameState.state, isInGame: false, gameFlowPhase: 'EndOfGame' };
    await jest.advanceTimersByTimeAsync(3000);
    await settle();
    const order = invokeMock.mock.calls.map((c) => c[0]).filter((c) => c.startsWith('bundle_'));
    expect(order).toEqual(['bundle_start', 'bundle_finish']);
  });

  it('starts when Debug is switched on mid-game (it always starts off at launch)', async () => {
    const h = await startInGame();
    expect(invokeMock.mock.calls.some((c) => c[0] === 'bundle_start')).toBe(false);
    setLoggingEnabled(true);
    await jest.advanceTimersByTimeAsync(3000);
    await settle();
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'bundle_start')).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(9000);
    await settle();
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'bundle_start')).toHaveLength(1);
    void h;
  });

  it('stays out of the way with Debug off', async () => {
    await startInGame();
    expect(invokeMock.mock.calls.some((c) => String(c[0]).startsWith('bundle_'))).toBe(false);
  });
});

describe('panel settings across sessions', () => {
  it('a setting chosen before the game reaches its audio (Push to Talk was ignored)', async () => {
    const updateSettings = jest.fn();
    const h = makeHarness({ updateSettings });
    h.orchestrator.updateSettings({ inputMode: 'ptt' });
    h.orchestrator.updateSettings({ inputVolume: 0.5 });
    h.orchestrator.start();
    await settle();
    expect(updateSettings).toHaveBeenCalledWith({ inputMode: 'ptt', inputVolume: 0.5 });
  });

  // The panel writes these straight to storage, so without this a toggle
  // mid-game left no trace and the session-start line was all the log had.
  it('logs a mid-game change to a toggle that changes what we hear, once', async () => {
    try {
      const h = await startInGame();
      h.tracker.moveTo(7000, 7000);
      await jest.advanceTimersByTimeAsync(300);
      const changed = () => (console.log as jest.Mock).mock.calls
        .map(c => c.join(' ')).filter(l => l.includes('Settings changed'));
      expect(changed()).toEqual([]);

      setAllyProximity(false);
      await jest.advanceTimersByTimeAsync(500);
      expect(changed()).toEqual([
        '[LoLProxChat] Settings changed: allyProximity=false voiceOnCamera=true sharedReset=false' +
          ' (was allyProximity=true voiceOnCamera=true sharedReset=false)',
      ]);
    } finally {
      clearStoredPrefs();
    }
  });
});

describe('a blocked microphone', () => {
  // 2026-10-07: XadowAsol's mic was refused at every session start, which
  // aborted the session — he heard no one, and the panel did not say why.
  function blockedMic() {
    let error: string | null = 'NotAllowedError: Permission denied';
    return {
      getMicError: jest.fn(() => error),
      applyInputDevice: jest.fn(async () => { error = null; }),
    };
  }
  const status = (h: Harness) =>
    (h.orchestrator as unknown as { computeLifecycleStatus(): string }).computeLifecycleStatus();

  it('keeps the session, listening only, and says so on the panel', async () => {
    const h = await startInGame(blockedMic());
    expect(h.signaling.joinRoom).toHaveBeenCalledTimes(1);
    expect(h.tracker.started).toBe(true);
    expect(status(h)).toBe(STATUS_MIC_BLOCKED);
  });

  it('retries the microphone every 10 s until it opens', async () => {
    const mic = blockedMic();
    const h = await startInGame(mic);
    await jest.advanceTimersByTimeAsync(9000);
    expect(mic.applyInputDevice).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(3000);
    await settle();
    expect(mic.applyInputDevice).toHaveBeenCalledTimes(1);
    expect(status(h)).not.toBe(STATUS_MIC_BLOCKED);
    await jest.advanceTimersByTimeAsync(30000);
    expect(mic.applyInputDevice).toHaveBeenCalledTimes(1);
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

  it('respawns on League\'s own timer, not on the next poll', async () => {
    const h = await startInGame();
    // Die with 4.5s on the clock at t=0.2s; League counts it down live, so the
    // fake is re-read every 100ms with the time actually left.
    const respawnAt = 4700;
    let t = 200;
    await jest.advanceTimersByTimeAsync(200);
    const step = async (ms: number) => {
      for (let i = 0; i < ms; i += 100) {
        const left = Math.max(0, (respawnAt - t) / 1000);
        h.gameState.setDead(left > 0, left);
        await jest.advanceTimersByTimeAsync(100);
        t += 100;
      }
      await settle();
    };

    await step(1500);
    // The 1s death poll saw it, well before the 3s game-state poll would have.
    expect(h.tracker.deaths).toBe(1);

    // Respawn lands on the timer (4.7s), not on whichever poll next reads alive.
    // Hold League's roster at "dead, 0.3s left" past the respawn: a poll a
    // moment behind League is not a new death.
    await step(3000);
    h.gameState.setDead(true, 0.3);
    // Spans the 5s death poll, which reads that stale roster.
    await jest.advanceTimersByTimeAsync(400);
    await settle();
    expect(h.tracker.respawns).toBe(1);
    expect(h.tracker.deaths).toBe(1);

    h.gameState.setDead(false);
    await jest.advanceTimersByTimeAsync(3000);
    await settle();
    expect(h.tracker.respawns).toBe(1);
    expect(h.tracker.deaths).toBe(1);
  });

  it('does not let a late game-state reply from before the death respawn us', async () => {
    // Review: the 3s poll's snapshot can be taken just before the death and
    // land after the 1s poll has already acted on it.
    const h = await startInGame();
    h.tracker.moveTo(7000, 7000);
    const real = h.gameState.pollGameState.bind(h.gameState);
    h.gameState.pollGameState = async () => {
      const before = await real();
      h.gameState.setDead(true, 20);
      await new Promise((r) => setTimeout(r, 300));
      return before;
    };
    await jest.advanceTimersByTimeAsync(4000);
    await settle();
    expect(h.tracker.deaths).toBe(1);
    expect(h.tracker.respawns).toBe(0);
  });

  it('keeps the scheduled respawn when League reads 0s while still dead', async () => {
    const h = await startInGame();
    h.gameState.setDead(true, 2);
    await jest.advanceTimersByTimeAsync(1000);
    await settle();
    expect(h.tracker.deaths).toBe(1);
    h.gameState.setDead(true, 0);
    await jest.advanceTimersByTimeAsync(2500);
    await settle();
    expect(h.tracker.respawns).toBe(1);
  });

  it('enters the dead state when the session starts mid-death', async () => {
    const h = makeHarness();
    h.gameState.setDead(true, 10);
    // parsePlayerList seeds the roster's isDead into the session's local player.
    h.gameState.liveClientData!.allPlayers = h.gameState.liveClientData!.allPlayers
      .map((p, i) => (i === 0 ? { ...p, isDead: true, respawnTimer: 10 } : p));
    h.orchestrator.start();
    await settle();
    await jest.advanceTimersByTimeAsync(1000);
    await settle();
    expect(h.tracker.deaths).toBe(1);
  });

  it('keeps a dead player at their body, re-owning a position the lost icon had disowned', async () => {
    // The icon vanishes at death before any poll can say why: the tracker
    // holds, and past 2s the position is disowned. The death then puts the
    // body back, owned, for the whole timer.
    const h = await startInGame();
    h.tracker.moveTo(7000, 7000);
    await jest.advanceTimersByTimeAsync(300);
    h.tracker.holdSec = 2.5;
    await jest.advanceTimersByTimeAsync(300);
    const sendCoords = (h.signaling as any).sendCoords as jest.Mock;
    expect(sendCoords.mock.calls.some(c => c[2] === true)).toBe(true);

    sendCoords.mockClear();
    h.gameState.setDead(true, 20);
    await jest.advanceTimersByTimeAsync(1000);
    await settle();
    await jest.advanceTimersByTimeAsync(5000);
    const calls = sendCoords.mock.calls;
    expect(calls.length).toBeGreaterThan(20);
    for (const c of calls.slice(-20)) {
      expect(c[0]).toBe(7000);
      expect(c[1]).toBe(7000);
      expect(c[2]).toBe(false);
    }
  });

  it('a user position reset rescans and stops vouching for the old spot at once', async () => {
    const h = await startInGame();
    h.tracker.moveTo(7000, 7000);
    await jest.advanceTimersByTimeAsync(300);
    const sendCoords = (h.signaling as any).sendCoords as jest.Mock;
    expect(sendCoords.mock.calls.some(c => c[2] === true)).toBe(false);

    h.orchestrator.resetPosition();
    await jest.advanceTimersByTimeAsync(300);
    expect(h.tracker.resets).toBe(1);
    expect(h.tracker.getState()).toBe(TrackingState.SCANNING);
    expect(sendCoords.mock.calls.some(c => c[2] === true)).toBe(true);
  });

  it('a user position reset is ignored while dead — we stay at the body', async () => {
    const h = await startInGame();
    h.tracker.moveTo(7000, 7000);
    await jest.advanceTimersByTimeAsync(300);
    h.gameState.setDead(true, 20);
    await jest.advanceTimersByTimeAsync(1000);
    await settle();
    expect(h.tracker.deaths).toBe(1);

    const sendCoords = (h.signaling as any).sendCoords as jest.Mock;
    sendCoords.mockClear();
    h.orchestrator.resetPosition();
    await jest.advanceTimersByTimeAsync(1000);
    expect(h.tracker.resets).toBe(0);
    expect(h.tracker.getState()).toBe(TrackingState.DEAD);
    expect(sendCoords.mock.calls.length).toBeGreaterThan(0);
    for (const c of sendCoords.mock.calls) expect(c[2]).toBe(false);
  });

  describe('shared RESET', () => {
    afterEach(() => clearStoredPrefs());

    /** What the signaling layer hands on when another player's reset arrives. */
    const remoteReset = (h: Harness) =>
      (h.signaling as any).setOnRemoteReset.mock.calls[0][0] as (from: string) => void;
    const overlayStates = (): any[] => {
      const seen: any[] = [];
      window.addEventListener('overlayUpdate', ((e: CustomEvent) => { seen.push(e.detail); }) as EventListener);
      return seen;
    };

    it('declares the setting before joining, and passes on each change', async () => {
      setSharedReset(true);
      const h = await startInGame();
      const set = (h.signaling as any).setSharedReset as jest.Mock;
      expect(set.mock.invocationCallOrder[0]).toBeLessThan(h.signaling.joinRoom.mock.invocationCallOrder[0]);
      expect(set).toHaveBeenLastCalledWith(true);

      setSharedReset(false);
      await jest.advanceTimersByTimeAsync(300);
      expect(set).toHaveBeenLastCalledWith(false);
    });

    it('RESET asks the others to rescan only with the setting on', async () => {
      const h = await startInGame();
      const requestResetAll = (h.signaling as any).requestResetAll as jest.Mock;
      h.orchestrator.resetPosition();
      expect(requestResetAll).not.toHaveBeenCalled();

      setSharedReset(true);
      h.orchestrator.resetPosition();
      expect(requestResetAll).toHaveBeenCalledTimes(1);
      expect(h.tracker.resets).toBe(2);
    });

    it('another player\'s reset rescans without avoiding anything, at most once per window', async () => {
      setSharedReset(true);
      const h = await startInGame();
      h.tracker.moveTo(7000, 7000);
      await jest.advanceTimersByTimeAsync(300);

      remoteReset(h)('Bob');
      expect(h.tracker.rescans).toBe(1);
      expect(h.tracker.resets).toBe(0);
      expect(h.tracker.getState()).toBe(TrackingState.SCANNING);

      h.tracker.state = TrackingState.LOCKED;
      await jest.advanceTimersByTimeAsync(SHARED_RESET_RECEIVE_MS - 1000);
      remoteReset(h)('Bob');
      expect(h.tracker.rescans).toBe(1);

      await jest.advanceTimersByTimeAsync(1000);
      remoteReset(h)('Bob');
      expect(h.tracker.rescans).toBe(2);
    });

    it('a reset while the tracker is not on a clean lock is ignored, and does not use up the window', async () => {
      setSharedReset(true);
      const h = await startInGame();
      h.tracker.moveTo(7000, 7000);
      await jest.advanceTimersByTimeAsync(300);
      h.tracker.state = TrackingState.SCANNING;
      remoteReset(h)('Bob');
      expect(h.tracker.rescans).toBe(0);
      h.tracker.state = TrackingState.LOCKED;
      remoteReset(h)('Bob');
      expect(h.tracker.rescans).toBe(1);
    });

    it('a reset that arrives with the setting off does nothing', async () => {
      const h = await startInGame();
      h.tracker.moveTo(7000, 7000);
      await jest.advanceTimersByTimeAsync(300);
      remoteReset(h)('Bob');
      expect(h.tracker.rescans).toBe(0);
      expect(h.tracker.getState()).toBe(TrackingState.LOCKED);
    });

    it('a reset while dead leaves the body where it is, and does not use up the window', async () => {
      setSharedReset(true);
      const h = await startInGame();
      h.tracker.moveTo(7000, 7000);
      await jest.advanceTimersByTimeAsync(300);
      h.gameState.setDead(true, 5);
      await jest.advanceTimersByTimeAsync(1000);
      await settle();
      remoteReset(h)('Bob');
      expect(h.tracker.getState()).toBe(TrackingState.DEAD);

      h.tracker.onRespawn();
      h.tracker.state = TrackingState.LOCKED;
      remoteReset(h)('Bob');
      expect(h.tracker.rescans).toBe(1);
    });

    it('the panel names the sender only when they are a player in this room', async () => {
      setSharedReset(true);
      const h = await startInGame();
      const seen = overlayStates();
      remoteReset(h)('Not In This Game');
      expect(seen[seen.length - 1].remoteReset).toEqual({ from: null });

      const onPeerPosition = h.signaling.joinRoom.mock.calls[0][3];
      onPeerPosition({ summonerName: ROSTER[1].summonerName, championName: ROSTER[1].championName,
        team: ROSTER[1].team, isMuted: false, isDead: false });
      h.tracker.state = TrackingState.LOCKED;
      await jest.advanceTimersByTimeAsync(SHARED_RESET_RECEIVE_MS);
      remoteReset(h)(ROSTER[1].summonerName);
      expect(seen[seen.length - 1].remoteReset).toEqual({ from: ROSTER[1].summonerName });

      // Present in the room but not on this game's roster: not named.
      onPeerPosition({ summonerName: 'Stranger#XYZ', championName: 'Teemo', team: 'CHAOS', isMuted: false, isDead: false });
      h.tracker.state = TrackingState.LOCKED;
      await jest.advanceTimersByTimeAsync(SHARED_RESET_RECEIVE_MS);
      remoteReset(h)('Stranger#XYZ');
      expect(seen[seen.length - 1].remoteReset).toEqual({ from: null });

      await jest.advanceTimersByTimeAsync(5000);
      expect(seen[seen.length - 1].remoteReset).toBeNull();
    });
  });

  it('ignores the top-level isDead, which League never actually sends', async () => {
    // Before v0.5.10 death was read from activePlayer.isDead, which does not
    // exist, so no death was ever detected. Only the roster entry counts.
    const h = await startInGame();
    h.gameState.state = { ...h.gameState.state, isDead: true };
    await jest.advanceTimersByTimeAsync(3000);
    await settle();
    expect(h.tracker.deaths).toBe(0);
  });

  it('starts a fresh session for the next game without stacking the old one\'s loops', async () => {
    const h = await startInGame();
    const duringSession = jest.getTimerCount();

    h.gameState.gameEnded();
    await jest.advanceTimersByTimeAsync(3000);
    await settle();
    // Only the game-state poll survives a session; the volume tick, the
    // geometry poll and the death poll are all cleared.
    expect(jest.getTimerCount()).toBe(1);
    expect(duringSession).toBe(4);

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

describe('teammate skin icons', () => {
  // Three of us on ORDER, one enemy; League says which skin each has on
  // (as Live Client Data spells it: the fake serves the roster raw).
  const skin = (p: Player, skinID: number | undefined): Player => ({ ...p, skinID }) as unknown as Player;
  const TEAM: Player[] = [
    skin(player('PlayerOne', 'LIFE', 'Kayn', 'ORDER'), 15),
    skin(player('PlayerTwo', 'LIFE', 'Zed', 'CHAOS'), 1),
    skin(player('PlayerThree', 'LIFE', 'Briar', 'ORDER'), 0),
    skin(player('PlayerFour', 'LIFE', 'Gwen', 'ORDER'), 11),
  ];
  const model: BlobScorer = { isLoaded: () => true, scoreBlobsForLocalChampion: async (_f, b) => b.map(() => 0.1) };
  /** One template per teammate asked for: enough for setTemplates to accept. */
  const fakeSets = (team: TeammateSkin[]): TemplateSet[] => team.map(p => ({ id: p.id, vecs: [new Float32Array(4)] }));

  async function start(
    roster: Player[],
    classifier: BlobScorer | null,
  ): Promise<{ h: Harness; load: jest.Mock; signals: AbortSignal[] }> {
    const signals: AbortSignal[] = [];
    const load = jest.fn(async (team: TeammateSkin[], signal: AbortSignal) => { signals.push(signal); return fakeSets(team); });
    const h = makeHarness({}, roster, { createClassifier: async () => classifier, loadSkinTemplates: load });
    h.orchestrator.start();
    await settle();
    return { h, load, signals };
  }

  it('fetches every teammate\'s icons, us included, and no enemy\'s', async () => {
    const { h, load } = await start(TEAM, model);
    expect(load).toHaveBeenCalledTimes(1);
    const team = load.mock.calls[0][0] as TeammateSkin[];
    expect(team.map(p => [p.championName, p.skinId])).toEqual([['Kayn', 15], ['Briar', 0], ['Gwen', 11]]);
    // Told apart by roster position, not by summoner name (blank or repeated
    // in streamer mode) — so ids are distinct whatever the names are.
    expect(new Set(team.map(p => p.id)).size).toBe(3);
    const scorer = h.tracker.classifier as SkinAwareScorer;
    expect(scorer).toBeInstanceOf(SkinAwareScorer);
    expect(scorer.isMatching()).toBe(true);
  });

  it('ids stay distinct when summoner names are all the same', async () => {
    const same = TEAM.map(p => ({ ...p, summonerName: 'PlayerOne#LIFE' }));
    const { load } = await start(same, model);
    expect(load).toHaveBeenCalledTimes(1);
    const team = load.mock.calls[0][0] as TeammateSkin[];
    expect(team).toHaveLength(3);
    expect(new Set(team.map(p => p.id)).size).toBe(3);
  });

  it('fetches nothing when a teammate\'s skin is unknown', async () => {
    const roster = TEAM.map((p, i) => (i === 3 ? skin(p, undefined) : p));
    const { h, load } = await start(roster, model);
    expect(load).not.toHaveBeenCalled();
    // The classifier still goes in, matching nothing.
    expect((h.tracker.classifier as SkinAwareScorer).isMatching()).toBe(false);
  });

  it('puts nothing in front of the tracker without the classifier', async () => {
    const { h, load } = await start(TEAM, null);
    expect(load).toHaveBeenCalledTimes(1);
    expect(h.tracker.classifierSet).toBe(false);
  });

  it('starts no download for a game that ended while it was starting', async () => {
    const load = jest.fn(async (team: TeammateSkin[]) => fakeSets(team));
    const h = makeHarness({}, TEAM, { createClassifier: async () => model, loadSkinTemplates: load });
    let release: () => void = () => undefined;
    h.tracker.initCaptureBounds = () => new Promise<void>((resolve) => { release = resolve; });
    h.orchestrator.start();
    await settle();
    h.gameState.gameEnded();
    await jest.advanceTimersByTimeAsync(3000);
    await settle();
    release();
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(h.tracker.classifierSet).toBe(false);
  });

  it('cancels the download when the game ends', async () => {
    const { h, signals } = await start(TEAM, model);
    expect(signals[0].aborted).toBe(false);
    h.gameState.gameEnded();
    await jest.advanceTimersByTimeAsync(3000);
    await settle();
    expect(signals[0].aborted).toBe(true);
  });
});
