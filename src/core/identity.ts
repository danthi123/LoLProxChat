/**
 * Riot ID handling for the Live Client Data payload.
 *
 * League has moved the canonical spelling of a player's name more than once —
 * `summonerName` alone, `summonerName` carrying a "gamename#tag" Riot ID,
 * `riotId`, and the split `riotIdGameName` / `riotIdTagLine` pair. The local
 * player (`activePlayer`) and the roster (`allPlayers`) have not always agreed
 * on which of those they carry, and the old code compared one field of one
 * object to a different field of another with `===`. When those two spellings
 * drift apart the app silently never starts, so everything here is built to
 * either match or say loudly why it could not.
 */

export interface RawIdentity {
  summonerName?: unknown;
  riotId?: unknown;
  riotIdGameName?: unknown;
  riotIdTagLine?: unknown;
}

export interface Identity {
  /** Normalised "gamename#tag" when a tag is known, else the game name. */
  key: string;
  /** Normalised game name with any tag stripped. */
  gameName: string;
  /** Normalised tag line, or '' when unknown. */
  tagLine: string;
  /** Exactly as League spelled it — for logs and for the wire name. */
  display: string;
}

export interface LocalMatch {
  index: number;
  matchedOn: 'key' | 'gameName';
}

/**
 * Comparison-only normalisation. The `display` string is deliberately left
 * untouched: it is what goes on the wire as the peer name and what keys the
 * server's room membership, so it must stay byte-identical to what League gave
 * us.
 */
export function normalizeName(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Riot IDs are "gamename#tag"; neither half may contain '#', but splitting on
 *  the last one is the safe reading if that ever changes. */
function splitRiotId(value: string): { gameName: string; tagLine: string } {
  const hash = value.lastIndexOf('#');
  if (hash < 0) return { gameName: value, tagLine: '' };
  return {
    gameName: value.slice(0, hash).trim(),
    tagLine: value.slice(hash + 1).trim(),
  };
}

/**
 * Collapse whichever identity fields this patch of League happens to provide
 * into one comparable shape. Returns null when none of them carried a usable
 * name — the caller must treat that as a refusal, not as an empty string.
 */
export function readIdentity(raw: RawIdentity | null | undefined): Identity | null {
  if (!raw || typeof raw !== 'object') return null;

  const splitGameName = asTrimmedString(raw.riotIdGameName);
  const splitTagLine = asTrimmedString(raw.riotIdTagLine);
  const riotId = asTrimmedString(raw.riotId);
  const summonerName = asTrimmedString(raw.summonerName);

  let gameName: string;
  let tagLine: string;
  if (splitGameName) {
    gameName = splitGameName;
    tagLine = splitTagLine;
  } else if (riotId) {
    ({ gameName, tagLine } = splitRiotId(riotId));
  } else if (summonerName) {
    ({ gameName, tagLine } = splitRiotId(summonerName));
  } else {
    return null;
  }

  // A tag line carried in a separate field still counts when the name field we
  // used did not spell one out.
  if (!tagLine) tagLine = splitTagLine || splitRiotId(summonerName).tagLine;
  if (!gameName) return null;

  const normalizedGameName = normalizeName(gameName);
  const normalizedTagLine = normalizeName(tagLine);
  const display = riotId
    || summonerName
    || (tagLine ? gameName + '#' + tagLine : gameName);

  return {
    key: normalizedTagLine ? normalizedGameName + '#' + normalizedTagLine : normalizedGameName,
    gameName: normalizedGameName,
    tagLine: normalizedTagLine,
    display,
  };
}

/** Which identity fields a raw payload actually carried — for the refusal log,
 *  which is the only way to tell an API shape change from a genuine miss. */
export function presentIdentityFields(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const known = ['summonerName', 'riotId', 'riotIdGameName', 'riotIdTagLine'];
  return known.filter((k) => asTrimmedString((raw as Record<string, unknown>)[k]) !== '');
}

/**
 * Two identities are the same player when their full Riot IDs match, or when
 * their game names match and at least one side never told us a tag line. When
 * BOTH sides carry a tag and the tags differ, they are different players —
 * matching them on the bare game name could only ever bind the wrong one.
 */
export function identityEquals(a: Identity, b: Identity): boolean {
  if (a.key === b.key) return true;
  return a.gameName === b.gameName && (!a.tagLine || !b.tagLine);
}

/**
 * Find the local player in the roster.
 *
 * Tier 1 is full-key equality. Tier 2 exists only because `activePlayer` and
 * `allPlayers` have historically disagreed about whether names carry tags, and
 * is restricted to pairs where at least one side lacks a tag — with tags on
 * both sides, a tier-1 miss means the tags genuinely differ.
 *
 * A wrong bind is not a cosmetic bug: `localPlayer.team` is sent to the server
 * on join and same-team peers are audible at any distance, so binding to the
 * wrong roster entry would reveal the whole map. Ambiguity therefore refuses
 * rather than guessing, and there is no sole-player fallback.
 */
export function matchLocal(roster: Identity[], local: Identity): LocalMatch | null {
  const byKey: number[] = [];
  for (let i = 0; i < roster.length; i++) {
    if (roster[i].key === local.key) byKey.push(i);
  }
  if (byKey.length === 1) return { index: byKey[0], matchedOn: 'key' };
  if (byKey.length > 1) return null;

  const byGameName: number[] = [];
  for (let i = 0; i < roster.length; i++) {
    const candidate = roster[i];
    if (candidate.gameName !== local.gameName) continue;
    if (candidate.tagLine && local.tagLine) continue;
    byGameName.push(i);
  }
  if (byGameName.length === 1) return { index: byGameName[0], matchedOn: 'gameName' };
  return null;
}
