export interface Player {
  /** The name this player is known by on the wire and in server room state. */
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  isDead: boolean;
  respawnTimer: number;
  // Present only on patches where Live Client Data splits the Riot ID. Kept
  // alongside summonerName because identity matching and the streamer-mode
  // heuristic both need to know whether a tag line exists.
  riotIdGameName?: string;
  riotIdTagLine?: string;
}

export interface Position {
  x: number;
  y: number;
}

export interface PeerState {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  isMuted: boolean;
  isDead: boolean;
}

export interface AudioSettings {
  inputMode: 'ptt' | 'always';
  inputVolume: number;       // 0.0 - 1.0
  pttKey: string;
  playerVolumes: Record<string, number>; // summonerName -> 0.0-1.0
}

// Only maps we can actually convert minimap pixels into game coordinates for.
// There is deliberately no 'unknown' member: it aliased to Summoner's Rift
// dimensions, so an unrecognised map produced confidently wrong coordinates.
// A session on a map we don't know keeps voice and turns proximity off
// instead — see src/core/map-detect.ts.
export type MapType = 'summoners_rift' | 'howling_abyss';

export const MAP_DIMENSIONS: Record<MapType, { width: number; height: number }> = {
  summoners_rift: { width: 14870, height: 14980 },
  howling_abyss: { width: 12988, height: 12988 },
};
