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
  /** roomId → when a shared RESET was last relayed there. */
  private roomResetMs = new Map<string, number>();
  /** roomId → name → when that player last had one relayed. Kept per name,
   *  not per connection, so reconnecting does not reset it. */
  private senderResetMs = new Map<string, Map<string, number>>();

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
      camera: evicted?.camera,
      lastSeen: evicted?.lastSeen,
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
        this.roomResetMs.delete(info.roomId);
        this.senderResetMs.delete(info.roomId);
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
    info.lastSeen = undefined;
  }

  /**
   * Record a client's latest camera centre ("voice on camera", #36). No-op if
   * the ws isn't in a room.
   */
  setCamera(ws: WebSocket, x: number, y: number): void {
    const info = this.clients.get(ws);
    if (!info) return;
    info.camera = { x, y, updatedMs: Date.now() };
  }

  /** Record whether a client has opted in to shared RESET. No-op if the ws
   *  isn't in a room. */
  setSharedReset(ws: WebSocket, on: boolean): void {
    const info = this.clients.get(ws);
    if (!info) return;
    info.sharedReset = on;
  }

  /**
   * When a 'reset_all' was last relayed in a room, and stamp it now if one may
   * be: false while the room is within `cooldownMs` of the last one.
   */
  tryStampRoomReset(roomId: string, now: number, cooldownMs: number): boolean {
    const last = this.roomResetMs.get(roomId);
    if (last !== undefined && now - last < cooldownMs) return false;
    this.roomResetMs.set(roomId, now);
    return true;
  }

  /**
   * Whether `name` in `roomId` may have a shared RESET relayed (none within
   * `cooldownMs`). Only checks: stamp with stampSenderReset once it is.
   */
  senderResetAllowed(roomId: string, name: string, now: number, cooldownMs: number): boolean {
    const last = this.senderResetMs.get(roomId)?.get(name);
    return last === undefined || now - last >= cooldownMs;
  }

  stampSenderReset(roomId: string, name: string, now: number): void {
    let byName = this.senderResetMs.get(roomId);
    if (!byName) {
      byName = new Map();
      this.senderResetMs.set(roomId, byName);
    }
    byName.set(name, now);
  }

  /**
   * Forget a client's camera centre. Called whenever a `coords` arrives
   * WITHOUT one, which is how a client says "voice on camera is off" — so
   * toggling the setting off takes effect on the next position tick rather
   * than after the staleness window.
   */
  clearCamera(ws: WebSocket): void {
    const info = this.clients.get(ws);
    if (!info) return;
    info.camera = undefined;
  }

  /**
   * Forget a client's position without disconnecting them. They stay in the
   * room and keep being heard by teammates; cross-team peers stop hearing them
   * at once rather than after the staleness window, because the client has
   * told us the position is no longer true. It is kept as `lastSeen`, which
   * teammates with ally proximity on go on being scored against for a short
   * while (computeTieredVolumes).
   */
  clearPosition(ws: WebSocket): void {
    const info = this.clients.get(ws);
    if (!info) return;
    if (info.position) info.lastSeen = info.position;
    info.position = undefined;
    // The camera goes with it. Disowning the position means "I no longer know
    // where I am"; a peer with no position is skipped in scoring anyway, and
    // a leftover camera would only go on advertising the opt-in for a client
    // that has nothing to be scored at.
    info.camera = undefined;
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
      camera: c.camera,
      lastSeen: c.lastSeen,
    }));
  }

  /** Number of active rooms. */
  get roomCount(): number {
    return this.rooms.size;
  }
}
