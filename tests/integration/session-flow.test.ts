import { GameStateService, GameSession } from '../../src/services/game-state';
import { Orchestrator } from '../../src/services/orchestrator';
import { generateRoomId } from '../../src/core/room';
import { readIdentity } from '../../src/core/identity';
import { isStreamerMode } from '../../src/core/streamer-detect';
import { Player } from '../../src/core/types';

function identityOf(raw: Parameters<typeof readIdentity>[0]) {
  const identity = readIdentity(raw);
  if (!identity) throw new Error('expected a readable identity');
  return identity;
}

// A roster spelled the way a patch that splits the Riot ID spells it, with one
// genuinely obscured entry (no tag line) and one player who is legitimately
// named after their champion (tag line present).
const rosterPlayers: Player[] = [
  { summonerName: 'Player1', championName: 'Ahri', team: 'ORDER', isDead: false, respawnTimer: 0, riotIdGameName: 'Player1', riotIdTagLine: 'EUW' },
  { summonerName: 'Player2', championName: 'Zed', team: 'CHAOS', isDead: false, respawnTimer: 0, riotIdGameName: 'Player2', riotIdTagLine: 'EUW' },
  { summonerName: 'Jinx', championName: 'Jinx', team: 'CHAOS', isDead: false, respawnTimer: 0, riotIdGameName: 'Jinx' },
  { summonerName: 'Lux', championName: 'Lux', team: 'ORDER', isDead: false, respawnTimer: 0, riotIdGameName: 'Lux', riotIdTagLine: 'NA1' },
];

const CLASSIC = { gameMode: 'CLASSIC', mapNumber: 11 };

describe('Session flow integration', () => {
  it('creates a session when activePlayer and allPlayers spell names differently', () => {
    const gs = new GameStateService();
    // activePlayer carries the full Riot ID; the roster carries bare names.
    const result = gs.createSession(rosterPlayers, identityOf({ riotId: 'Player1#EUW' }), CLASSIC);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.session.localPlayer.summonerName).toBe('Player1');
    expect(result.session.hasTagLines).toBe(true);
    expect(result.session.mapType).toBe('summoners_rift');
  });

  it('excludes only the genuinely obscured player at the live call sites', () => {
    const gs = new GameStateService();
    const result = gs.createSession(rosterPlayers, identityOf({ riotId: 'Player1#EUW' }), CLASSIC);
    if (!result.ok) throw new Error('unreachable');
    const { hasTagLines } = result.session;

    const excluded = rosterPlayers.filter((p) => isStreamerMode(p, hasTagLines));
    expect(excluded.map((p) => p.summonerName)).toEqual(['Jinx']);
    // "Lux" playing Lux with a tag line is a real account, not streamer mode —
    // before v0.5.9 they were dropped from voice with no log line.
    expect(isStreamerMode(rosterPlayers[3], hasTagLines)).toBe(false);
  });

  it('refuses the session when the local player is obscured', () => {
    const gs = new GameStateService();
    const result = gs.createSession(rosterPlayers, identityOf({ summonerName: 'Jinx' }), CLASSIC);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('streamer-mode');
  });

  it('generates same room ID for all players in the same game', () => {
    const names = rosterPlayers.map((p) => p.summonerName);
    expect(generateRoomId(names)).toBe(generateRoomId([...names].reverse()));
  });

  it('derives the room ID from the whole roster, so exclusions cannot split it', () => {
    const gs = new GameStateService();
    const asPlayer1 = gs.createSession(rosterPlayers, identityOf({ riotId: 'Player1#EUW' }), CLASSIC);
    const asLux = new GameStateService()
      .createSession(rosterPlayers, identityOf({ riotId: 'Lux#NA1' }), CLASSIC);
    if (!asPlayer1.ok || !asLux.ok) throw new Error('unreachable');
    expect(asPlayer1.session.roomId).toBe(asLux.session.roomId);
  });

  // Proximity math (distance/volume/range) is server-authoritative — the
  // client just submits encrypted positions to /compute-volumes and applies
  // whatever volumes come back. Tests for that math live in
  // server/tests/volumes.test.ts.
});

describe('Orchestrator live client data', () => {
  let originalWindow: unknown;

  beforeEach(() => {
    originalWindow = (globalThis as any).window;
    (globalThis as any).window = {
      setInterval: () => 1,
      clearInterval: () => { /* no timers in these tests */ },
      dispatchEvent: () => true,
    };
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
  });

  /** What pollGameState would have left behind while a game is in progress. */
  function inGame(orchestrator: Orchestrator): Orchestrator {
    (orchestrator as any).lastGameState = {
      isLeagueRunning: true,
      isInGame: true,
      summonerName: null,
      isDead: false,
      gameFlowPhase: 'InProgress',
    };
    return orchestrator;
  }

  function lcd(activePlayer: unknown, gameData: unknown = CLASSIC) {
    return {
      activePlayer,
      allPlayers: rosterPlayers.map((p) => ({ ...p })),
      gameData,
    };
  }

  it('creates a session when activePlayer carries only the split Riot ID', () => {
    // The migration this cluster exists for: no riotId and no summonerName on
    // activePlayer. The old code collapsed those to '', the `&& localSummonerName`
    // gate short-circuited, createSession was never called, and the 3s poll
    // retried forever with no log line at all.
    const orchestrator = new Orchestrator();
    (orchestrator as any).processLiveClientData(
      lcd({ riotIdGameName: 'Player1', riotIdTagLine: 'EUW' }),
    );

    expect(orchestrator.getSessionPlayers()).toHaveLength(4);
    // The wire name keeps the tag even though the roster entry it matched does
    // not spell one, so the name stays globally unique.
    expect((orchestrator as any).localSummonerName).toBe('Player1#EUW');
    expect((orchestrator as any).lastSessionFailure).toBeNull();
  });

  it('reports an unreadable local identity instead of looping silently', () => {
    const orchestrator = inGame(new Orchestrator());
    (orchestrator as any).processLiveClientData(lcd({ puuid: 'abc', level: 30 }));

    expect(orchestrator.getSessionPlayers()).toHaveLength(0);
    expect((orchestrator as any).lastSessionFailure.reason).toBe('identity-unreadable');
    expect((orchestrator as any).computeLifecycleStatus())
      .toContain("Couldn't read your Riot ID");
  });

  it('reports an unmatched local identity', () => {
    const orchestrator = inGame(new Orchestrator());
    (orchestrator as any).processLiveClientData(lcd({ riotId: 'Stranger#EUW' }));

    expect((orchestrator as any).lastSessionFailure.reason).toBe('identity-unmatched');
    expect((orchestrator as any).computeLifecycleStatus())
      .toContain("Couldn't match your Riot ID");
  });

  it('logs a repeated refusal once rather than every 3s poll', () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => { /* quiet */ });
    try {
      const orchestrator = new Orchestrator();
      for (let i = 0; i < 5; i++) {
        (orchestrator as any).processLiveClientData(lcd({ riotId: 'Stranger#EUW' }));
      }
      const refusals = errors.mock.calls
        .filter((args) => String(args[0]).includes('Not joining proximity chat'));
      expect(refusals).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  it('clears the refusal once the game is over', async () => {
    // endSession() is gated on a session existing, so a refused attempt must be
    // cleared from pollGameState — otherwise the refusal text replaces the
    // lobby and champ-select phase text indefinitely.
    const orchestrator = inGame(new Orchestrator());
    (orchestrator as any).processLiveClientData(lcd({ riotId: 'Stranger#EUW' }));
    expect((orchestrator as any).lastSessionFailure).not.toBeNull();

    (orchestrator as any).gameState.pollGameState = async () => ({
      isLeagueRunning: true,
      isInGame: false,
      summonerName: null,
      isDead: false,
      gameFlowPhase: 'ChampSelect',
    });
    await (orchestrator as any).pollGameState();

    expect((orchestrator as any).lastSessionFailure).toBeNull();
    expect((orchestrator as any).computeLifecycleStatus()).toBe('In champion select');
  });

  it('keeps voice with flat volumes on an unsupported map', async () => {
    const gs = new GameStateService();
    const result = gs.createSession(
      rosterPlayers,
      identityOf({ riotId: 'Player1#EUW' }),
      { gameMode: 'CHERRY', mapNumber: 30 },
    );
    if (!result.ok) throw new Error('unreachable');
    const session: GameSession = result.session;
    expect(session.mapType).toBeNull();

    const applied: Record<string, number>[] = [];
    const orchestrator = inGame(new Orchestrator());
    (orchestrator as any).session = session;
    (orchestrator as any).audio = {
      applyPeerVolumes: (v: Record<string, number>) => applied.push(v),
      isSelfMuted: () => false,
      isPlayerMuted: () => false,
    };
    (orchestrator as any).peerStates = new Map([
      ['Player2', { summonerName: 'Player2', championName: 'Zed', team: 'CHAOS', isMuted: false, isDead: false }],
    ]);

    await (orchestrator as any).positionTickInner();

    // Everyone audible, and no coordinates were computed or sent.
    expect(applied).toEqual([{ Player2: 1.0 }]);
    expect((orchestrator as any).computeLifecycleStatus())
      .toBe(session.proximityDisabledReason);
  });

  it('skips an obscured peer and connects to a real one', async () => {
    // Driven through the real session construction so the roster lookup uses
    // the identities the orchestrator actually resolved.
    const orchestrator = inGame(new Orchestrator());
    (orchestrator as any).processLiveClientData(lcd({ riotId: 'Player1#EUW' }));
    // startSession fails at microphone init outside a WebView; let it settle
    // before standing in a fake audio service.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const connected: string[] = [];
    (orchestrator as any).audio = {
      hasPeer: () => false,
      connectToPeer: async (name: string) => { connected.push(name); },
    };

    const broadcast = (summonerName: string, championName: string) => ({
      summonerName, championName, team: 'CHAOS', isMuted: false, isDead: false,
    });

    await (orchestrator as any).handlePeerPosition(broadcast('Jinx', 'Jinx'));
    await (orchestrator as any).handlePeerPosition(broadcast('Player2', 'Zed'));

    expect(connected).toEqual(['Player2']);
    expect((orchestrator as any).peerStates.has('Jinx')).toBe(false);
  });
});
