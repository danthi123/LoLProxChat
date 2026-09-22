// Stand-in for '@tauri-apps/api/event'. Mapped alongside the core module
// because the real one reaches the IPC bridge through its OWN relative import
// of './core', which a mapper keyed on the package path does not intercept.
//
// broadcastOverlayState emits at the 30 Hz tracking rate, so this has to be a
// cheap resolve rather than anything that allocates per call.

export interface EmittedEvent { event: string; payload: unknown }

export const emittedEvents: EmittedEvent[] = [];

// Bounded: the overlay refresh fires on every position tick, so an unbounded
// log would be the suite's largest allocation by far.
const MAX_RECORDED = 500;

export async function emit(event: string, payload?: unknown): Promise<void> {
  emittedEvents.push({ event, payload });
  if (emittedEvents.length > MAX_RECORDED) emittedEvents.shift();
}

export async function listen(): Promise<() => void> {
  return () => { /* nothing subscribes in the e2e */ };
}

export function resetEventFake(): void {
  emittedEvents.length = 0;
}
