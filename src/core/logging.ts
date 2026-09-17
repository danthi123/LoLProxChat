// Console log toggling — silenced by default, re-enabled when the user
// turns on Debug in the overlay. When enabled, console output is ALSO
// forwarded to a file on disk via the Rust append_log_lines command so that
// release builds (which have no dev-tools access) can still be inspected.
//
// console.error always passes through to the real console; it only
// writes to the file when Debug is on.
//
// Lines are buffered and shipped in batches: one IPC round trip per batch
// instead of one per console call, and — because at most one call is ever in
// flight — the file receives them in emission order, which the old
// fire-and-forget per-line invoke never guaranteed.

import { invoke } from '@tauri-apps/api/core';

const noop = (): void => { /* swallowed */ };

type ConsoleWriter = (...args: any[]) => void;

// Quarter-second is under human reaction time for a "did it log?" check while
// still coalescing a 30 Hz tracking tick's chatter into one write.
const FLUSH_INTERVAL_MS = 250;
// Ship early on a burst so one batch stays a reasonable IPC payload.
const FLUSH_AT_LINES = 64;
// Hard ceiling. A runaway log loop must not grow the buffer without bound
// while an invoke is in flight; the overflow count is reported in-band so a
// gap in the file is never silent.
const MAX_BUFFERED_LINES = 1000;

interface LogBufferState {
  /** The un-patched console, captured before any copy of this module wrapped it. */
  originals: Record<'log' | 'warn' | 'info' | 'error' | 'debug', ConsoleWriter>;
  lines: string[];
  dropped: number;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: Promise<void>;
  /** A drain is queued on the chain; further triggers must not queue another. */
  scheduled: boolean;
  unloadHooked: boolean;
}

// webpack emits background.js and overlay.js as separate bundles and
// overlay.html loads BOTH into the same window, so this module exists twice in
// one document while `console` is global. Two module-scoped buffers would
// interleave two independent batches into one file. Hanging the state off a
// well-known global symbol makes the single-queue ordering guarantee
// structural rather than an accident of which bundle enables logging.
const STATE_KEY = Symbol.for('lolproxchat.logbuffer');
const globalSlots = globalThis as unknown as Record<symbol, LogBufferState | undefined>;

const state: LogBufferState = globalSlots[STATE_KEY] ?? {
  // Captured by whichever copy loads first, i.e. while console is still
  // pristine. A second copy capturing the already-patched functions would
  // write every line twice and could end up wrapping a noop.
  originals: {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  },
  lines: [],
  dropped: 0,
  timer: null,
  inFlight: Promise.resolve(),
  scheduled: false,
  unloadHooked: false,
};
globalSlots[STATE_KEY] = state;

function formatArgs(args: any[]): string {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

/**
 * Drain the buffer into one IPC call. Chained onto the previous flush so at
 * most one call is outstanding; the splice happens INSIDE the chained callback
 * so lines produced mid-flight go out in the next batch, still in order.
 */
export function flushLogBuffer(): Promise<void> {
  if (state.scheduled) return state.inFlight;
  if (state.lines.length === 0 && state.dropped === 0) return state.inFlight;
  state.scheduled = true;

  state.inFlight = state.inFlight
    .then(() => {
      state.scheduled = false;
      const lines = state.lines.splice(0, state.lines.length);
      if (state.dropped > 0) {
        lines.push(`${new Date().toISOString()} [warn] [logging] ${state.dropped} lines dropped (buffer full)`);
        state.dropped = 0;
      }
      if (lines.length === 0) return;
      return invoke('append_log_lines', { lines }) as Promise<void>;
    })
    // Terminating the chain matters: a rejected `inFlight` would skip every
    // later flush for the rest of the session, killing file logging silently.
    .catch(() => { state.scheduled = false; });

  return state.inFlight;
}

function writeToFile(level: string, args: any[]): void {
  const ts = new Date().toISOString();
  if (state.lines.length >= MAX_BUFFERED_LINES) {
    state.dropped++;
  } else {
    state.lines.push(`${ts} [${level}] ${formatArgs(args)}`);
  }

  // Errors ship at once — they are what a bug report is opened about. warn
  // deliberately does not: the position-jump and hold-exceeded warnings fire
  // in bursts during tracking loss, which would collapse batching back to one
  // IPC per line exactly when the log is busiest.
  if (level === 'error' || state.lines.length >= FLUSH_AT_LINES) {
    void flushLogBuffer();
  }
}

function makeWrapper(orig: ConsoleWriter, level: string) {
  return (...args: any[]) => {
    orig(...args);
    writeToFile(level, args);
  };
}

// Initial state mirrors what console actually does (un-patched).
// We immediately silence at module-load below so anything imported
// after this module sees a silent console.
let enabled = true;

export function setLoggingEnabled(value: boolean): void {
  if (value === enabled) return;
  enabled = value;
  if (value) {
    console.log = makeWrapper(state.originals.log, 'log');
    console.warn = makeWrapper(state.originals.warn, 'warn');
    console.info = makeWrapper(state.originals.info, 'info');
    console.error = makeWrapper(state.originals.error, 'error');
    console.debug = makeWrapper(state.originals.debug, 'debug');
    if (state.timer === null) {
      state.timer = setInterval(() => { void flushLogBuffer(); }, FLUSH_INTERVAL_MS);
    }
    // Best-effort only, and it does not cover the ordinary quit path: closing
    // the panel tears the process down from Rust (on_window_event →
    // app_handle().exit(0)), so up to FLUSH_INTERVAL_MS of buffered
    // informational lines are lost on a normal exit.
    if (!state.unloadHooked && typeof window !== 'undefined') {
      state.unloadHooked = true;
      window.addEventListener('pagehide', () => { void flushLogBuffer(); });
    }
  } else {
    console.log = noop;
    console.warn = noop;
    console.info = noop;
    // console.error always passes through to the real console, just not to the file
    console.error = state.originals.error;
    console.debug = noop;
    // Tail first, or it sits in the buffer until logging is re-enabled.
    void flushLogBuffer();
    if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }
}

export function isLoggingEnabled(): boolean {
  return enabled;
}

// Silence at module load — anything that imports this gets a quiet console.
setLoggingEnabled(false);
