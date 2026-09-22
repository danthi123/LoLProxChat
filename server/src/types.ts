import type { WebSocket } from 'ws';

// Client → Server messages
export interface ClientMessage {
  type: 'join' | 'signal' | 'position' | 'coords';
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
  // 'coords' only — the centre of this client's in-game camera, in game
  // coordinates. Present if and only if the user has "voice on camera" ON.
  //
  // Presence IS the consent flag, deliberately: there is no separate boolean
  // to assert. A client hears from its camera only by publishing that camera
  // to the room, and the server scores peers against the published copy, so
  // you cannot listen from a point without also being audible at it. Absent
  // from every client before v0.5.9, and from every client whose user has the
  // setting off — in both cases the pair falls back to champion positions on
  // both sides.
  cx?: number;
  cy?: number;
  // v0.3: team identifier on 'join' (ORDER / CHAOS). Optional for back-compat
  // — a v0.2 client omits it and the server falls back to team-blind behavior.
  team?: 'ORDER' | 'CHAOS';
}

// Server → Client messages
export interface ServerMessage {
  type: 'peer_joined' | 'peer_left' | 'signal' | 'position' | 'room_state' | 'error';
  name?: string;    // for peer_joined/peer_left
  from?: string;    // for signal/position (who sent it)
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
  // v0.3: team for cross-team filtering. Undefined means a legacy v0.2 client —
  // server falls back to team-blind volume math (every peer audible if in range).
  team?: 'ORDER' | 'CHAOS';
}
