import { describe, it, expect, beforeEach } from 'vitest';
import { RoomManager } from '../src/rooms.js';
import type { WebSocket } from 'ws';

// Minimal mock WebSocket — just needs to be a unique object reference
function mockWs(): WebSocket {
  return { readyState: 1 } as unknown as WebSocket;
}

describe('RoomManager', () => {
  let rooms: RoomManager;

  beforeEach(() => {
    rooms = new RoomManager();
  });

  it('should add a client to a room and return empty peers list for first joiner', () => {
    const ws = mockWs();
    const { peers } = rooms.join('room1', 'Alice', ws);
    expect(peers).toEqual([]);
    expect(rooms.getPeers('room1')).toEqual(['Alice']);
  });

  it('should return existing peers when a second client joins', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    rooms.join('room1', 'Alice', ws1);
    const { peers } = rooms.join('room1', 'Bob', ws2);
    expect(peers).toEqual(['Alice']);
    expect(rooms.getPeers('room1')).toEqual(['Alice', 'Bob']);
  });

  it('should track multiple clients in the same room', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    const ws3 = mockWs();
    rooms.join('room1', 'Alice', ws1);
    rooms.join('room1', 'Bob', ws2);
    rooms.join('room1', 'Charlie', ws3);
    expect(rooms.getPeers('room1')).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('should remove a client on leave and return their info', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    rooms.join('room1', 'Alice', ws1);
    rooms.join('room1', 'Bob', ws2);

    const info = rooms.leave(ws1);
    expect(info!.roomId).toBe('room1');
    expect(info!.name).toBe('Alice');
    expect(info!.remaining.map(c => c.name)).toEqual(['Bob']);
    expect(rooms.getPeers('room1')).toEqual(['Bob']);
  });

  it('should auto-delete room when last client leaves', () => {
    const ws = mockWs();
    rooms.join('room1', 'Alice', ws);
    expect(rooms.roomCount).toBe(1);

    rooms.leave(ws);
    expect(rooms.roomCount).toBe(0);
    expect(rooms.getPeers('room1')).toEqual([]);
  });

  it('should return undefined when leaving without having joined', () => {
    const ws = mockWs();
    const info = rooms.leave(ws);
    expect(info).toBeUndefined();
  });

  it('should exclude self from getOthersInRoom', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    const ws3 = mockWs();
    rooms.join('room1', 'Alice', ws1);
    rooms.join('room1', 'Bob', ws2);
    rooms.join('room1', 'Charlie', ws3);

    const others = rooms.getOthersInRoom(ws2);
    expect(others).toHaveLength(2);
    expect(others.map(c => c.name)).toEqual(['Alice', 'Charlie']);
  });

  it('should find a client by room and name', () => {
    const ws = mockWs();
    rooms.join('room1', 'Alice', ws);

    const found = rooms.findInRoom('room1', 'Alice');
    expect(found).toBeDefined();
    expect(found!.ws).toBe(ws);
    expect(found!.name).toBe('Alice');
  });

  it('should return undefined for findInRoom with unknown name', () => {
    const ws = mockWs();
    rooms.join('room1', 'Alice', ws);

    expect(rooms.findInRoom('room1', 'Bob')).toBeUndefined();
    expect(rooms.findInRoom('room2', 'Alice')).toBeUndefined();
  });

  it('should return client info via getClientInfo', () => {
    const ws = mockWs();
    rooms.join('room1', 'Alice', ws);

    const info = rooms.getClientInfo(ws);
    expect(info).toEqual({ roomId: 'room1', name: 'Alice', ws });
  });

  it('should track rooms independently', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    rooms.join('room1', 'Alice', ws1);
    rooms.join('room2', 'Bob', ws2);

    expect(rooms.roomCount).toBe(2);
    expect(rooms.getPeers('room1')).toEqual(['Alice']);
    expect(rooms.getPeers('room2')).toEqual(['Bob']);
  });

  // v0.2: server-side position storage
  describe('setPosition / getRoomPositions', () => {
    it('records a client position once they have joined', () => {
      const ws = mockWs();
      rooms.join('room1', 'Alice', ws);
      rooms.setPosition(ws, 100, 200);
      const positions = rooms.getRoomPositions('room1', 'NotAlice', 60_000);
      expect(positions).toEqual({ Alice: { x: 100, y: 200 } });
    });

    it('setPosition is a no-op for a ws not in a room', () => {
      const ws = mockWs();
      rooms.setPosition(ws, 100, 200);  // not in any room
      expect(rooms.getRoomPositions('room1', 'foo', 60_000)).toEqual({});
    });

    it('excludes the requester from the result', () => {
      const wsA = mockWs();
      const wsB = mockWs();
      rooms.join('room1', 'Alice', wsA);
      rooms.join('room1', 'Bob', wsB);
      rooms.setPosition(wsA, 100, 100);
      rooms.setPosition(wsB, 500, 500);
      const fromAlice = rooms.getRoomPositions('room1', 'Alice', 60_000);
      expect(fromAlice).toEqual({ Bob: { x: 500, y: 500 } });
      const fromBob = rooms.getRoomPositions('room1', 'Bob', 60_000);
      expect(fromBob).toEqual({ Alice: { x: 100, y: 100 } });
    });

    it('skips peers who never reported a position', () => {
      const wsA = mockWs();
      const wsB = mockWs();
      rooms.join('room1', 'Alice', wsA);
      rooms.join('room1', 'Bob', wsB);
      rooms.setPosition(wsA, 100, 100);
      // Bob never reports
      const fromBob = rooms.getRoomPositions('room1', 'Bob', 60_000);
      expect(fromBob).toEqual({ Alice: { x: 100, y: 100 } });
      const fromAlice = rooms.getRoomPositions('room1', 'Alice', 60_000);
      expect(fromAlice).toEqual({}); // Bob never reported
    });

    it('skips stale positions older than staleMs', () => {
      const wsA = mockWs();
      const wsB = mockWs();
      rooms.join('room1', 'Alice', wsA);
      rooms.join('room1', 'Bob', wsB);
      rooms.setPosition(wsA, 100, 100);
      // Force Alice's position to be stale by mutating updatedMs directly
      const aliceInfo = rooms.getClientInfo(wsA);
      if (aliceInfo?.position) aliceInfo.position.updatedMs = Date.now() - 120_000;
      rooms.setPosition(wsB, 500, 500);
      const fromBob = rooms.getRoomPositions('room1', 'Bob', 60_000);
      expect(fromBob).toEqual({}); // Alice's 120s-old position skipped
    });

    it('position is released when client leaves the room', () => {
      const wsA = mockWs();
      const wsB = mockWs();
      rooms.join('room1', 'Alice', wsA);
      rooms.join('room1', 'Bob', wsB);
      rooms.setPosition(wsA, 100, 100);
      rooms.leave(wsA);
      const fromBob = rooms.getRoomPositions('room1', 'Bob', 60_000);
      expect(fromBob).toEqual({});
    });

    it('returns empty for unknown roomId', () => {
      expect(rooms.getRoomPositions('does-not-exist', 'me', 60_000)).toEqual({});
    });
  });

  // v0.3: team for cross-team filtering (server-side)
  describe('team on join', () => {
    it('records team when join includes it', () => {
      const ws = mockWs();
      rooms.join('room1', 'Alice', ws, 'ORDER');
      const info = rooms.getClientInfo(ws);
      expect(info?.team).toBe('ORDER');
    });

    it('leaves team undefined when join omits it (legacy v0.2 client)', () => {
      const ws = mockWs();
      rooms.join('room1', 'Alice', ws);
      const info = rooms.getClientInfo(ws);
      expect(info?.team).toBeUndefined();
    });

    it('accepts CHAOS team', () => {
      const ws = mockWs();
      rooms.join('room1', 'Alice', ws, 'CHAOS');
      const info = rooms.getClientInfo(ws);
      expect(info?.team).toBe('CHAOS');
    });
  });

  // One entry per name per room. `findInRoom` takes the FIRST match, so a
  // duplicate entry black-holes every `signal` addressed to that name.
  describe('duplicate names', () => {
    it('evicts the previous holder when a name is re-joined in the same room', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rooms.join('room1', 'Alice', ws1);
      const result = rooms.join('room1', 'Alice', ws2);

      // Asserts the room never holds two entries under one name, and that
      // name lookups resolve to the NEWEST socket. Without the eviction,
      // getPeers is ['Alice', 'Alice'] and findInRoom still returns ws1.
      expect(result.evicted?.ws).toBe(ws1);
      expect(result.peers).toEqual([]);
      expect(rooms.getPeers('room1')).toEqual(['Alice']);
      expect(rooms.findInRoom('room1', 'Alice')!.ws).toBe(ws2);
      expect(rooms.getClientInfo(ws1)).toBeUndefined();
    });

    it('leaves the evicted socket with nothing to leave', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rooms.join('room1', 'Alice', ws1);
      rooms.join('room1', 'Alice', ws2);

      // The direct guard against the spurious peer_left: when the evicted
      // socket finally closes, leave() must report nothing, because the name
      // it held is still live under ws2.
      expect(rooms.leave(ws1)).toBeUndefined();
      expect(rooms.getPeers('room1')).toEqual(['Alice']);
    });

    it('does not evict the same name in a different room', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rooms.join('room1', 'Alice', ws1);
      const result = rooms.join('room2', 'Alice', ws2);

      expect(result.evicted).toBeUndefined();
      expect(rooms.getPeers('room1')).toEqual(['Alice']);
      expect(rooms.getPeers('room2')).toEqual(['Alice']);
    });

    it('keeps the evicted position and team so a reconnect stays audible', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rooms.join('room1', 'Alice', ws1, 'ORDER');
      rooms.setPosition(ws1, 700, 800);

      // A reconnecting client sends join before its first coords. Dropping the
      // carried-over position would make it invisible to cross-team peers
      // (they skip peers with no position) until that first coords lands.
      rooms.join('room1', 'Alice', ws2);
      const info = rooms.getClientInfo(ws2);
      expect(info?.team).toBe('ORDER');
      expect(info?.position).toMatchObject({ x: 700, y: 800 });
    });

    it('lets an explicit team on the new join win over the carried one', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rooms.join('room1', 'Alice', ws1, 'ORDER');
      rooms.join('room1', 'Alice', ws2, 'CHAOS');
      expect(rooms.getClientInfo(ws2)?.team).toBe('CHAOS');
    });

    it('does not disturb the other peers in the room', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      const wsBob = mockWs();
      rooms.join('room1', 'Alice', ws1);
      rooms.join('room1', 'Bob', wsBob);
      const result = rooms.join('room1', 'Alice', ws2);

      expect(result.peers).toEqual(['Bob']);
      expect(rooms.getPeers('room1')).toEqual(['Bob', 'Alice']);
      expect(rooms.getOthersInRoom(ws2).map(c => c.name)).toEqual(['Bob']);
    });
  });

  describe('leave() remaining', () => {
    it('reports the clients still in the room', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      const ws3 = mockWs();
      rooms.join('room1', 'Alice', ws1);
      rooms.join('room1', 'Bob', ws2);
      rooms.join('room1', 'Charlie', ws3);

      // This is what the close handler broadcasts peer_left to;
      // getOthersInRoom cannot be used after leave (the ws has no entry left).
      const gone = rooms.leave(ws2);
      expect(gone!.remaining.map(c => c.name)).toEqual(['Alice', 'Charlie']);
    });

    it('reports nobody remaining when the last client leaves', () => {
      const ws = mockWs();
      rooms.join('room1', 'Alice', ws);
      expect(rooms.leave(ws)!.remaining).toEqual([]);
    });
  });

  describe('setTeam', () => {
    it('updates the team of a joined client', () => {
      const ws = mockWs();
      rooms.join('room1', 'Alice', ws, 'ORDER');
      rooms.setTeam(ws, 'CHAOS');
      expect(rooms.getClientInfo(ws)?.team).toBe('CHAOS');
    });

    it('is a no-op for a ws not in a room', () => {
      const ws = mockWs();
      rooms.setTeam(ws, 'CHAOS');
      expect(rooms.getClientInfo(ws)).toBeUndefined();
    });
  });

});
