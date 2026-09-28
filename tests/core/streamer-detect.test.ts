import { isStreamerMode, rosterHasTagLines } from '../../src/core/streamer-detect';
import { Player } from '../../src/core/types';

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    summonerName: 'TestPlayer',
    championName: 'Ahri',
    team: 'ORDER',
    isDead: false,
    respawnTimer: 0,
    ...overrides,
  };
}

describe('isStreamerMode with a roster that carries tag lines', () => {
  it('does not flag a player who genuinely picked their champion name', () => {
    // The only input shape whose verdict actually changed in v0.5.9: a real
    // account named "Ahri" used to be classified as streamer mode, which cost
    // them voice chat entirely with no log line. ("Ahri#EUW" as a bare
    // summonerName was already false under the old exact compare.)
    const player = makePlayer({ summonerName: 'Ahri', championName: 'Ahri', riotIdTagLine: 'EUW' });
    expect(isStreamerMode(player, true)).toBe(false);
  });

  it('still flags the obscured entry that has no tag line', () => {
    const player = makePlayer({ summonerName: 'Ahri', championName: 'Ahri' });
    expect(isStreamerMode(player, true)).toBe(true);
  });

  it('strips the tag before comparing when the split fields are absent', () => {
    const player = makePlayer({ summonerName: 'Ahri#EUW', championName: 'Ahri' });
    // Tag line is known from the name itself, so this is a real player.
    expect(isStreamerMode(player, true)).toBe(false);
  });

  it('compares riotIdGameName when the roster splits the Riot ID', () => {
    const obscured = makePlayer({
      summonerName: 'Ahri', championName: 'Ahri', riotIdGameName: 'Ahri',
    });
    expect(isStreamerMode(obscured, true)).toBe(true);
  });
});

describe('isStreamerMode with a roster that carries no tag lines', () => {
  // Legacy behaviour, preserved so an API shape we have not seen degrades to
  // the old heuristic rather than to "nobody is ever a streamer".
  it('should return true when summoner name matches champion name', () => {
    expect(isStreamerMode(makePlayer({ summonerName: 'Ahri', championName: 'Ahri' }), false))
      .toBe(true);
  });

  it('should return false when names differ', () => {
    expect(isStreamerMode(makePlayer({ summonerName: 'TestPlayer', championName: 'Ahri' }), false))
      .toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(isStreamerMode(makePlayer({ summonerName: 'AHRI', championName: 'ahri' }), false))
      .toBe(true);
  });

  it('should handle mixed case', () => {
    expect(isStreamerMode(makePlayer({ summonerName: 'AhRi', championName: 'aHrI' }), false))
      .toBe(true);
  });
});

describe('rosterHasTagLines', () => {
  it('is true when any entry carries a tag line', () => {
    expect(rosterHasTagLines([
      makePlayer({ summonerName: 'A' }),
      makePlayer({ summonerName: 'B', riotIdTagLine: 'EUW' }),
    ])).toBe(true);
  });

  it('is false for a roster with no tag-line information at all', () => {
    expect(rosterHasTagLines([makePlayer({ summonerName: 'A' })])).toBe(false);
    expect(rosterHasTagLines([makePlayer({ summonerName: 'A', riotIdTagLine: '  ' })])).toBe(false);
  });
});
