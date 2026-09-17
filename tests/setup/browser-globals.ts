// The app runs in WebView2, so production code refers to browser globals that
// node only grew later — `WebSocket` became a global in node 22, and CI pins 20
// for the client job while a contributor's machine may be on anything. Without
// this, `signaling.ts`'s `readyState === WebSocket.OPEN` throws a
// ReferenceError under the older runtime even though `this.ws` is null, because
// `===` evaluates its right operand regardless.
//
// Only the readyState constants are ever read without a live socket; a test
// that needs real socket behaviour builds its own fake.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket?: unknown }).WebSocket = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  };
}

export {};
