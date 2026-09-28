// WebSocket liveness. Without it a half-open TCP connection (laptop lid, dropped
// tether, killed Wi-Fi) is never noticed: the socket's `close` never fires, so
// `RoomManager.leave` never runs and the client stays in the room until the OS
// TCP timeout, which can be many minutes. That stale entry both black-holes
// signaling addressed to its name and — because `computeTieredVolumes` skips
// the staleness check for allies — holds an ally at volume 1.0 indefinitely.

/** The parts of a `ws` socket the sweep uses. */
export interface PingableSocket {
  ping(): void;
  terminate(): void;
}

/** What the message handler needs in order to report inbound activity. */
export interface LivenessTracker {
  markAlive(ws: PingableSocket): void;
}

/**
 * Ping interval. One missed pong is tolerated, so detection takes one to two
 * intervals (30-60 s).
 *
 * Shorter risks terminating a live client through an ordinary 15-30 s mobile
 * or Wi-Fi stall — an expensive false positive, since a terminate broadcasts
 * `peer_left` and every peer tears down working audio. Longer than ~60 s is
 * not defensible because a stale ally sits at full volume for that whole
 * window. 30 s also keeps the connection warm through the ~60-100 s idle
 * timeout typical of reverse proxies, which is the very path whose silence
 * produces these half-open sockets.
 */
export const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * Floor for the HEARTBEAT_MS override. Below this the sweep costs more than the
 * zombies it reaps and the false-positive risk above becomes real.
 */
export const MIN_HEARTBEAT_MS = 100;

export class Heartbeat implements LivenessTracker {
  // A WeakMap rather than a patched-on `ws.isAlive`: same cost, no `as any`
  // against the `ws` types, and an untracked socket stays untracked.
  private alive = new WeakMap<PingableSocket, boolean>();

  /** Start watching a socket. Until this is called the socket is never pinged. */
  track(ws: PingableSocket): void {
    this.alive.set(ws, true);
  }

  /**
   * Record proof of life. Called for pongs and for every inbound message — an
   * in-game client streams `coords` at 10 Hz, so a playing client can never be
   * a false positive regardless of what its WebSocket stack does with pings.
   */
  markAlive(ws: PingableSocket): void {
    // Only for sockets already tracked, so this never enrolls one that
    // `track` deliberately skipped.
    if (this.alive.has(ws)) this.alive.set(ws, true);
  }

  /**
   * Terminate every tracked socket that has shown no life since the previous
   * sweep, and ping the rest. Returns how many were terminated.
   */
  sweep(sockets: Iterable<PingableSocket>): number {
    let terminated = 0;
    for (const ws of sockets) {
      const alive = this.alive.get(ws);
      if (alive === undefined) continue;
      if (!alive) {
        this.alive.delete(ws);
        // terminate(), not close(): the peer is by definition not answering,
        // so a close handshake would only wait out ws's 30 s close timeout.
        ws.terminate();
        terminated += 1;
        continue;
      }
      this.alive.set(ws, false);
      ws.ping();
    }
    return terminated;
  }
}
