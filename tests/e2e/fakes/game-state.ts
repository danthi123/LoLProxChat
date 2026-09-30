// A GameStateService whose two Tauri-backed polls are scripted.
//
// Subclassed rather than reimplemented behind an interface: parsePlayerList,
// createSession and clearSession stay the REAL ones, so the room id each client
// derives, the identity match and the map detection are all production code.
// Only the two `invoke` calls are replaced — and they are replaced per client,
// which a single process-wide invoke mock could not do, since it cannot tell
// which of the two orchestrators is asking.

import { GameStateService, LiveClientData, LivePlayerState, TauriGameState } from '../../../src/services/game-state';
import { Player } from '../../../src/core/types';

export class ScriptedGameState extends GameStateService {
  state: TauriGameState;
  liveClientData: LiveClientData | null;
  private readonly localName: string;

  constructor(localName: string, roster: Player[], gameData: unknown) {
    super();
    const local = roster.find((p) => p.summonerName === localName);
    if (!local) throw new Error('scripted roster has no entry for ' + localName);
    this.localName = localName;
    // Shaped like the real payload: the top-level isDead is always false (it
    // used to be read from activePlayer, which never carries it), and death
    // lives only on the roster entries. A fake that set the top-level flag is
    // how the app went for its whole life without ever detecting a death.
    this.state = {
      isLeagueRunning: true,
      isInGame: true,
      summonerName: localName,
      isDead: false,
      gameFlowPhase: 'InProgress',
      players: roster.map((p) => ({
        summonerName: p.summonerName,
        riotIdGameName: p.riotIdGameName,
        riotIdTagLine: p.riotIdTagLine,
        isDead: false,
        respawnTimer: 0,
      })),
    };
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

  async pollLivePlayers(): Promise<LivePlayerState[]> {
    return (this.state.players ?? []).map((p) => ({ ...p }));
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

  /** Kill or revive the local player, the way League reports it. */
  setDead(isDead: boolean, respawnTimer = 0): void {
    this.state = {
      ...this.state,
      players: (this.state.players ?? []).map((p) =>
        p.summonerName === this.localName ? { ...p, isDead, respawnTimer: isDead ? respawnTimer : 0 } : p),
    };
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
