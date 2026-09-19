import { MapType } from './types';

/** The fields of Live Client Data's `gameData` that say which map we are on. */
export interface GameDataShape {
  gameMode?: unknown;
  mapNumber?: unknown;
  mapName?: unknown;
}

export type MapDetection =
  | { supported: true; mapType: MapType; via: string }
  | { supported: false; detail: string };

/** Riot's map ids. Only these two have minimap geometry and CV templates here;
 *  everything else (Arena 30, Swarm 33, Nexus Blitz 21, …) is "not 11 or 12". */
const MAP_IDS: Record<number, MapType> = {
  11: 'summoners_rift',
  12: 'howling_abyss',
};

function readMapNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

function describe(gameData: GameDataShape): string {
  return 'mapNumber=' + JSON.stringify(gameData.mapNumber ?? null) +
    ' mapName=' + JSON.stringify(gameData.mapName ?? null) +
    ' gameMode=' + JSON.stringify(gameData.gameMode ?? null);
}

/** The pre-v0.5.9 heuristic, kept for payloads that carry no map field at all.
 *  It is wrong-by-luck rather than by design: URF, ARURF, One For All and
 *  Ultbook match none of these substrings and reach Summoner's Rift only via
 *  the trailing default, so the default has to stay. */
function fromGameMode(gameMode: string): { mapType: MapType; matched: boolean } {
  const mode = gameMode.toLowerCase();
  if (mode.includes('aram') || mode.includes('howling')) {
    return { mapType: 'howling_abyss', matched: true };
  }
  if (
    mode.includes('classic') || mode.includes('ranked') || mode.includes('normal') ||
    mode.includes('practice') || mode.includes('custom') || mode.includes('tutorial')
  ) {
    return { mapType: 'summoners_rift', matched: true };
  }
  return { mapType: 'summoners_rift', matched: false };
}

/**
 * Decide which map we are on, and refuse when it is one whose coordinates we
 * cannot compute.
 *
 * `mapNumber` is trusted whenever it is usable, because it classifies every
 * SR-based rotating mode correctly by construction and classifies Arena/Swarm
 * correctly as unsupported. A map field that is PRESENT but unusable (null, a
 * non-numeric string, a `mapName` that is not "Map<n>") is treated as absent
 * rather than as a refusal — it is an API shape we do not recognise, not a map
 * we know we cannot handle — and the reason is carried in `via` so the log
 * shows why the weaker signal was used.
 */
export function detectMap(gameData: GameDataShape | null | undefined): MapDetection {
  const data: GameDataShape = gameData && typeof gameData === 'object' ? gameData : {};
  const notes: string[] = [];

  if (data.mapNumber !== undefined) {
    const mapNumber = readMapNumber(data.mapNumber);
    if (mapNumber === null) {
      notes.push('mapNumber unusable');
    } else {
      const mapType = MAP_IDS[mapNumber];
      if (mapType) return { supported: true, mapType, via: 'mapNumber=' + mapNumber };
      return { supported: false, detail: describe(data) };
    }
  }

  if (typeof data.mapName === 'string' && data.mapName.trim() !== '') {
    const match = /^Map(\d+)$/.exec(data.mapName.trim());
    if (!match) {
      notes.push('mapName unusable');
    } else {
      const mapNumber = parseInt(match[1], 10);
      const mapType = MAP_IDS[mapNumber];
      if (mapType) return { supported: true, mapType, via: 'mapName=' + data.mapName.trim() };
      return { supported: false, detail: describe(data) };
    }
  }

  const gameMode = typeof data.gameMode === 'string' ? data.gameMode : '';
  const fallback = fromGameMode(gameMode);
  const via = 'gamemode-fallback' +
    (fallback.matched ? '' : ' (gameMode "' + gameMode + '" unrecognised, defaulting)') +
    (notes.length ? ' [' + notes.join(', ') + ']' : '');
  return { supported: true, mapType: fallback.mapType, via };
}
