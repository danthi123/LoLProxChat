import { describe, it, expect, beforeEach } from 'vitest';
import { Heartbeat, type PingableSocket } from '../src/heartbeat.js';

class FakeSocket implements PingableSocket {
  pings = 0;
  terminations = 0;
  ping(): void { this.pings += 1; }
  terminate(): void { this.terminations += 1; }
}

describe('Heartbeat', () => {
  let hb: Heartbeat;

  beforeEach(() => {
    hb = new Heartbeat();
  });

  it('pings on the first sweep without terminating', () => {
    // A freshly tracked socket has shown life (it just connected), so the
    // first sweep may only ask for a pong.
    const ws = new FakeSocket();
    hb.track(ws);

    expect(hb.sweep([ws])).toBe(0);
    expect(ws.pings).toBe(1);
    expect(ws.terminations).toBe(0);
  });

  it('terminates on the second sweep when the ping went unanswered', () => {
    // The core reap: two intervals of silence is a dead connection.
    const ws = new FakeSocket();
    hb.track(ws);

    hb.sweep([ws]);
    expect(hb.sweep([ws])).toBe(1);
    expect(ws.terminations).toBe(1);
    expect(ws.pings).toBe(1); // no second ping — it was terminated instead
  });

  it('keeps a socket that pongs between sweeps', () => {
    const ws = new FakeSocket();
    hb.track(ws);

    hb.sweep([ws]);
    hb.markAlive(ws);   // stands in for the 'pong' event
    expect(hb.sweep([ws])).toBe(0);
    expect(ws.terminations).toBe(0);
    expect(ws.pings).toBe(2);
  });

  it('keeps a socket alive on inbound traffic alone, with no pong', () => {
    // Guards the in-game false positive: a client streaming coords at 10 Hz
    // must never be reaped, whatever its WebSocket stack does about pings.
    const ws = new FakeSocket();
    hb.track(ws);

    for (let i = 0; i < 5; i++) {
      hb.sweep([ws]);
      hb.markAlive(ws);
    }
    expect(ws.terminations).toBe(0);
  });

  it('counts every socket it terminated', () => {
    const dead1 = new FakeSocket();
    const dead2 = new FakeSocket();
    const live = new FakeSocket();
    hb.track(dead1);
    hb.track(dead2);
    hb.track(live);

    hb.sweep([dead1, dead2, live]);
    hb.markAlive(live);
    expect(hb.sweep([dead1, dead2, live])).toBe(2);
    expect(live.terminations).toBe(0);
  });

  it('ignores a socket it was never told to track', () => {
    // Connections rejected by the per-IP limiter are never tracked, and must
    // not be pinged or terminated by the sweep.
    const ws = new FakeSocket();

    expect(hb.sweep([ws])).toBe(0);
    expect(hb.sweep([ws])).toBe(0);
    expect(ws.pings).toBe(0);
    expect(ws.terminations).toBe(0);
  });

  it('does not enroll an untracked socket via markAlive', () => {
    const ws = new FakeSocket();
    hb.markAlive(ws);

    hb.sweep([ws]);
    expect(ws.pings).toBe(0);
  });

  it('forgets a socket once it has been terminated', () => {
    // A terminated socket stays in wss.clients briefly; sweeping it again
    // must not terminate it a second time.
    const ws = new FakeSocket();
    hb.track(ws);
    hb.sweep([ws]);
    hb.sweep([ws]);

    expect(hb.sweep([ws])).toBe(0);
    expect(ws.terminations).toBe(1);
  });
});
