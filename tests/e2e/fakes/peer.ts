// A PeerConnection stand-in that completes the SDP/ICE handshake over the real
// signaling channel — real SignalingService, real WebSocket, real server relay —
// without WebRTC.
//
// The envelope path is the part worth exercising: builds before v0.4 sent the
// raw SDP with no wrapper, which happened to work for offers and answers (an
// SDP carries its own `.type`) and silently dropped every ICE candidate. That
// asymmetry is invisible to a unit test of either side alone.

export interface FakeIceCandidate {
  toJSON(): { candidate: string };
}

export class FakePeerConnection {
  volume = 1;
  readonly volumes: number[] = [];
  muted = false;
  closed = false;
  offersCreated = 0;
  offersHandled = 0;
  answersHandled = 0;
  readonly remoteCandidates: unknown[] = [];
  readonly localStreams: unknown[] = [];
  outputDeviceId: string | null = null;

  onIceCandidate: ((candidate: FakeIceCandidate) => void) | null = null;
  onIceFailed: (() => void) | null = null;

  constructor(readonly owner: string, readonly remoteName: string) {}

  async setOutputDevice(id: string | null): Promise<void> { this.outputDeviceId = id; }
  addLocalStream(stream: unknown): void { this.localStreams.push(stream); }

  async createOffer(_options?: { iceRestart?: boolean }): Promise<{ type: string; sdp: string }> {
    this.offersCreated++;
    this.trickleOne();
    return { type: 'offer', sdp: 'fake-offer-from-' + this.owner };
  }

  async handleOffer(_payload: unknown): Promise<{ type: string; sdp: string }> {
    this.offersHandled++;
    this.trickleOne();
    return { type: 'answer', sdp: 'fake-answer-from-' + this.owner };
  }

  async handleAnswer(_payload: unknown): Promise<void> { this.answersHandled++; }
  async addIceCandidate(payload: unknown): Promise<void> { this.remoteCandidates.push(payload); }

  // Records the TARGET the proximity pipeline asked for, with no glide. The
  // real class separates the two — setVolume names a destination and stepVolume
  // walks towards it on a timer — but an e2e assertion is about what the server
  // decided this peer should be, not how many frames the gain took to get
  // there, and a fake that reproduced the ramp would make every assertion a
  // timing race.
  setVolume(volume: number): void { this.volume = volume; this.volumes.push(volume); }
  /** No-op: this fake is already at its target the moment it is set. */
  stepVolume(_nowMs: number): void { /* nothing to glide */ }
  mute(): void { this.muted = true; }
  unmute(): void { this.muted = false; }
  close(): void { this.closed = true; }

  /** One candidate, on a later turn — the real gatherer is never synchronous. */
  private trickleOne(): void {
    setTimeout(() => {
      this.onIceCandidate?.({
        toJSON: () => ({ candidate: 'fake-candidate-from-' + this.owner }),
      });
    }, 0);
  }
}
