export interface Player {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  isDead: boolean;
  respawnTimer: number;
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

export type MapType = 'summoners_rift' | 'howling_abyss' | 'unknown';

export const MAP_DIMENSIONS: Record<MapType, { width: number; height: number }> = {
  summoners_rift: { width: 14870, height: 14980 },
  howling_abyss: { width: 12988, height: 12988 },
  unknown: { width: 14870, height: 14980 },
};
