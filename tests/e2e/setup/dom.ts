// The browser surface the orchestrator and its services actually touch, as
// ~40 lines of node-side shims.
//
// The e2e suite runs in jest's NODE environment, not jsdom, and that is a
// deliberate choice rather than a shortcut: under jsdom `fetch`, `WebSocket`
// and `AbortController` come from three different realms, and volume-client.ts
// hands an AbortSignal straight into fetch — which rejects a foreign one with a
// webidl TypeError that orchestrator.ts swallows as "Volume computation
// failed". Every proximity assertion would then fail as an opaque timeout. In
// node those three are one consistent set, and what is left to fake is the
// handful of `window.*` calls below.
//
// Shared with tests/services/orchestrator-lifecycle.test.ts, which drives the
// same lifecycle code on fake timers.

class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** Idempotent — setupFiles runs per test file and the shims are process-wide. */
export function installDomShims(): void {
  const g = globalThis as any;
  if (g.__proxchatDomShims) return;
  g.__proxchatDomShims = true;

  // An EventTarget, not a bare object: orchestrator.broadcastOverlayState
  // dispatches real CustomEvents on it and the overlay listens for them, so a
  // test can observe the panel payload exactly as the UI would.
  const win: any = new EventTarget();
  win.setInterval = (fn: () => void, ms?: number) => setInterval(fn, ms);
  win.clearInterval = (id: unknown) => clearInterval(id as any);
  win.setTimeout = (fn: () => void, ms?: number) => setTimeout(fn, ms);
  win.clearTimeout = (id: unknown) => clearTimeout(id as any);
  define('window', win);

  // node exposes a `localStorage` that throws unless the process was started
  // with --localstorage-file, so it has to be replaced rather than left alone.
  define('localStorage', new MemoryStorage());
}

/** Between tests: preferences are process-global (see audio-prefs.ts). */
export function clearStoredPrefs(): void {
  (globalThis as any).localStorage?.clear();
}
