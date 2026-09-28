import {
  identityEquals,
  matchLocal,
  presentIdentityFields,
  readIdentity,
} from '../../src/core/identity';

function id(raw: Parameters<typeof readIdentity>[0]) {
  const identity = readIdentity(raw);
  if (!identity) throw new Error('expected a readable identity');
  return identity;
}

describe('readIdentity', () => {
  it('reads a bare summoner name', () => {
    expect(readIdentity({ summonerName: 'Alice' })).toEqual({
      key: 'alice', gameName: 'alice', tagLine: '', display: 'Alice',
    });
  });

  it('splits a tagged summoner name', () => {
    expect(readIdentity({ summonerName: 'Alice#EUW' })).toEqual({
      key: 'alice#euw', gameName: 'alice', tagLine: 'euw', display: 'Alice#EUW',
    });
  });

  it('splits riotId and keeps it as the display/wire name', () => {
    expect(readIdentity({ riotId: 'Alice#EUW', summonerName: 'Alice' })).toEqual({
      key: 'alice#euw', gameName: 'alice', tagLine: 'euw', display: 'Alice#EUW',
    });
  });

  it('reads the split riotIdGameName/riotIdTagLine pair', () => {
    // The API shape that has no riotId and no summonerName at all — the exact
    // migration that used to collapse to '' and stall the app silently.
    expect(readIdentity({ riotIdGameName: 'Alice', riotIdTagLine: 'EUW' })).toEqual({
      key: 'alice#euw', gameName: 'alice', tagLine: 'euw', display: 'Alice#EUW',
    });
  });

  it('prefers the split pair over a tag-less summonerName', () => {
    const identity = id({ summonerName: 'Alice', riotIdGameName: 'Alice', riotIdTagLine: 'EUW' });
    expect(identity.key).toBe('alice#euw');
    // display stays what League spelled, so the wire name does not change
    expect(identity.display).toBe('Alice');
  });

  it('picks up a tag line carried in a separate field', () => {
    expect(id({ summonerName: 'Alice', riotIdTagLine: 'NA1' }).key).toBe('alice#na1');
  });

  it('normalises whitespace and case for comparison only', () => {
    const identity = id({ summonerName: '  AlIcE#EuW  ' });
    expect(identity.key).toBe('alice#euw');
    expect(identity.display).toBe('AlIcE#EuW');
  });

  it('keeps spaces inside a game name', () => {
    expect(id({ riotId: 'Big Bad Wolf#EUW' }).gameName).toBe('big bad wolf');
  });

  it('splits on the last # only', () => {
    expect(id({ riotId: 'a#b#c' })).toMatchObject({ gameName: 'a#b', tagLine: 'c' });
  });

  it('returns null when no field carries a usable name', () => {
    expect(readIdentity({})).toBeNull();
    expect(readIdentity({ summonerName: '   ' })).toBeNull();
    expect(readIdentity({ summonerName: 42 })).toBeNull();
    expect(readIdentity(null)).toBeNull();
    expect(readIdentity({ riotId: '#EUW' })).toBeNull();
  });
});

describe('presentIdentityFields', () => {
  it('lists only the identity fields that carried a value', () => {
    expect(presentIdentityFields({ summonerName: 'A', riotId: '', riotIdTagLine: 'EUW' }))
      .toEqual(['summonerName', 'riotIdTagLine']);
    expect(presentIdentityFields(null)).toEqual([]);
  });
});

describe('matchLocal', () => {
  it('matches on the full Riot ID', () => {
    const roster = [id({ summonerName: 'Bob#EUW' }), id({ summonerName: 'Alice#EUW' })];
    expect(matchLocal(roster, id({ riotId: 'Alice#EUW' })))
      .toEqual({ index: 1, matchedOn: 'key' });
  });

  it('matches a tagged local identity against an untagged roster', () => {
    // The failure this cluster exists for: activePlayer carries the Riot ID,
    // allPlayers carries bare names. The old `p.summonerName === local` compare
    // missed, createSession returned null, and the app never started.
    const roster = [id({ summonerName: 'Bob' }), id({ summonerName: 'Alice' })];
    expect(matchLocal(roster, id({ riotId: 'Alice#EUW' })))
      .toEqual({ index: 1, matchedOn: 'gameName' });
  });

  it('matches an untagged local identity against a tagged roster', () => {
    const roster = [id({ summonerName: 'Bob#EUW' }), id({ summonerName: 'Alice#EUW' })];
    expect(matchLocal(roster, id({ summonerName: 'Alice' })))
      .toEqual({ index: 1, matchedOn: 'gameName' });
  });

  it('refuses a bare-name match when both sides carry tag lines', () => {
    // Tags on both sides and no tier-1 hit means the tags genuinely differ, so
    // a game-name match could only bind a DIFFERENT player — whose team we
    // would then send to the server, making every enemy audible map-wide.
    const roster = [id({ summonerName: 'Alice#NA1' })];
    expect(matchLocal(roster, id({ riotId: 'Alice#EUW' }))).toBeNull();
  });

  it('separates two players sharing a game name on different tags', () => {
    const roster = [id({ summonerName: 'Alice#EUW' }), id({ summonerName: 'Alice#NA1' })];
    expect(matchLocal(roster, id({ riotId: 'Alice#NA1' })))
      .toEqual({ index: 1, matchedOn: 'key' });
  });

  it('refuses rather than guessing when a game name is ambiguous', () => {
    const roster = [id({ summonerName: 'Alice#EUW' }), id({ summonerName: 'Alice#NA1' })];
    expect(matchLocal(roster, id({ summonerName: 'Alice' }))).toBeNull();
  });

  it('refuses when the local player is genuinely absent', () => {
    const roster = [id({ summonerName: 'Bob' }), id({ summonerName: 'Carol' })];
    expect(matchLocal(roster, id({ summonerName: 'Alice' }))).toBeNull();
  });

  it('has no sole-player fallback', () => {
    // Practice Tool with one roster entry that is not us still refuses: a wrong
    // bind poisons localPlayer.team and the champion template.
    const roster = [id({ summonerName: 'Bob#EUW' })];
    expect(matchLocal(roster, id({ riotId: 'Alice#EUW' }))).toBeNull();
  });
});

describe('identityEquals', () => {
  it('is true for the same full Riot ID', () => {
    expect(identityEquals(id({ summonerName: 'Alice#EUW' }), id({ riotId: 'alice#euw' })))
      .toBe(true);
  });

  it('is true when only one side knows the tag line', () => {
    expect(identityEquals(id({ summonerName: 'Alice' }), id({ riotId: 'Alice#EUW' })))
      .toBe(true);
  });

  it('is false when both sides know different tag lines', () => {
    expect(identityEquals(id({ summonerName: 'Alice#NA1' }), id({ riotId: 'Alice#EUW' })))
      .toBe(false);
  });
});
