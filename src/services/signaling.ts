import { WS_URL } from '../core/config';

export type SignalType = 'offer' | 'answer' | 'ice-candidate';

/**
 * Close code the server sends when this room+name has been handed to a newer
 * connection (see `server/src/ws-handler.ts`). Terminal for us: reconnecting
 * would evict whoever took the name, they would reconnect and evict us back,
 * and the two would trade the room forever without either ever completing a
 * WebRTC handshake.
 */
const TAKEOVER_CLOSE_CODE = 4000;

export interface SignalMessage {
  type: SignalType;
  from: string;
  to: string;
  payload: any;
}

export interface PositionBroadcast {
  summonerName: string;
  championName: string;
  team: string;
  isMuted: boolean;
  isDead: boolean;
}

type OnPeerPosition = (peer: PositionBroadcast) => void;
type OnSignal = (signal: SignalMessage) => void;
type OnPeerLeave = (summonerName: string) => void;
type OnPeerJoined = (name: string) => void;

export class SignalingService {
  private ws: WebSocket | null = null;
  private localName: string = '';
  // Saved so reconnect can rejoin the same room with the same identity
  private currentRoomId: string | null = null;
  // v0.3: team is fixed for the session (sent on join) and used by the server
  // for team-aware proximity.
  private currentTeam: 'ORDER' | 'CHAOS' | null = null;
  private currentHandlers: {
    onPeerPosition: OnPeerPosition;
    onSignal: OnSignal;
    onPeerLeave: OnPeerLeave;
    onPeerJoined?: OnPeerJoined;
  } | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;

  joinRoom(
    roomId: string,
    localName: string,
    team: 'ORDER' | 'CHAOS',
    onPeerPosition: OnPeerPosition,
    onSignal: OnSignal,
    onPeerLeave: OnPeerLeave,
    onPeerJoined?: OnPeerJoined,
  ): void {
    this.localName = localName;
    this.currentRoomId = roomId;
    this.currentTeam = team;
    this.currentHandlers = { onPeerPosition, onSignal, onPeerLeave, onPeerJoined };
    this.intentionallyClosed = false;
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  private openSocket(): void {
    if (!this.currentRoomId || !this.currentHandlers) return;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }

    const { onPeerPosition, onSignal, onPeerLeave, onPeerJoined } = this.currentHandlers;
    const roomId = this.currentRoomId;
    const localName = this.localName;

    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    const team = this.currentTeam;

    // Every listener below is scoped to the socket it was attached to: `this.ws`
    // is reassigned on reconnect, and a superseded socket must not be able to
    // send a second `join` or drive the reconnect backoff.
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      console.log('[Signaling] WebSocket connected');
      this.reconnectAttempt = 0;
      // v0.3: include team in join. Older servers ignore the extra field.
      ws.send(JSON.stringify({ type: 'join', room: roomId, name: localName, team }));
    });

    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return;
      let msg: any;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        console.warn('[Signaling] Failed to parse message:', event.data);
        return;
      }

      switch (msg.type) {
        case 'room_state': {
          // Existing peers already in the room
          const peers: string[] = msg.peers || [];
          for (const name of peers) {
            // Filter self out, as `peer_joined` already does — a server that
            // still had a stale entry under our own name would otherwise have
            // us open a peer connection to ourselves.
            if (name === this.localName) continue;
            onPeerJoined?.(name);
          }
          break;
        }

        case 'peer_joined': {
          if (msg.name !== this.localName) {
            onPeerJoined?.(msg.name);
          }
          break;
        }

        case 'peer_left': {
          onPeerLeave(msg.name);
          break;
        }

        case 'signal': {
          // Envelope: { type: 'offer' | 'answer' | 'ice-candidate', payload: <whatever> }
          // Older builds sent the raw SDP/candidate without an envelope; SDPs have a
          // `.type` field of their own so offers/answers happened to work, but ICE
          // candidates had no type and were silently dropped.
          onSignal({
            type: msg.payload?.type,
            from: msg.from,
            to: this.localName,
            payload: msg.payload?.payload,
          });
          break;
        }

        case 'position': {
          if (msg.from !== this.localName) {
            try {
              const broadcast: PositionBroadcast = JSON.parse(msg.blob);
              onPeerPosition(broadcast);
            } catch {
              console.warn('[Signaling] Failed to parse position blob from:', msg.from);
            }
          }
          break;
        }

        case 'error': {
          console.error('[Signaling] Server error:', msg.message);
          break;
        }
      }
    });

    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return;
      console.log('[Signaling] WebSocket disconnected (code ' + event.code +
        (event.reason ? ', ' + event.reason : '') + ')');
      if (this.intentionallyClosed) return;
      if (event.code === TAKEOVER_CLOSE_CODE) {
        console.error('[Signaling] Another connection took over this room as "' +
          this.localName + '" — not reconnecting. Is LoLProxChat already running?');
        this.intentionallyClosed = true;
        if (this.reconnectTimer !== null) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        return;
      }
      // Exponential backoff capped at 30s
      this.reconnectAttempt++;
      const delayMs = Math.min(30000, 500 * Math.pow(2, this.reconnectAttempt - 1));
      console.log('[Signaling] Reconnecting in ' + delayMs + 'ms (attempt ' + this.reconnectAttempt + ')');
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.openSocket();
      }, delayMs);
    });

    ws.addEventListener('error', (err) => {
      console.error('[Signaling] WebSocket error:', err);
    });
  }

  broadcastPosition(data: PositionBroadcast): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'position',
        blob: JSON.stringify(data),
      }));
    }
  }

  /**
   * v0.2: send the local player's XY coordinates to the server, where they
   * land in the room state and feed the next /compute-volumes request.
   */
  /**
   * Report our position, or disown it.
   *
   * `stale` says the tracker has lost the player and this is only the last
   * place we saw them. A server that understands the flag drops the stored
   * position immediately; one that does not sees an ordinary coords message
   * carrying the same numbers it would have kept serving anyway, so an older
   * server is no worse off than before the flag existed. That back-compat is
   * the reason this rides on `coords` rather than a message type of its own —
   * an unknown type draws an error reply from every server already deployed.
   */
  /**
   * Report our champion position to server-side room state.
   *
   * `camera` is the centre of our in-game camera, sent only while the user has
   * "voice on camera" (#36) on. Its presence is the opt-in: the server stores
   * it, uses it as one of our listening points, and scores peers against it as
   * one of the points we are audible at — and only when the peer has published
   * one too. Omitting it is how the client says the setting is off, which the
   * server acts on immediately rather than waiting for the value to age out.
   */
  sendCoords(x: number, y: number, stale = false, camera?: { x: number; y: number } | null): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (stale) {
      this.ws.send(JSON.stringify({ type: 'coords', x, y, stale: true }));
      return;
    }
    this.ws.send(JSON.stringify(camera
      ? { type: 'coords', x, y, cx: camera.x, cy: camera.y }
      : { type: 'coords', x, y }));
  }

  /** Current room ID + local player name, for HTTP requests that need them
   *  (volume-client's /compute-volumes uses both in the v0.2 request body). */
  getCurrentRoom(): string | null { return this.currentRoomId; }
  getLocalName(): string { return this.localName; }

  sendSignal(signal: SignalMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'signal',
        to: signal.to,
        // Envelope so the receiver can identify ice-candidates (which carry
        // no `.type` field of their own, unlike RTCSessionDescriptionInit).
        payload: { type: signal.type, payload: signal.payload },
      }));
    }
  }

  leaveRoom(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.currentRoomId = null;
    this.currentTeam = null;
    this.currentHandlers = null;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }
}
