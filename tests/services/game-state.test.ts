import { GameStateService } from '../../src/services/game-state';
import { readIdentity, Identity } from '../../src/core/identity';
import { Player } from '../../src/core/types';

function local(raw: Parameters<typeof readIdentity>[0]): Identity {
  const identity = readIdentity(raw);
  if (!identity) throw new Error('expected a readable identity');
  return identity;
}

function makePlayer(overrides: Partial<Player> & { summonerName: string }): Player {
  return {
    championName: 'Lux',
    team: 'ORDER',
    isDead: false,
    respawnTimer: 0,
    ...overrides,
  };
}

const SR = { gameMode: 'CLASSIC', mapNumber: 11 };

describe('GameStateService.parsePlayerList', () => {
  it('copies the split Riot ID fields when they are present', () => {
    const [player] = new GameStateService().parsePlayerList({
      players: [{
        summonerName: 'Alice', championName: 'Lux', team: 'ORDER',
        riotIdGameName: 'Alice', riotIdTagLine: 'EUW',
      }],
    });
    expect(player).toMatchObject({ riotIdGameName: 'Alice', riotIdTagLine: 'EUW' });
  });

  it('leaves them off when they are empty or absent', () => {
    const [player] = new GameStateService().parsePlayerList({
      players: [{ summonerName: 'Alice', championName: 'Lux', riotIdTagLine: '' }],
    });
    expect(player.riotIdTagLine).toBeUndefined();
    expect(player.riotIdGameName).toBeUndefined();
  });
});

describe('GameStateService.createSession identity matching', () => {
  const roster = [
    makePlayer({ summonerName: 'Alice', championName: 'Lux' }),
    makePlayer({ summonerName: 'Bob', championName: 'Zed', team: 'CHAOS' }),
  ];

  it('matches a tagged local identity against an untagged roster', () => {
    // Before v0.5.9 this compared activePlayer.riotId to allPlayers[].summonerName
    // with ===, found nothing, and returned a bare null with no log at all.
    const result = new GameStateService().createSession(roster, local({ riotId: 'Alice#EUW' }), SR);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.session.localPlayer.summonerName).toBe('Alice');
  });

  it('matches when only the split Riot ID fields exist', () => {
    const result = new GameStateService().createSession(
      roster,
      local({ riotIdGameName: 'Alice', riotIdTagLine: 'EUW' }),
      SR,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses with a detail naming the local candidate and the roster', () => {
    const result = new GameStateService().createSession(
      roster,
      local({ riotId: 'Carol#EUW' }),
      SR,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('identity-unmatched');
    expect(result.detail).toContain('Carol#EUW');
    expect(result.detail).toContain('2 entries');
    expect(result.detail).toContain('alice');
  });

  it('refuses rather than binding the wrong player when tags disagree', () => {
    // A wrong bind sends the wrong team to the server, and same-team peers are
    // audible at any distance — a map-wide reveal, not a quality bug.
    const tagged = [
      makePlayer({ summonerName: 'Alice#NA1', championName: 'Lux' }),
      makePlayer({ summonerName: 'Bob#NA1', championName: 'Zed', team: 'CHAOS' }),
    ];
    const result = new GameStateService().createSession(tagged, local({ riotId: 'Alice#EUW' }), SR);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('identity-unmatched');
  });
});

describe('GameStateService.createSession streamer mode', () => {
  it('refuses when the local player is genuinely obscured', () => {
    const roster = [
      makePlayer({ summonerName: 'Ahri', championName: 'Ahri' }),
      makePlayer({ summonerName: 'Bob', championName: 'Zed', team: 'CHAOS' }),
    ];
    const result = new GameStateService().createSession(roster, local({ riotId: 'Ahri' }), SR);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('streamer-mode');
    expect(result.detail).toContain('Ahri');
  });

  it('keeps a player who is genuinely named after their champion', () => {
    const roster = [
      makePlayer({ summonerName: 'Ahri', championName: 'Ahri', riotIdTagLine: 'EUW' }),
      makePlayer({ summonerName: 'Bob', championName: 'Zed', team: 'CHAOS', riotIdTagLine: 'EUW' }),
    ];
    const result = new GameStateService().createSession(roster, local({ riotId: 'Ahri#EUW' }), SR);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.session.hasTagLines).toBe(true);
  });
});

describe('GameStateService.createSession map handling', () => {
  const roster = [
    makePlayer({ summonerName: 'Alice', championName: 'Lux' }),
    makePlayer({ summonerName: 'Bob', championName: 'Zed', team: 'CHAOS' }),
  ];
  const alice = local({ summonerName: 'Alice' });

  it('keeps voice and disables proximity on an unsupported map', () => {
    // Before v0.5.9 Arena produced a session with Summoner's Rift dimensions
    // and broadcast coordinates scaled against the wrong map.
    const result = new GameStateService().createSession(
      roster, alice, { gameMode: 'CHERRY', mapNumber: 30 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.session.mapType).toBeNull();
    expect(result.session.proximityDisabledReason).toContain('CHERRY');
    expect(result.session.roomId).toBeTruthy();
  });

  it('keeps proximity on for a rotating Summoner\'s Rift mode', () => {
    const result = new GameStateService().createSession(
      roster, alice, { gameMode: 'URF', mapNumber: 11 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.session.mapType).toBe('summoners_rift');
    expect(result.session.proximityDisabledReason).toBeNull();
  });

  it('reads ARAM from mapNumber 12', () => {
    const result = new GameStateService().createSession(
      roster, alice, { gameMode: 'ARAM', mapNumber: 12 },
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.session.mapType).toBe('howling_abyss');
  });

  it('falls back to the gameMode allowlist when gameData is missing', () => {
    const result = new GameStateService().createSession(roster, alice, null);
    if (!result.ok) throw new Error('unreachable');
    expect(result.session.mapType).toBe('summoners_rift');
    expect(result.session.gameMode).toBe('CLASSIC');
  });
});

describe('GameStateService room id', () => {
  it('is derived from every roster entry, streamers included', () => {
    // All clients must derive the same id, and only some of them classify a
    // given player as obscured — so exclusions must not touch the room id.
    const roster = [
      makePlayer({ summonerName: 'Ahri', championName: 'Ahri' }),
      makePlayer({ summonerName: 'Alice', championName: 'Lux' }),
    ];
    const withStreamer = new GameStateService()
      .createSession(roster, local({ summonerName: 'Alice' }), SR);
    const withoutStreamer = new GameStateService()
      .createSession([roster[1]], local({ summonerName: 'Alice' }), SR);
    if (!withStreamer.ok || !withoutStreamer.ok) throw new Error('unreachable');
    expect(withStreamer.session.roomId).not.toBe(withoutStreamer.session.roomId);
  });
});
