import type { WebSocket } from 'ws';

// Client → Server messages
export interface ClientMessage {
  type: 'join' | 'signal' | 'position' | 'coords' | 'shared_reset' | 'reset_all';
  room?: string;    // required for 'join'
  name?: string;    // required for 'join'
  to?: string;      // required for 'signal' (target player name)
  payload?: any;    // for 'signal' (SDP/ICE data)
  blob?: string;    // for 'position' (peer presence metadata — name/champion/mute/dead state)
  // For 'coords' — the client's plaintext XY position in game coordinates.
  // Stored server-side in the room state and used to compute proximity volumes.
  // Introduced in the v0.2 refactor so peers no longer relay encrypted position
  // blobs for each other (see docs/plans/2026-06-02-server-side-positions.md).
  x?: number;
  y?: number;
  // 'coords' only. True means "this is the last place I saw myself, not where
  // I am" — the client's tracker has lost the player. Absent from every client
  // before v0.5.9, which is why the flag rides on coords rather than a message
  // type of its own: an old client simply never sets it and the server falls
  // back to the staleness timeout exactly as before.
  stale?: boolean;
  // 'coords' with stale: true only (v0.5.23). `seen: true` says x/y are where
  // the client last actually saw itself, `seenAgoMs` how long ago: the server
  // keeps that as `lastSeen` for its teammates' volumes. Without it (every
  // older client, and a client whose user has just said the position is
  // wrong) any lastSeen is dropped.
  seen?: boolean;
  seenAgoMs?: number;
  // 'coords' only — the centre of this client's in-game camera, in game
  // coordinates. Present if and only if the user has "voice on camera" ON.
  //
  // Presence IS the consent flag, deliberately: there is no separate boolean
  // to assert. A client hears from its camera only by publishing that camera
  // to the room, and only against peers who have published one too, so
  // nobody can listen in on a player who has the setting off. The camera is
  // a listening point only, never a point anyone is heard at. Absent from
  // every client before v0.5.9, and from every client whose user has the
  // setting off — in both cases the pair is scored champion to champion.
  cx?: number;
  cy?: number;
  // v0.3: team identifier on 'join' (ORDER / CHAOS). Optional for back-compat
  // — a v0.2 client omits it and the server falls back to team-blind behavior.
  team?: 'ORDER' | 'CHAOS';
  // Shared RESET (v0.5.21, opt-in). On 'join', and on 'shared_reset' whenever
  // the user flips the setting: true opts this client in, anything else opts
  // it out. Only an opted-in client's 'reset_all' is acted on, and only
  // opted-in clients are sent the resulting 'reset' — see ws-handler.ts.
  sharedReset?: boolean;
  on?: boolean;
}

// Server → Client messages
export interface ServerMessage {
  type: 'peer_joined' | 'peer_left' | 'signal' | 'position' | 'room_state' | 'error' | 'reset';
  name?: string;    // for peer_joined/peer_left
  from?: string;    // for signal/position/reset (who sent it)
  peers?: string[]; // for room_state (list of existing peers)
  payload?: any;    // for signal relay
  blob?: string;    // for position relay (peer metadata, NOT coordinates)
  message?: string; // for error
}

export interface ClientInfo {
  roomId: string;
  name: string;
  ws: WebSocket;
  // Latest XY position the client reported via 'coords'. Undefined until the
  // first 'coords' message arrives or if the client predates v0.2.
  position?: { x: number; y: number; updatedMs: number };
  // Latest camera centre reported via 'coords' (#36, "voice on camera").
  // Undefined when the client has the setting off, predates v0.5.9, or has
  // not reported one yet. See ClientMessage.cx — presence is consent.
  camera?: { x: number; y: number; updatedMs: number };
  // Where the client last saw itself, as it said when it disowned its
  // position (`coords` with stale and seen). Used for nothing but its
  // teammates' volumes, and only for a short while — see LOST_ALLY_ANCHOR_MS
  // in volumes.ts.
  lastSeen?: { x: number; y: number; updatedMs: number };
  // v0.3: team for cross-team filtering. Undefined means a legacy v0.2 client —
  // server falls back to team-blind volume math (every peer audible if in range).
  team?: 'ORDER' | 'CHAOS';
  // Shared RESET opt-in, as this connection last declared it. Never carried
  // over from an evicted connection: each connection opts in for itself.
  sharedReset?: boolean;
}
