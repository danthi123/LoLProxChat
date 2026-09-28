import { invoke } from '@tauri-apps/api/core';
import { Player, MapType } from '../core/types';
import { isStreamerMode, rosterHasTagLines } from '../core/streamer-detect';
import { generateRoomId } from '../core/room';
import {
  Identity,
  matchLocal,
  presentIdentityFields,
  readIdentity,
} from '../core/identity';
import { GameDataShape, detectMap } from '../core/map-detect';

/** Shape returned by the Rust get_game_state command */
export interface TauriGameState {
  isLeagueRunning: boolean;
  isInGame: boolean;
  summonerName: string | null;
  isDead: boolean;
  gameFlowPhase: string;
}

/** Shape returned by the Rust get_live_client_data command */
export interface LiveClientData {
  activePlayer: any;
  allPlayers: any[];
  gameData: any;
}

export interface GameSession {
  roomId: string;
  localPlayer: Player;
  allPlayers: Player[];
  /** null on a map we have no coordinate conversion for — voice still runs,
   *  proximity does not. */
  mapType: MapType | null;
  gameMode: string;
  /** Whether this roster spells tag lines at all, for the streamer heuristic. */
  hasTagLines: boolean;
  /** Panel-facing reason proximity is off, or null when it is on. */
  proximityDisabledReason: string | null;
}

export type SessionFailureReason =
  | 'identity-unreadable'
  | 'identity-unmatched'
  | 'streamer-mode';

export type SessionResult =
  | { ok: true; session: GameSession }
  | { ok: false; reason: SessionFailureReason; detail: string };

export class GameStateService {
  private session: GameSession | null = null;

  parsePlayerList(liveClientData: any): Player[] {
    if (!liveClientData?.players) return [];
    return liveClientData.players.map((p: any) => {
      const player: Player = {
        summonerName: p.summonerName,
        championName: p.championName,
        team: p.team === 'ORDER' ? 'ORDER' : 'CHAOS',
        isDead: p.isDead ?? false,
        respawnTimer: p.respawnTimer ?? 0,
      };
      if (typeof p.riotIdGameName === 'string' && p.riotIdGameName.trim() !== '') {
        player.riotIdGameName = p.riotIdGameName;
      }
      if (typeof p.riotIdTagLine === 'string' && p.riotIdTagLine.trim() !== '') {
        player.riotIdTagLine = p.riotIdTagLine;
      }
      return player;
    });
  }

  createSession(
    allPlayers: Player[],
    local: Identity,
    gameData: GameDataShape | null | undefined,
  ): SessionResult {
    const hasTagLines = rosterHasTagLines(allPlayers);

    // Roster entries whose identity is unreadable stay in the roster (they are
    // still peers and still feed the room id) but cannot be matched against.
    const rosterIdentities: (Identity | null)[] = allPlayers.map((p) => readIdentity(p));
    const candidates: Identity[] = [];
    const candidateIndex: number[] = [];
    rosterIdentities.forEach((identity, i) => {
      if (!identity) return;
      candidates.push(identity);
      candidateIndex.push(i);
    });

    const match = matchLocal(candidates, local);
    if (!match) {
      const fields = allPlayers.length
        ? presentIdentityFields(allPlayers[0]).join(',') || 'none'
        : 'none';
      return {
        ok: false,
        reason: 'identity-unmatched',
        detail: 'local="' + local.display + '" key="' + local.key + '"' +
          ' roster=' + allPlayers.length + ' entries' +
          ' rosterKeys=[' + candidates.map((c) => c.key).join(', ') + ']' +
          ' rosterIdentityFields=' + fields,
      };
    }

    const localPlayer = allPlayers[candidateIndex[match.index]];

    if (isStreamerMode(localPlayer, hasTagLines)) {
      return {
        ok: false,
        reason: 'streamer-mode',
        detail: 'local player "' + localPlayer.summonerName + '" is displayed as their' +
          ' champion (' + localPlayer.championName + ') with no tag line' +
          ' (roster tag lines available: ' + hasTagLines + ')',
      };
    }

    const excluded = allPlayers.filter((p) => isStreamerMode(p, hasTagLines));
    if (excluded.length) {
      // Until v0.5.9 this exclusion was completely invisible; the next real-game
      // log is what tells us what streamer mode actually writes into these
      // fields.
      console.log('[LoLProxChat] Streamer-mode exclusions: ' +
        excluded.map((p) => p.summonerName).join(', ') +
        ' (roster tag lines available: ' + hasTagLines + ')');
    }

    const playerNames = allPlayers.map((p) => p.summonerName);
    const roomId = generateRoomId(playerNames);

    const gameMode = typeof gameData?.gameMode === 'string' ? gameData.gameMode : 'CLASSIC';
    const detection = detectMap(gameData);
    let mapType: MapType | null = null;
    let proximityDisabledReason: string | null = null;
    if (detection.supported) {
      mapType = detection.mapType;
      console.log('[LoLProxChat] Map: ' + detection.mapType + ' (via ' + detection.via + ')');
    } else {
      // Voice stays on and proximity goes off, rather than either refusing the
      // session or scaling coordinates with Summoner's Rift dimensions on a map
      // that is not Summoner's Rift.
      proximityDisabledReason = 'Proximity is off — ' + gameMode + ' is not a supported map';
      console.warn('[LoLProxChat] Unsupported map, proximity disabled (voice stays on): ' +
        detection.detail);
    }

    this.session = {
      roomId,
      localPlayer,
      allPlayers,
      mapType,
      gameMode,
      hasTagLines,
      proximityDisabledReason,
    };

    console.log('[LoLProxChat] Matched local player "' + localPlayer.summonerName +
      '" on ' + match.matchedOn);

    return { ok: true, session: this.session };
  }

  getSession(): GameSession | null {
    return this.session;
  }

  clearSession(): void {
    this.session = null;
  }

  /** Poll Tauri backend for basic game state (league running, in-game, summoner name) */
  async pollGameState(): Promise<TauriGameState> {
    return invoke<TauriGameState>('get_game_state');
  }

  /** Poll League Live Client Data API via Tauri backend */
  async pollLiveClientData(): Promise<LiveClientData | null> {
    try {
      return await invoke<LiveClientData>('get_live_client_data');
    } catch {
      return null;
    }
  }
}
