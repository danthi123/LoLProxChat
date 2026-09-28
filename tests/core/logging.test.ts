// The buffering layer in src/core/logging.ts is module-singleton state that
// also patches the global console at import time, so every case reloads the
// module from a clean registry AND clears the cross-bundle global the buffer
// lives on. console is stubbed BEFORE the import so the module captures the
// stubs as its "originals" — that keeps the real runner output clean and lets
// a case assert pass-through.
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn(() => Promise.resolve()) }));

type Logging = typeof import('../../src/core/logging');

const LOG_STATE = Symbol.for('lolproxchat.logbuffer');
const globalSlots = globalThis as unknown as Record<symbol, unknown>;

type ConsoleMethod = 'log' | 'warn' | 'info' | 'error' | 'debug';
const METHODS: ConsoleMethod[] = ['log', 'warn', 'info', 'error', 'debug'];
let saved: Partial<Record<ConsoleMethod, typeof console.log>> = {};
let stubs: Partial<Record<ConsoleMethod, jest.Mock>> = {};

async function loadLogging(): Promise<{ logging: Logging; invoke: jest.Mock }> {
  jest.resetModules();
  delete globalSlots[LOG_STATE];
  const core = await import('@tauri-apps/api/core');
  const logging = await import('../../src/core/logging');
  return { logging, invoke: core.invoke as unknown as jest.Mock };
}

/** Strip the ISO timestamp + level prefix a buffered line carries. */
const body = (line: string): string => line.slice(line.indexOf('] ') + 2);
const linesOf = (invoke: jest.Mock, call: number): string[] => invoke.mock.calls[call][1].lines;
const allLines = (invoke: jest.Mock): string[] =>
  invoke.mock.calls.flatMap((c) => c[1].lines as string[]);

beforeEach(() => {
  jest.useFakeTimers();
  saved = {};
  stubs = {};
  for (const m of METHODS) {
    saved[m] = console[m];
    stubs[m] = jest.fn();
    console[m] = stubs[m]!;
  }
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  for (const m of METHODS) console[m] = saved[m]!;
  delete globalSlots[LOG_STATE];
});

describe('log buffering', () => {
  test('coalesces several lines into one batched IPC call, in order', async () => {
    const { logging, invoke } = await loadLogging();
    logging.setLoggingEnabled(true);

    for (const m of ['a', 'b', 'c', 'd', 'e']) console.log(m);

    // Before the fix this was five separate invoke('append_log', ...) calls.
    expect(invoke).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(250);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('append_log_lines');
    expect(linesOf(invoke, 0).map(body)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('still forwards to the real console', async () => {
    const { logging } = await loadLogging();
    logging.setLoggingEnabled(true);

    console.log('visible');

    expect(stubs.log).toHaveBeenCalledWith('visible');
  });

  test('an error ships at once, carrying the lines buffered before it', async () => {
    const { logging, invoke } = await loadLogging();
    logging.setLoggingEnabled(true);

    console.log('before-1');
    console.log('before-2');
    console.error('boom');

    await jest.advanceTimersByTimeAsync(0);

    expect(invoke).toHaveBeenCalledTimes(1);
    const lines = linesOf(invoke, 0);
    expect(lines.map(body)).toEqual(['before-1', 'before-2', 'boom']);
    expect(lines[2]).toContain('[error]');
  });

  test('a warn does NOT force a flush', async () => {
    const { logging, invoke } = await loadLogging();
    logging.setLoggingEnabled(true);

    // Tracking loss emits warns in bursts; flushing on each would collapse
    // batching back to one IPC per line exactly when the log is busiest.
    console.warn('position jump');
    await jest.advanceTimersByTimeAsync(0);
    expect(invoke).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(250);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(linesOf(invoke, 0).map(body)).toEqual(['position jump']);
  });

  test('flushes on the size trigger without waiting for the interval', async () => {
    const { logging, invoke } = await loadLogging();
    logging.setLoggingEnabled(true);

    for (let i = 0; i < 64; i++) console.log('line-' + i);
    await jest.advanceTimersByTimeAsync(0);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(linesOf(invoke, 0)).toHaveLength(64);
  });

  test('lines emitted during an in-flight flush go out next, once, in order', async () => {
    const { logging, invoke } = await loadLogging();
    let release: () => void = () => { /* replaced below */ };
    invoke.mockImplementationOnce(() => new Promise<void>((r) => { release = () => r(); }));
    logging.setLoggingEnabled(true);

    console.error('first');
    await jest.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(1);

    console.log('second');
    await jest.advanceTimersByTimeAsync(250);
    // Still exactly one call outstanding: the second batch is queued behind it.
    expect(invoke).toHaveBeenCalledTimes(1);

    release();
    await jest.advanceTimersByTimeAsync(250);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(linesOf(invoke, 0).map(body)).toEqual(['first']);
    expect(linesOf(invoke, 1).map(body)).toEqual(['second']);
  });

  test('caps the buffer and reports the gap in-band', async () => {
    const { logging, invoke } = await loadLogging();
    logging.setLoggingEnabled(true);

    for (let i = 0; i < 1005; i++) console.log('line-' + i);
    await jest.advanceTimersByTimeAsync(0);

    expect(invoke).toHaveBeenCalledTimes(1);
    const lines = linesOf(invoke, 0);
    // 1000 buffered + one marker line; without the cap the buffer would have
    // grown to 1005 (and unboundedly while an invoke is in flight).
    expect(lines).toHaveLength(1001);
    expect(body(lines[999])).toBe('line-999');
    expect(lines[1000]).toContain('5 lines dropped');
  });

  test('disabling flushes the tail and stops the interval', async () => {
    const { logging, invoke } = await loadLogging();
    logging.setLoggingEnabled(true);
    console.log('tail');

    logging.setLoggingEnabled(false);
    await jest.advanceTimersByTimeAsync(0);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(linesOf(invoke, 0).map(body)).toEqual(['tail']);

    await jest.advanceTimersByTimeAsync(10000);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('a throwing invoke does not kill logging for the rest of the session', async () => {
    const { logging, invoke } = await loadLogging();
    // A synchronous throw is the poisoning case: it rejects the chain itself,
    // not just the awaited call.
    invoke.mockImplementationOnce(() => { throw new Error('ipc gone'); });
    logging.setLoggingEnabled(true);

    console.error('first');
    await jest.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(1);

    console.log('after the failure');
    await jest.advanceTimersByTimeAsync(250);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(linesOf(invoke, 1).map(body)).toEqual(['after the failure']);
  });

  test('both module instances share one queue', async () => {
    // background.js and overlay.js are separate bundles loaded into the same
    // document, so core/logging exists twice. They must not hold two buffers.
    const first = await loadLogging();
    first.logging.setLoggingEnabled(true);
    console.log('from-first');

    jest.resetModules();
    const core = await import('@tauri-apps/api/core');
    const second = await import('../../src/core/logging');
    const invoke = core.invoke as unknown as jest.Mock;

    // Importing the second copy silences the console again, so it has to
    // re-enable before it can produce a line of its own.
    second.setLoggingEnabled(true);
    console.log('from-second');
    await second.flushLogBuffer();

    // The second copy's invoke ships BOTH lines: with a per-module buffer,
    // 'from-first' would still be stranded in the first copy's array.
    expect(allLines(invoke).map(body)).toEqual(['from-first', 'from-second']);
  });
});
