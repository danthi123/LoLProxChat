import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from './types.js';
import type { RoomManager } from './rooms.js';
import type { LivenessTracker } from './heartbeat.js';
import { validateJoin } from './validate.js';
import { TokenBucket, LIMITS, type RejectReason } from './rate-limit.js';

/**
 * Close code sent to a socket whose room+name has been taken over by a newer
 * connection. The client treats it as terminal instead of reconnecting — see
 * `src/services/signaling.ts`.
 */
export const TAKEOVER_CLOSE_CODE = 4000;

// How long an evicted socket gets to acknowledge the close frame before it is
// torn down. The socket being evicted is usually half-open (that is why it was
// replaced), so the close handshake would never complete and ws's 30 s close
// timeout would keep it in `wss.clients` — and holding one of the 20 per-IP
// connection slots shared by a whole household — for that whole window.
const EVICT_TERMINATE_MS = 1000;

/** Returns false when the message was dropped because the socket isn't open. */
function send(ws: WebSocket, msg: ServerMessage): boolean {
  if (ws.readyState !== ws.OPEN) {
    // A silent drop here is how a stale room entry black-holes signaling, so
    // make it greppable. `position` is excluded: it relays at 10 Hz per peer
    // and would flood the log from a single dead socket.
    if (msg.type !== 'position') {
      console.warn('[ws] dropped', msg.type, 'to a non-OPEN socket (readyState=' + ws.readyState + ')');
    }
    return false;
  }
  ws.send(JSON.stringify(msg));
  return true;
}

function sendError(ws: WebSocket, message: string): void {
  send(ws, { type: 'error', message });
}

/** Hand a name over to a newer connection, without waiting on the old one. */
function evict(ws: WebSocket): void {
  try {
    ws.close(TAKEOVER_CLOSE_CODE, 'replaced by a newer connection');
  } catch {
    // Already closing or closed — the terminate below is the backstop.
  }
  setTimeout(() => {
    try {
      ws.terminate();
    } catch {
      /* already gone */
    }
  }, EVICT_TERMINATE_MS).unref();
}

export function handleConnection(
  ws: WebSocket,
  rooms: RoomManager,
  heartbeat: LivenessTracker,
  onReject?: (reason: RejectReason) => void,
): void {
  // Per-connection message rate limiter. Each WebSocket gets its own bucket
  // so a single noisy client can't block a normal one. Capacity matches the
  // ~10 Hz position-broadcast cadence plus signaling bursts at game start.
  const msgLimiter = new TokenBucket(LIMITS.WS_MESSAGES);
  const limitKey = 'self'; // single bucket per connection — key is irrelevant

  ws.on('message', (data) => {
    // Everything below runs inside try/catch because `ws` emits this listener
    // synchronously: anything that throws here escapes to the EventEmitter and
    // takes the whole process — every room with it — down with one frame from
    // one unauthenticated stranger.
    try {
      // Before the rate limit: a client that is being throttled is still alive,
      // and reaping it would tear down working audio for every peer.
      heartbeat.markAlive(ws);

      if (!msgLimiter.tryConsume(limitKey)) {
        onReject?.('ws_messages');
        sendError(ws, 'message rate limit exceeded — slow down');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        sendError(ws, 'Invalid JSON');
        return;
      }
      // `null`, numbers, strings and arrays are all well-formed JSON that carry
      // no `type`. Only `null` is fatal — reading `.type` off it throws — but the
      // rest have no business reaching the switch either.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendError(ws, 'Invalid message');
        return;
      }
      const msg = parsed as ClientMessage;

      switch (msg.type) {
        case 'join': {
          const valid = validateJoin(msg.room, msg.name);
          if (!valid.ok) {
            // The socket stays open: a retry with the same values can't succeed,
            // and closing would send the client's reconnect loop around forever.
            sendError(ws, valid.error);
            return;
          }
          const { room, name } = valid;

          // v0.3: optional team field. v0.2.x clients omit it; we pass undefined
          // and computeTieredVolumes falls back to legacy team-blind behavior.
          const team = msg.team === 'ORDER' || msg.team === 'CHAOS' ? msg.team : undefined;

          const existing = rooms.getClientInfo(ws);
          if (existing) {
            if (existing.roomId === room && existing.name === name) {
              // Repeat join on a live socket. Returning here is load-bearing:
              // falling through would have `join` find this socket's OWN entry as
              // the duplicate and evict the connection that just spoke.
              if (team) rooms.setTeam(ws, team);
              send(ws, { type: 'room_state', peers: rooms.getOthersInRoom(ws).map(c => c.name) });
              return;
            }
            // Moving rooms: the old room has to be told, and it has to be told
            // from `remaining` — after `leave`, `getOthersInRoom` has no entry to
            // resolve the room from and returns nothing.
            const gone = rooms.leave(ws);
            if (gone) {
              for (const peer of gone.remaining) {
                send(peer.ws, { type: 'peer_left', name: gone.name });
              }
            }
          }

          const { peers, evicted } = rooms.join(room, name, ws, team);

          if (evicted && evicted.ws !== ws) {
            console.log('[ws] takeover: "' + name + '" in room ' + room + ' moved to a newer connection');
            evict(evicted.ws);
            // No peer_left for the evicted socket: the name is still in the room,
            // and telling peers it left would make them tear down the connection
            // to the client that just took it over.
          }

          // Send room_state to the joiner
          send(ws, { type: 'room_state', peers });

          // Broadcast peer_joined to others already in the room
          const others = rooms.getOthersInRoom(ws);
          for (const peer of others) {
            send(peer.ws, { type: 'peer_joined', name });
          }
          break;
        }

        case 'signal': {
          const info = rooms.getClientInfo(ws);
          if (!info) {
            sendError(ws, 'Not in a room');
            return;
          }
          if (!msg.to) {
            sendError(ws, 'signal requires "to" field');
            return;
          }
          const target = rooms.findInRoom(info.roomId, msg.to);
          if (!target) {
            sendError(ws, `Peer "${msg.to}" not found in room`);
            return;
          }
          if (!send(target.ws, { type: 'signal', from: info.name, payload: msg.payload })) {
            // Tell the sender rather than letting the handshake stall silently.
            sendError(ws, `Peer "${msg.to}" is not reachable`);
          }
          break;
        }

        case 'position': {
          // Peer-presence metadata broadcast (name/champion/mute/dead state).
          // NOT the XY coordinates — those use 'coords' since v0.2.
          const info = rooms.getClientInfo(ws);
          if (!info) {
            sendError(ws, 'Not in a room');
            return;
          }
          const others = rooms.getOthersInRoom(ws);
          for (const peer of others) {
            send(peer.ws, { type: 'position', from: info.name, blob: msg.blob });
          }
          break;
        }

        case 'coords': {
          // v0.2 server-side proximity: client reports its XY directly to the
          // server (replaces the v0.1 encrypted-blob exchange over WebRTC data
          // channels). Server stores in room state; the next /compute-volumes
          // request reads it for pairwise distance.
          const info = rooms.getClientInfo(ws);
          if (!info) {
            sendError(ws, 'Not in a room');
            return;
          }
          if (typeof msg.x !== 'number' || typeof msg.y !== 'number' ||
              !isFinite(msg.x) || !isFinite(msg.y)) {
            sendError(ws, 'coords requires finite x and y');
            return;
          }
          // A client that has lost track of its own player disowns the
          // position rather than letting it age out: waiting for the staleness
          // window keeps cross-team peers scored against a place it has
          // already left.
          if (msg.stale === true) {
            rooms.clearPosition(ws);
            break;
          }
          rooms.setPosition(ws, msg.x, msg.y);
          // "Voice on camera" (#36). A camera centre on this message means the
          // user has the setting on; its absence means off, and clearing here
          // rather than letting it age out is what makes toggling the setting
          // off take effect immediately. A malformed pair is treated as absent
          // rather than rejected, so one bad frame cannot drop a client that is
          // otherwise reporting fine.
          if (typeof msg.cx === 'number' && typeof msg.cy === 'number' &&
              isFinite(msg.cx) && isFinite(msg.cy)) {
            rooms.setCamera(ws, msg.cx, msg.cy);
          } else {
            rooms.clearCamera(ws);
          }
          break;
        }

        default:
          sendError(ws, `Unknown message type: ${(msg as any).type}`);
      }
    } catch (err) {
      // Reached only by a bug on this path — but the alternative is process
      // death, so degrade to one dropped message instead.
      console.error('[ws] message handler threw:', (err as Error)?.message ?? err);
      sendError(ws, 'Internal error');
    }
  });

  ws.on('close', () => {
    // Undefined for a socket that was evicted by a later join — its name is
    // still live under a different socket, so nothing is broadcast.
    const gone = rooms.leave(ws);
    if (!gone) return;
    for (const peer of gone.remaining) {
      send(peer.ws, { type: 'peer_left', name: gone.name });
    }
  });
}
