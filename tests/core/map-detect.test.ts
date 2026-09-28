import { detectMap } from '../../src/core/map-detect';

describe('detectMap from mapNumber', () => {
  it('reads 11 as Summoner\'s Rift and 12 as Howling Abyss', () => {
    expect(detectMap({ mapNumber: 11, gameMode: 'CLASSIC' }))
      .toMatchObject({ supported: true, mapType: 'summoners_rift' });
    expect(detectMap({ mapNumber: 12, gameMode: 'ARAM' }))
      .toMatchObject({ supported: true, mapType: 'howling_abyss' });
  });

  it('accepts a numeric string, which League has also shipped', () => {
    expect(detectMap({ mapNumber: '11' }))
      .toMatchObject({ supported: true, mapType: 'summoners_rift' });
  });

  it('refuses Arena, Nexus Blitz and Swarm with the raw fields in the detail', () => {
    for (const mapNumber of [21, 30, 33]) {
      const result = detectMap({ mapNumber, gameMode: 'CHERRY' });
      expect(result.supported).toBe(false);
      if (result.supported) throw new Error('unreachable');
      expect(result.detail).toContain(String(mapNumber));
      expect(result.detail).toContain('CHERRY');
    }
  });

  it('keeps rotating SR modes on Summoner\'s Rift', () => {
    // URF/ARURF/One For All/Ultbook match none of the gameMode allowlist
    // substrings — before v0.5.9 they were correct only via the blanket
    // default, so a naive allowlist refusal would have broken live modes.
    for (const gameMode of ['URF', 'ARURF', 'ONEFORALL', 'ULTBOOK']) {
      expect(detectMap({ mapNumber: 11, gameMode }))
        .toMatchObject({ supported: true, mapType: 'summoners_rift' });
    }
  });
});

describe('detectMap from mapName', () => {
  it('reads Map11/Map12 when mapNumber is absent', () => {
    expect(detectMap({ mapName: 'Map11' }))
      .toMatchObject({ supported: true, mapType: 'summoners_rift' });
    expect(detectMap({ mapName: 'Map12' }))
      .toMatchObject({ supported: true, mapType: 'howling_abyss' });
  });

  it('refuses a known-unsupported map id spelled as a name', () => {
    expect(detectMap({ mapName: 'Map30', gameMode: 'CHERRY' }).supported).toBe(false);
  });
});

describe('detectMap when the map fields are unusable', () => {
  it('falls back rather than refusing when mapNumber is present but null', () => {
    // "Present and garbage" is an API shape we do not recognise, not a map we
    // know we cannot handle — refusing on it would take voice away from a
    // supported game.
    const result = detectMap({ mapNumber: null, gameMode: 'CLASSIC' });
    expect(result).toMatchObject({ supported: true, mapType: 'summoners_rift' });
    if (!result.supported) throw new Error('unreachable');
    expect(result.via).toContain('mapNumber unusable');
  });

  it('falls back when mapName is not the Map<n> shape', () => {
    const result = detectMap({ mapName: "Summoner's Rift", gameMode: 'ARAM' });
    expect(result).toMatchObject({ supported: true, mapType: 'howling_abyss' });
    if (!result.supported) throw new Error('unreachable');
    expect(result.via).toContain('mapName unusable');
  });

  it('falls back when mapNumber is a non-numeric string', () => {
    expect(detectMap({ mapNumber: 'eleven', gameMode: 'CLASSIC' }))
      .toMatchObject({ supported: true, mapType: 'summoners_rift' });
  });
});

describe('detectMap with no map information at all', () => {
  it('keeps the gameMode allowlist', () => {
    expect(detectMap({ gameMode: 'ARAM' }))
      .toMatchObject({ supported: true, mapType: 'howling_abyss' });
    expect(detectMap({ gameMode: 'CLASSIC' }))
      .toMatchObject({ supported: true, mapType: 'summoners_rift' });
  });

  it('defaults an empty payload to Summoner\'s Rift and says so', () => {
    const result = detectMap({});
    expect(result).toMatchObject({ supported: true, mapType: 'summoners_rift' });
    if (!result.supported) throw new Error('unreachable');
    expect(result.via).toContain('gamemode-fallback');
    expect(result.via).toContain('unrecognised');
  });

  it('tolerates a missing gameData object', () => {
    expect(detectMap(null)).toMatchObject({ supported: true, mapType: 'summoners_rift' });
  });

  it('does not refuse an unsupported mode on gameMode alone', () => {
    // CHERRY without any map field: we cannot tell an unsupported map from a
    // mode name we have not seen, so the old default stands.
    expect(detectMap({ gameMode: 'CHERRY' }).supported).toBe(true);
  });
});
