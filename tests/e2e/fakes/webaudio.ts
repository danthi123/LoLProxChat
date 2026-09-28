// WebAudio + getUserMedia stand-ins, so the REAL AudioService runs in the e2e.
//
// initMicrophone, the gain chain, the 2s level monitor and cleanup() are where
// the v0.5.8 audio bugs lived; faking AudioService wholesale would have the
// suite assert on its own double. These nodes do no signal processing — they
// exist so the real wiring code has something to wire.

class FakeAudioTrack {
  enabled = true;
  stopped = false;
  stop(): void { this.stopped = true; }
}

export class FakeMediaStream {
  readonly tracks = [new FakeAudioTrack()];
  getAudioTracks(): FakeAudioTrack[] { return this.tracks; }
  // cleanup() and applyInputDevice() both reach for getTracks(), not
  // getAudioTracks(); without it teardown dies inside cleanup with a TypeError
  // that reads like a leak.
  getTracks(): FakeAudioTrack[] { return this.tracks; }
}

class FakeNode {
  connect(): void { /* graph shape is irrelevant here */ }
  disconnect(): void { /* ditto */ }
}

class FakeAnalyser extends FakeNode {
  fftSize = 1024;
  getFloatTimeDomainData(buf: Float32Array): void { buf.fill(0); }
}

export class FakeAudioContext {
  state: AudioContextState = 'running';
  readonly created = { analysers: 0, gains: 0, destinations: 0 };
  private closed = false;

  async resume(): Promise<void> { this.state = 'running'; }
  async close(): Promise<void> { this.closed = true; this.state = 'closed'; }
  isClosed(): boolean { return this.closed; }

  createMediaStreamSource(_s: unknown): FakeNode { return new FakeNode(); }
  createGain(): { gain: { value: number }; connect(): void } {
    this.created.gains++;
    return { gain: { value: 1 }, connect: () => { /* sink */ } };
  }
  createMediaStreamDestination(): { stream: FakeMediaStream } {
    this.created.destinations++;
    return { stream: new FakeMediaStream() };
  }
  createAnalyser(): FakeAnalyser { this.created.analysers++; return new FakeAnalyser(); }
}

/** Every AudioContext built since the last reset, for teardown assertions. */
export const audioContexts: FakeAudioContext[] = [];

export function installWebAudioFakes(): void {
  const g = globalThis as any;
  g.AudioContext = function FakeAudioContextCtor(this: unknown) {
    const ctx = new FakeAudioContext();
    audioContexts.push(ctx);
    return ctx;
  } as unknown as typeof AudioContext;

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        getUserMedia: async () => new FakeMediaStream(),
        enumerateDevices: async () => [],
      },
    },
    configurable: true,
    writable: true,
  });
}
