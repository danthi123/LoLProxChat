import type { WebSocket } from 'ws';
import type { ClientInfo } from './types.js';
import type { TieredRoomClient } from './volumes.js';

/** Outcome of a `join`. `evicted` is set when the name was already taken. */
export interface JoinResult {
  /** Peer names already in the room, excluding any entry this join evicted. */
  peers: string[];
  /** The previous holder of this name, already removed from room state. */
  evicted?: ClientInfo;
}

export class RoomManager {
  /** roomId → set of ClientInfo */
  private rooms = new Map<string, ClientInfo[]>();
  /** ws → ClientInfo (for fast lookup on disconnect) */
  private clients = new Map<WebSocket, ClientInfo>();

  /**
   * Add a client to a room. Returns the existing peer names (before this join)
   * plus any client evicted because it held the same name.
   *
   * `team` is v0.3+ — when omitted the client is treated as legacy v0.2 and
   * `computeTieredVolumes` falls back to team-blind 1200u behavior.
   */
  join(roomId: string, name: string, ws: WebSocket, team?: 'ORDER' | 'CHAOS'): JoinResult {
    const existing = this.rooms.get(roomId) ?? [];

    // One entry per name per room is an invariant the rest of this file relies
    // on: `findInRoom` resolves the FIRST match, so a second entry under a name
    // black-holes every `signal` addressed to it. The newest socket wins —
    // duplicates come from a player reconnecting, whose previous socket is by
    // then half-open and cannot be distinguished from a live one in time.
    // Removing the old entry here (rather than on its eventual close) is what
    // stops that close from broadcasting a `peer_left` for a name that is
    // still in the room: `leave` will find nothing to remove.
    let evicted: ClientInfo | undefined;
    const dupIdx = existing.findIndex(c => c.name === name);
    if (dupIdx !== -1) {
      evicted = existing[dupIdx];
      existing.splice(dupIdx, 1);
      this.clients.delete(evicted.ws);
    }

    const existingNames = existing.map(c => c.name);

    const info: ClientInfo = {
      roomId,
      name,
      ws,
      // Carry the evicted entry's state forward: a reconnecting player keeps
      // their last known position and team, so cross-team peers don't lose
      // them from the volume response for the tick before the first `coords`.
      team: team ?? evicted?.team,
      position: evicted?.position,
    };
    existing.push(info);
    this.rooms.set(roomId, existing);
    this.clients.set(ws, info);

    return { peers: existingNames, evicted };
  }

  /**
   * Remove a client. Returns their info plus the clients still in the room
   * (empty when that was the last one), or undefined if the ws held no entry —
   * which is also the case for a socket that was evicted by a later join.
   */
  leave(ws: WebSocket): { roomId: string; name: string; remaining: ClientInfo[] } | undefined {
    const info = this.clients.get(ws);
    if (!info) return undefined;

    this.clients.delete(ws);

    const room = this.rooms.get(info.roomId);
    let remaining: ClientInfo[] = [];
    if (room) {
      const idx = room.indexOf(info);
      if (idx !== -1) room.splice(idx, 1);
      if (room.length === 0) {
        this.rooms.delete(info.roomId);
      } else {
        remaining = room.slice();
      }
    }

    return { roomId: info.roomId, name: info.name, remaining };
  }

  /** Get all peer names in a room. */
  getPeers(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    return room ? room.map(c => c.name) : [];
  }

  /** Get all other clients in the same room (excludes the given ws). */
  getOthersInRoom(ws: WebSocket): ClientInfo[] {
    const info = this.clients.get(ws);
    if (!info) return [];
    const room = this.rooms.get(info.roomId);
    if (!room) return [];
    return room.filter(c => c.ws !== ws);
  }

  /**
   * Find a specific client in a room by name. Names are unique within a room
   * (see `join`), so the first match is the only one.
   */
  findInRoom(roomId: string, name: string): ClientInfo | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    return room.find(c => c.name === name);
  }

  /** Get client info for a WebSocket. */
  getClientInfo(ws: WebSocket): ClientInfo | undefined {
    return this.clients.get(ws);
  }

  /**
   * Update a client's team without re-joining. No-op if the ws isn't in a room.
   * Lets the handler refresh team on a repeated `join` without mutating what
   * `getClientInfo` handed back.
   */
  setTeam(ws: WebSocket, team: 'ORDER' | 'CHAOS'): void {
    const info = this.clients.get(ws);
    if (!info) return;
    info.team = team;
  }

  /**
   * Record a client's latest XY position. No-op if the ws isn't in a room.
   */
  setPosition(ws: WebSocket, x: number, y: number): void {
    const info = this.clients.get(ws);
    if (!info) return;
    info.position = { x, y, updatedMs: Date.now() };
  }

  /**
   * Forget a client's position without disconnecting them. They stay in the
   * room and keep being heard by teammates, who are not scored on distance;
   * cross-team peers stop hearing them at once rather than after the staleness
   * window, because the client has told us the position is no longer true.
   */
  clearPosition(ws: WebSocket): void {
    const info = this.clients.get(ws);
    if (!info) return;
    info.position = undefined;
  }

  /**
   * Snapshot of all peer positions in a room, keyed by name. Skips the
   * requester (`exceptName`) and skips entries with no position set yet,
   * or whose position is older than `staleMs`.
   *
   * v0.2 server-side proximity flow: `computeVolumesFromRoom` calls this to
   * get every other peer's most recent reported XY, then computes pairwise
   * distance from the requester's position.
   */
  getRoomPositions(
    roomId: string,
    exceptName: string,
    staleMs: number,
  ): Record<string, { x: number; y: number }> {
    const room = this.rooms.get(roomId);
    if (!room) return {};
    const cutoff = Date.now() - staleMs;
    const out: Record<string, { x: number; y: number }> = {};
    for (const c of room) {
      if (c.name === exceptName) continue;
      if (!c.position) continue;
      if (c.position.updatedMs < cutoff) continue;
      out[c.name] = { x: c.position.x, y: c.position.y };
    }
    return out;
  }

  /**
   * v0.3 — snapshot of all clients in a room with just the fields
   * `computeTieredVolumes` needs (name, team, position). Includes the
   * requester; the function filters itself out by name. No staleness filter
   * here — the caller decides per-peer.
   */
  getRoomClients(roomId: string): TieredRoomClient[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return room.map(c => ({
      name: c.name,
      team: c.team,
      position: c.position,
    }));
  }

  /** Number of active rooms. */
  get roomCount(): number {
    return this.rooms.size;
  }
}
