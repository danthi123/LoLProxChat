import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { RoomManager } from '../src/rooms.js';
import { handleConnection, TAKEOVER_CLOSE_CODE } from '../src/ws-handler.js';
import { Heartbeat, type LivenessTracker, type PingableSocket } from '../src/heartbeat.js';
import type { ServerMessage } from '../src/types.js';

/**
 * Stand-in for a `ws` socket: enough of the surface that handleConnection uses,
 * plus recorders for everything it does to the socket. Driving the real handler
 * (rather than a mock of it) is the point — these tests assert on the routing
 * decisions the handler actually makes.
 */
class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly sent: ServerMessage[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  terminations = 0;
  pings = 0;

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as ServerMessage);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }

  terminate(): void {
    this.terminations += 1;
    this.readyState = 3;
  }

  ping(): void {
    this.pings += 1;
  }

  /** Feed an inbound client message, the way the ws library would. */
  deliver(msg: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }

  received(type: ServerMessage['type']): ServerMessage[] {
    return this.sent.filter(m => m.type === type);
  }

  get ws(): WebSocket {
    return this as unknown as WebSocket;
  }
}

class SpyHeartbeat implements LivenessTracker {
  readonly marked: PingableSocket[] = [];
  markAlive(ws: PingableSocket): void {
    this.marked.push(ws);
  }
}

describe('handleConnection', () => {
  let rooms: RoomManager;
  let heartbeat: Heartbeat;

  function connect(): FakeSocket {
    const sock = new FakeSocket();
    handleConnection(sock.ws, rooms, heartbeat);
    return sock;
  }

  beforeEach(() => {
    rooms = new RoomManager();
    heartbeat = new Heartbeat();
    // The eviction path arms a real timer; fake timers keep it out of the
    // other tests and let the eviction test assert on it directly.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('duplicate-name takeover', () => {
    it('routes signaling to the newest connection under a name', () => {
      // The reported bug: with two entries under "Bob", findInRoom resolves the
      // first (stale) one and every offer/answer/ICE candidate is dropped
      // silently. Reverting the eviction inverts both assertions below.
      const alice = connect();
      const bob1 = connect();
      const bob2 = connect();
      alice.deliver({ type: 'join', room: 'r1', name: 'Alice' });
      bob1.deliver({ type: 'join', room: 'r1', name: 'Bob' });
      bob2.deliver({ type: 'join', room: 'r1', name: 'Bob' });

      alice.deliver({ type: 'signal', to: 'Bob', payload: { sdp: 'offer' } });

      expect(bob2.received('signal')).toHaveLength(1);
      expect(bob2.received('signal')[0].from).toBe('Alice');
      expect(bob1.received('signal')).toHaveLength(0);
    });

    it('does not announce a departure when the superseded socket closes', () => {
      // peer_left is keyed by NAME. Broadcasting one for the evicted socket
      // makes every peer tear down the connection to the LIVE socket of that
      // same name — the second, more damaging half of the bug.
      const alice = connect();
      const bob1 = connect();
      const bob2 = connect();
      alice.deliver({ type: 'join', room: 'r1', name: 'Alice' });
      bob1.deliver({ type: 'join', room: 'r1', name: 'Bob' });
      bob2.deliver({ type: 'join', room: 'r1', name: 'Bob' });

      bob1.emit('close');

      expect(alice.received('peer_left')).toHaveLength(0);
      expect(rooms.findInRoom('r1', 'Bob')!.ws).toBe(bob2.ws);
    });

    it('closes the evicted socket with the takeover code, then terminates it', () => {
      // close() alone would sit in CLOSING for ws's 30 s close timeout on the
      // half-open socket eviction exists for, holding a per-IP connection slot.
      const bob1 = connect();
      const bob2 = connect();
      bob1.deliver({ type: 'join', room: 'r1', name: 'Bob' });
      bob2.deliver({ type: 'join', room: 'r1', name: 'Bob' });

      expect(bob1.closes).toHaveLength(1);
      expect(bob1.closes[0].code).toBe(TAKEOVER_CLOSE_CODE);
      expect(bob1.terminations).toBe(0);

      vi.advanceTimersByTime(1000);
      expect(bob1.terminations).toBe(1);
    });

    it('leaves the other peers in the room untouched', () => {
      const alice = connect();
      const bob1 = connect();
      const bob2 = connect();
      alice.deliver({ type: 'join', room: 'r1', name: 'Alice' });
      bob1.deliver({ type: 'join', room: 'r1', name: 'Bob' });
      bob2.deliver({ type: 'join', room: 'r1', name: 'Bob' });

      expect(alice.closes).toHaveLength(0);
      expect(rooms.getPeers('r1')).toEqual(['Alice', 'Bob']);
      // The joiner's room_state must not list itself.
      expect(bob2.received('room_state')[0].peers).toEqual(['Alice']);
    });
  });

  describe('re-join', () => {
    it('notifies the old room when a client moves to a different room', () => {
      // This branch was dead: it called leave() and then getOthersInRoom(),
      // which returns [] once the ws has no entry, so nobody was ever told.
      const alice = connect();
      const bob = connect();
      alice.deliver({ type: 'join', room: 'r1', name: 'Alice' });
      bob.deliver({ type: 'join', room: 'r1', name: 'Bob' });

      bob.deliver({ type: 'join', room: 'r2', name: 'Bob' });

      expect(alice.received('peer_left').map(m => m.name)).toEqual(['Bob']);
      expect(rooms.getPeers('r1')).toEqual(['Alice']);
      expect(rooms.getPeers('r2')).toEqual(['Bob']);
    });

    it('treats a repeat join on the same socket as idempotent', () => {
      // If this path fell through to rooms.join(), the dedup would find this
      // socket's OWN entry and the handler would close the live connection.
      const alice = connect();
      const bob = connect();
      alice.deliver({ type: 'join', room: 'r1', name: 'Alice' });
      bob.deliver({ type: 'join', room: 'r1', name: 'Bob' });
      const aliceBefore = alice.sent.length;

      bob.deliver({ type: 'join', room: 'r1', name: 'Bob' });

      expect(bob.closes).toHaveLength(0);
      expect(bob.terminations).toBe(0);
      expect(alice.sent).toHaveLength(aliceBefore); // no peer_left, no peer_joined
      // A fresh room_state, built from the OTHER clients — never including self.
      expect(bob.received('room_state')).toHaveLength(2);
      expect(bob.received('room_state')[1].peers).toEqual(['Alice']);

      // ...and the socket is still the one signaling resolves to.
      alice.deliver({ type: 'signal', to: 'Bob', payload: { sdp: 'offer' } });
      expect(bob.received('signal')).toHaveLength(1);
    });

    it('refreshes team on a repeat join', () => {
      const bob = connect();
      bob.deliver({ type: 'join', room: 'r1', name: 'Bob', team: 'ORDER' });
      bob.deliver({ type: 'join', room: 'r1', name: 'Bob', team: 'CHAOS' });
      expect(rooms.getClientInfo(bob.ws)?.team).toBe('CHAOS');
    });
  });

  describe('close', () => {
    it('announces a real departure exactly once', () => {
      const alice = connect();
      const bob = connect();
      alice.deliver({ type: 'join', room: 'r1', name: 'Alice' });
      bob.deliver({ type: 'join', room: 'r1', name: 'Bob' });

      bob.emit('close');

      expect(alice.received('peer_left').map(m => m.name)).toEqual(['Bob']);
      expect(rooms.getPeers('r1')).toEqual(['Alice']);
    });

    it('says nothing for a socket that never joined', () => {
      const alice = connect();
      const stranger = connect();
      alice.deliver({ type: 'join', room: 'r1', name: 'Alice' });

      stranger.emit('close');
      expect(alice.received('peer_left')).toHaveLength(0);
    });
  });

  describe('join validation', () => {
    const bad: Array<[string, unknown]> = [
      ['a name past the length cap', { type: 'join', room: 'r1', name: 'a'.repeat(65) }],
      ['a control character in the name', { type: 'join', room: 'r1', name: 'Ali ce' }],
      ['a non-string name', { type: 'join', room: 'r1', name: {} }],
      ['a non-string room', { type: 'join', room: 123, name: 'Alice' }],
      ['a room id outside the charset', { type: 'join', room: 'r 1', name: 'Alice' }],
      ['a missing name', { type: 'join', room: 'r1' }],
    ];

    for (const [label, msg] of bad) {
      it(`rejects ${label} without joining`, () => {
        const sock = connect();
        sock.deliver(msg);

        expect(sock.received('error')).toHaveLength(1);
        expect(sock.received('room_state')).toHaveLength(0);
        expect(rooms.getPeers('r1')).toEqual([]);
        // The socket stays open: a retry with the same values cannot succeed,
        // and closing would spin the client's reconnect loop forever.
        expect(sock.closes).toHaveLength(0);
      });
    }
  });

  describe('liveness', () => {
    it('marks the connection alive on every inbound message', () => {
      // The 10 Hz coords stream is what makes reaping a playing client
      // impossible; without this call site nothing but a pong keeps a client
      // alive, and nothing else in the suite covers it.
      const spy = new SpyHeartbeat();
      const sock = new FakeSocket();
      handleConnection(sock.ws, rooms, spy);

      sock.deliver({ type: 'join', room: 'r1', name: 'Alice' });
      sock.deliver({ type: 'coords', x: 1, y: 2 });

      expect(spy.marked).toHaveLength(2);
      expect(spy.marked[0]).toBe(sock.ws);
    });

    it('marks a rate-limited message alive too', () => {
      // A throttled client is still a live one; reaping it would tear down
      // working audio for every peer in its room.
      const spy = new SpyHeartbeat();
      const sock = new FakeSocket();
      handleConnection(sock.ws, rooms, spy);
      sock.deliver({ type: 'join', room: 'r1', name: 'Alice' });

      // Past the 200-message bucket capacity, with the clock frozen so it
      // cannot refill — the tail of these is throttled.
      for (let i = 0; i < 400; i++) sock.deliver({ type: 'coords', x: 1, y: 2 });

      expect(sock.received('error').length).toBeGreaterThan(0);
      expect(spy.marked).toHaveLength(401);
    });
  });

  describe('signal relay', () => {
    it('tells the sender when the target is not in the room', () => {
      const alice = connect();
      alice.deliver({ type: 'join', room: 'r1', name: 'Alice' });
      alice.deliver({ type: 'signal', to: 'Nobody', payload: {} });

      expect(alice.received('error')).toHaveLength(1);
    });

    it('tells the sender when the target socket is no longer open', () => {
      // Previously a silent drop — exactly the invisible failure this cluster
      // exists to remove.
      const alice = connect();
      const bob = connect();
      alice.deliver({ type: 'join', room: 'r1', name: 'Alice' });
      bob.deliver({ type: 'join', room: 'r1', name: 'Bob' });
      bob.readyState = 3; // socket died without a close event yet

      alice.deliver({ type: 'signal', to: 'Bob', payload: {} });
      expect(alice.received('error')).toHaveLength(1);
    });
  });
});
