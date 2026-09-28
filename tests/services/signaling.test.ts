import { SignalingService, PositionBroadcast, SignalMessage } from '../../src/services/signaling';

type Listener = (event: any) => void;

/**
 * Minimal WebSocket stand-in. Nothing happens on its own: the test decides
 * when a socket opens, receives, or closes, which is the only way to reproduce
 * a close event that arrives after the service has already moved on.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls = 0;
  private listeners: Map<string, Listener[]> = new Map();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  emitClose(code = 1006, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code, reason });
  }

  emitMessage(msg: unknown): void {
    this.emit('message', { data: JSON.stringify(msg) });
  }
}

const noopPosition = (_p: PositionBroadcast) => { /* ignored */ };
const noopSignal = (_s: SignalMessage) => { /* ignored */ };
const noopLeave = (_n: string) => { /* ignored */ };

function join(service: SignalingService, room = 'room-1', name = 'Alice', extras: {
  onPeerPosition?: (p: PositionBroadcast) => void;
  onPeerJoined?: (n: string) => void;
  onPeerLeave?: (n: string) => void;
} = {}): void {
  service.joinRoom(
    room,
    name,
    'ORDER',
    extras.onPeerPosition ?? noopPosition,
    noopSignal,
    extras.onPeerLeave ?? noopLeave,
    extras.onPeerJoined,
  );
}

const sockets = () => FakeWebSocket.instances;

describe('SignalingService', () => {
  let originalWebSocket: unknown;

  beforeEach(() => {
    jest.useFakeTimers();
    originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    (globalThis as any).WebSocket = originalWebSocket;
  });

  it('sends a join frame carrying room, name and team once open', () => {
    const service = new SignalingService();
    join(service, 'room-7', 'Alice');
    expect(sockets()).toHaveLength(1);

    sockets()[0].emitOpen();
    expect(JSON.parse(sockets()[0].sent[0])).toEqual({
      type: 'join', room: 'room-7', name: 'Alice', team: 'ORDER',
    });
  });

  it('does not let a superseded socket tear down the live one', () => {
    // leaveRoom → joinRoom resets intentionallyClosed, so if the previous
    // socket's close handshake stalls past the start of the next game, its
    // late close event used to schedule a reconnect that closed the healthy
    // socket and opened a third.
    const service = new SignalingService();
    join(service);
    const first = sockets()[0];
    first.emitOpen();

    service.leaveRoom();
    join(service, 'room-2');
    const second = sockets()[1];
    second.emitOpen();

    first.emitClose();
    jest.advanceTimersByTime(60000);

    expect(sockets()).toHaveLength(2);
    expect(second.closeCalls).toBe(0);
    expect(service.getCurrentRoom()).toBe('room-2');
  });

  it('reconnects after an unexpected close and resets the backoff on open', () => {
    const service = new SignalingService();
    join(service);
    sockets()[0].emitOpen();

    sockets()[0].emitClose();
    jest.advanceTimersByTime(499);
    expect(sockets()).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(sockets()).toHaveLength(2);

    // A successful open puts the attempt counter back, so the next drop waits
    // 500ms again rather than 1000ms.
    sockets()[1].emitOpen();
    sockets()[1].emitClose();
    jest.advanceTimersByTime(499);
    expect(sockets()).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(sockets()).toHaveLength(3);
  });

  it('backs off exponentially while the socket never opens', () => {
    const service = new SignalingService();
    join(service);

    sockets()[0].emitClose();
    jest.advanceTimersByTime(500);
    expect(sockets()).toHaveLength(2);

    sockets()[1].emitClose();
    jest.advanceTimersByTime(999);
    expect(sockets()).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(sockets()).toHaveLength(3);
  });

  it('cancels a pending reconnect when the room is left', () => {
    const service = new SignalingService();
    join(service);
    sockets()[0].emitClose();

    service.leaveRoom();
    jest.advanceTimersByTime(60000);
    expect(sockets()).toHaveLength(1);
  });

  it('never reconnects after a takeover close', () => {
    // Reconnecting would evict whoever took the name, who would evict us back.
    const service = new SignalingService();
    join(service);
    sockets()[0].emitOpen();

    sockets()[0].emitClose(4000, 'replaced by a newer connection');
    jest.advanceTimersByTime(60000);
    expect(sockets()).toHaveLength(1);
  });

  it('filters our own name out of room_state', () => {
    const joined: string[] = [];
    const service = new SignalingService();
    join(service, 'room-1', 'Alice', { onPeerJoined: (n) => joined.push(n) });
    sockets()[0].emitOpen();

    sockets()[0].emitMessage({ type: 'room_state', peers: ['Alice', 'Bob'] });
    expect(joined).toEqual(['Bob']);
  });

  it('ignores messages delivered to a superseded socket', () => {
    const positions: PositionBroadcast[] = [];
    const service = new SignalingService();
    join(service, 'room-1', 'Alice', { onPeerPosition: (p) => positions.push(p) });
    const first = sockets()[0];
    first.emitOpen();

    service.leaveRoom();
    join(service, 'room-2', 'Alice', { onPeerPosition: (p) => positions.push(p) });

    first.emitMessage({
      type: 'position',
      from: 'Bob',
      blob: JSON.stringify({ summonerName: 'Bob', championName: 'Zed', team: 'CHAOS', isMuted: false, isDead: false }),
    });
    expect(positions).toHaveLength(0);
  });

  it('only sends coords and positions on an open socket', () => {
    const service = new SignalingService();
    join(service);
    service.sendCoords(1, 2);
    expect(sockets()[0].sent).toHaveLength(0);

    sockets()[0].emitOpen();
    service.sendCoords(1, 2);
    expect(JSON.parse(sockets()[0].sent[1])).toEqual({ type: 'coords', x: 1, y: 2 });
  });
});
