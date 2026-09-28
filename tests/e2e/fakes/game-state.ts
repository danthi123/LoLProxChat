// A GameStateService whose two Tauri-backed polls are scripted.
//
// Subclassed rather than reimplemented behind an interface: parsePlayerList,
// createSession and clearSession stay the REAL ones, so the room id each client
// derives, the identity match and the map detection are all production code.
// Only the two `invoke` calls are replaced — and they are replaced per client,
// which a single process-wide invoke mock could not do, since it cannot tell
// which of the two orchestrators is asking.

import { GameStateService, LiveClientData, TauriGameState } from '../../../src/services/game-state';
import { Player } from '../../../src/core/types';

export class ScriptedGameState extends GameStateService {
  state: TauriGameState;
  liveClientData: LiveClientData | null;

  constructor(localName: string, roster: Player[], gameData: unknown) {
    super();
    this.state = {
      isLeagueRunning: true,
      isInGame: true,
      summonerName: localName,
      isDead: false,
      gameFlowPhase: 'InProgress',
    };
    const local = roster.find((p) => p.summonerName === localName);
    if (!local) throw new Error('scripted roster has no entry for ' + localName);
    this.liveClientData = {
      activePlayer: {
        summonerName: local.summonerName,
        riotIdGameName: local.riotIdGameName,
        riotIdTagLine: local.riotIdTagLine,
      },
      allPlayers: roster,
      gameData,
    };
  }

  async pollGameState(): Promise<TauriGameState> {
    return { ...this.state };
  }

  async pollLiveClientData(): Promise<LiveClientData | null> {
    return this.liveClientData;
  }

  /** League still running, game over — the ordinary end of a match. */
  gameEnded(): void {
    this.state = { ...this.state, isInGame: false, gameFlowPhase: 'WaitingForStats' };
  }

  leagueClosed(): void {
    this.state = { ...this.state, isLeagueRunning: false, isInGame: false, gameFlowPhase: 'None' };
  }

  setDead(isDead: boolean): void {
    this.state = { ...this.state, isDead };
  }
}

/** Summoner's Rift, which is what makes createSession produce a mapType. */
export const SUMMONERS_RIFT_GAME_DATA = { gameMode: 'CLASSIC', mapNumber: 11, mapName: 'Map11' };

export function player(
  gameName: string,
  tagLine: string,
  championName: string,
  team: 'ORDER' | 'CHAOS',
): Player {
  return {
    summonerName: gameName + '#' + tagLine,
    riotIdGameName: gameName,
    riotIdTagLine: tagLine,
    championName,
    team,
    isDead: false,
    respawnTimer: 0,
  };
}
