import { Player } from './types';
import { normalizeName, readIdentity } from './identity';

/**
 * League's streamer mode replaces the displayed name with the champion name.
 * A real Riot ID always carries a non-empty tag line, so when the roster tells
 * us about tag lines at all, a champion-name match with NO tag line is the
 * obscured case and a champion-name match WITH one is a player who genuinely
 * picked that name.
 *
 * `rosterHasTagLines` is decided once per roster rather than per player, so a
 * payload shape that carries no tag-line information anywhere degrades to the
 * old bare comparison instead of to "nobody is ever a streamer".
 *
 * The direction is deliberate: a missed streamer is in voice chat with people
 * who can already read their name on the scoreboard, while a false positive
 * costs a paying-attention user their voice chat entirely.
 */
export function isStreamerMode(player: Player, rosterHasTagLines: boolean): boolean {
  const identity = readIdentity(player);
  if (!identity) return false;
  if (identity.gameName !== normalizeName(player.championName)) return false;
  if (!rosterHasTagLines) return true;
  return identity.tagLine === '';
}

/** Whether this roster carries tag-line information at all — in a separate
 *  field or spelled into the name. */
export function rosterHasTagLines(players: Player[]): boolean {
  return players.some((p) => (readIdentity(p)?.tagLine ?? '') !== '');
}
