import { getIceServers } from '../core/config';
import { getForceTurnRelay } from './privacy';

// Time-based EMA on per-peer volume targets. Damps CV-jitter spikes without
// introducing audible ramp delay on normal updates. Three properties:
//   • First call (prev == null) snaps to the new value so new peers don't
//     start playing at 1.0 before the proximity pipeline catches up.
//   • Getting LOUDER is slow. A long gap between updates (a peer re-entering
//     hearing range after being far away) must not snap to a loud value.
//   • Getting QUIETER is fast, and deliberately faster than it used to be.
//     The two directions are not symmetric in what they cost: a slow ramp up
//     protects the listener from a sudden blast, while a slow ramp down just
//     means hearing someone you should no longer hear. Measured on a real
//     session, a peer going out of range took a median 4.9 s to fall silent —
//     the hold window plus a ramp this gentle — which a tester reported as
//     still hearing an enemy about four seconds after panning the camera off
//     them. Falling quiet quickly has no audible downside; there is nothing to
//     startle.
// Exported so tests can verify the math without a real RTCPeerConnection.
const RISE_ALPHA_CAP = 0.3;
const FALL_ALPHA_CAP = 0.6;

export function nextSmoothedVolume(
  prev: number | null,
  target: number,
  nowMs: number,
  lastUpdateMs: number,
): number {
  const clamped = Math.max(0, Math.min(1, target));
  if (prev === null) return clamped;
  const dtSec = (nowMs - lastUpdateMs) / 1000;
  const cap = clamped < prev ? FALL_ALPHA_CAP : RISE_ALPHA_CAP;
  const alpha = Math.min(cap, 1 - Math.exp(-dtSec / 0.3));
  return prev * (1 - alpha) + clamped * alpha;
}


/**
 * Render an ICE candidate as `type addr:port proto` for diagnostic logs.
 * Parses the SDP "candidate:..." line because not every browser exposes the
 * convenience getters (.address, .type, etc.) on RTCIceCandidate.
 */
function describeCandidate(c: RTCIceCandidateInit | null): string {
  if (!c) return 'end-of-candidates';
  const cand = c.candidate || '';
  if (!cand) return 'end-of-candidates';
  const parts = cand.split(' ');
  // Format: "candidate:foundation component proto priority addr port typ TYPE ..."
  const proto = parts[2] || '?';
  const addr = parts[4] || '?';
  const port = parts[5] || '?';
  const typeIdx = parts.indexOf('typ');
  const type = typeIdx > 0 ? parts[typeIdx + 1] : '?';
  return `${type} ${addr}:${port} ${proto.toLowerCase()}`;
}

export class PeerConnection {
  private pc: RTCPeerConnection;
  private remoteStream: MediaStream = new MediaStream();
  private audioElement: HTMLAudioElement;
  // Output device the user picked, and the one actually in effect on the
  // element. Kept apart so applySinkId() can retry without re-setting a sink
  // that already took.
  private desiredSinkId: string | null = null;
  private appliedSinkId: string | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;
  readonly remoteName: string;

  // Playback is element-only: the remote stream plays through `audioElement`,
  // whose .volume carries the proximity gain. An earlier parallel WebAudio
  // gain-node path was removed — the muted element wasn't reliably silent in
  // WebView2, so both played at once, causing echo/double + a muddied level
  // (issues #19 / #21).
  // Default to silent. Volume is supposed to come from the proximity pipeline
  // (applyPeerVolumes → setVolume). If a peer connects before that pipeline
  // has produced a value for them (e.g. during tracking SCANNING state where
  // only allies get a volume), defaulting to 1.0 would play them at full
  // volume regardless of in-game distance — exactly the "hear across the
  // map at startup" bug reported on #6 / #7.
  private targetVolume = 0;
  private muted = false;
  // Outer-loop EMA on volume targets so brief CV tracking glitches don't
  // produce audible dropouts. null = first call (snap to value, no smoothing).
  private smoothedVolume: number | null = null;
  private lastSetVolumeMs = 0;

  onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;
  // Fired when ICE has fully failed. The audio layer is responsible for
  // re-issuing an offer (initiator side only) so we don't restart from both
  // ends and race. Capped retry counter lives here to avoid loops.
  onIceFailed: (() => void) | null = null;
  iceRestartAttempts = 0;
  static readonly MAX_ICE_RESTARTS = 2;

  private constructor(
    remoteName: string,
    iceServers: RTCIceServer[],
    iceTransportPolicy: RTCIceTransportPolicy = 'all',
  ) {
    this.remoteName = remoteName;
    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
    if (iceTransportPolicy === 'relay') {
      console.log('[WebRTC] Forcing TURN relay for', remoteName, '— no direct P2P candidates will be used');
    }
    this.audioElement = new Audio();
    this.audioElement.autoplay = true;
    this.audioElement.srcObject = this.remoteStream;
    // Start silent; the proximity pipeline (applyPeerVolumes → setVolume) sets
    // the real gain. The element is the sole audible path (see field comment).
    this.audioElement.volume = 0;

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        console.log('[WebRTC] Local ICE → ' + remoteName + ':', describeCandidate(event.candidate.toJSON()));
        this.onIceCandidate(event.candidate);
      } else if (!event.candidate) {
        console.log('[WebRTC] Local ICE gathering complete for ' + remoteName);
      }
    };

    this.pc.ontrack = (event) => {
      console.log('[WebRTC] Got remote track from', remoteName, 'kind:', event.track.kind);
      this.remoteStream.addTrack(event.track);
      // Ensure audio plays (autoplay may be blocked by Chromium policy)
      this.tryPlay();
      // Re-apply the output device now that the element has a live track.
      // Chromium rejects setSinkId with AbortError on an element whose stream
      // is still empty, which is exactly when connectToPeer used to call it —
      // NotOtakuu's 2026-09-12 log shows the failure ~230ms before the track
      // arrived, silently leaving that peer on the default device.
      void this.applySinkId();
    };

    this.pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state with', remoteName, ':', this.pc.connectionState);
      if (this.pc.connectionState === 'connected') {
        // Successful (re)connect — reset the restart budget for any future failure.
        this.iceRestartAttempts = 0;
      }
      if (this.pc.connectionState === 'failed' &&
          this.iceRestartAttempts < PeerConnection.MAX_ICE_RESTARTS) {
        this.iceRestartAttempts++;
        console.warn('[WebRTC] Connection failed with', remoteName,
          '— triggering ICE restart attempt', this.iceRestartAttempts);
        this.onIceFailed?.();
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE state with', remoteName, ':', this.pc.iceConnectionState);
    };

    this.startStatsLogging();
  }

  static async create(remoteName: string): Promise<PeerConnection> {
    const iceServers = await getIceServers();
    const policy: RTCIceTransportPolicy = getForceTurnRelay() ? 'relay' : 'all';
    return new PeerConnection(remoteName, iceServers, policy);
  }

  /** Route this peer's audio to the chosen output device via the element sink. */
  async setOutputDevice(deviceId: string | null): Promise<void> {
    this.desiredSinkId = deviceId;
    await this.applySinkId();
  }

  /**
   * Push `desiredSinkId` onto the audio element. Safe to call repeatedly — it's
   * retried from ontrack because setSinkId only reliably succeeds once the
   * element has a track to route.
   */
  private async applySinkId(): Promise<void> {
    const el = this.audioElement as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof el.setSinkId !== 'function') return;
    // '' is Chromium's "system default device". Picking Default in Settings
    // used to be a no-op here, leaving peers stuck on the previously chosen
    // device until the next session.
    const sink = this.desiredSinkId ?? '';
    if (this.appliedSinkId === sink) return;
    try {
      await el.setSinkId(sink);
      this.appliedSinkId = sink;
    } catch (e) {
      // Not fatal and not necessarily final — ontrack retries once the stream
      // is live. Logged at debug volume so a first-attempt miss isn't alarming.
      console.log('[WebRTC] setSinkId deferred for ' + this.remoteName + ':', e);
    }
  }

  private applyGain(value: number): void {
    // Element-only playback. Per-tick EMA smoothing (setVolume) keeps the steps
    // small enough to be click-free without WebAudio ramping.
    this.audioElement.volume = Math.max(0, Math.min(1, value));
  }

  private tryPlay(): void {
    this.audioElement.play().catch((err) => {
      // Autoplay blocked by browser policy — retry on next user gesture.
      // Log explicitly so a user reporting "voice doesn't work" with Debug on
      // can be told to click anywhere in the overlay to unblock playback.
      console.warn('[WebRTC] Autoplay blocked for', this.remoteName,
        '— will retry on next user gesture:', err?.name || err);
      const resume = () => {
        this.audioElement.play().catch((retryErr) => {
          console.warn('[WebRTC] Autoplay retry still blocked for', this.remoteName, ':',
            retryErr?.name || retryErr);
        });
        document.removeEventListener('click', resume);
        document.removeEventListener('keydown', resume);
      };
      document.addEventListener('click', resume, { once: true });
      document.addEventListener('keydown', resume, { once: true });
    });
  }

  addLocalStream(stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) {
      this.pc.addTrack(track, stream);
    }
  }

  async createOffer(options?: { iceRestart?: boolean }): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer(options);
    offer.sdp = this.enhanceOpusSdp(offer.sdp || '');
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
    const answer = await this.pc.createAnswer();
    answer.sdp = this.enhanceOpusSdp(answer.sdp || '');
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /**
   * Modify SDP to set Opus bitrate to 128kbps and disable DTX.
   * DTX (Discontinuous Transmission) stops sending packets during silence
   * to save bandwidth, but the ramp out of silence-mode at speech onset
   * clips the first packet or two — audible as missing word starts. The
   * bandwidth cost of always-on transmission is trivial for voice.
   */
  private enhanceOpusSdp(sdp: string): string {
    return sdp.replace(
      /a=fmtp:111 (.*)/g,
      (match, params) => {
        let enhanced = params;
        if (!enhanced.includes('maxaveragebitrate')) {
          enhanced += ';maxaveragebitrate=128000';
        }
        // Explicitly disable DTX so word starts/ends aren't clipped.
        if (!enhanced.includes('usedtx')) {
          enhanced += ';usedtx=0';
        }
        return 'a=fmtp:111 ' + enhanced;
      }
    );
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    console.log('[WebRTC] Remote ICE ← ' + this.remoteName + ':', describeCandidate(candidate));
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  private async flushPendingCandidates(): Promise<void> {
    for (const c of this.pendingCandidates) {
      await this.pc.addIceCandidate(new RTCIceCandidate(c));
    }
    this.pendingCandidates = [];
  }

  setVolume(volume: number): void {
    const now = performance.now();
    this.smoothedVolume = nextSmoothedVolume(this.smoothedVolume, volume, now, this.lastSetVolumeMs);
    this.lastSetVolumeMs = now;
    this.targetVolume = this.smoothedVolume;
    if (!this.muted) this.applyGain(this.smoothedVolume);
  }

  mute(): void {
    this.muted = true;
    this.audioElement.muted = true;
  }

  unmute(): void {
    this.muted = false;
    this.audioElement.muted = false;
    this.applyGain(this.targetVolume);
  }

  close(): void {
    if (this.statsIntervalId !== null) {
      clearInterval(this.statsIntervalId);
      this.statsIntervalId = null;
    }
    this.remoteStream.getTracks().forEach((t) => t.stop());
    this.pc.close();
    this.audioElement.pause();
    this.audioElement.srcObject = null;
  }

  // Periodic getStats snapshot — selected candidate pair, RTT, bytes flowing.
  // Logged via the standard console.log path which is gated by Debug toggle.
  // Without these, ICE failures are opaque (we only see "failed" with no
  // context about which pair was tried or what the RTT looked like).
  private statsIntervalId: number | null = null;
  private startStatsLogging(): void {
    this.statsIntervalId = window.setInterval(() => {
      this.logStatsSnapshot().catch(() => { /* non-fatal */ });
    }, 10_000) as unknown as number;
  }

  private async logStatsSnapshot(): Promise<void> {
    const stats = await this.pc.getStats();
    let pair: any = null;
    let outAudio: any = null;
    let inAudio: any = null;
    const byId = new Map<string, any>();
    stats.forEach((r: any) => {
      byId.set(r.id, r);
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
      if (r.type === 'outbound-rtp' && r.kind === 'audio') outAudio = r;
      if (r.type === 'inbound-rtp' && r.kind === 'audio') inAudio = r;
    });
    const parts: string[] = [
      'conn=' + this.pc.connectionState,
      'ice=' + this.pc.iceConnectionState,
    ];
    if (pair) {
      const local = byId.get(pair.localCandidateId);
      const remote = byId.get(pair.remoteCandidateId);
      const fmt = (c: any) => c ? `${c.candidateType}:${c.address || c.ip || '?'}:${c.port || '?'}/${c.protocol || '?'}` : '?';
      parts.push('pair=' + fmt(local) + '<->' + fmt(remote));
      if (typeof pair.currentRoundTripTime === 'number') {
        parts.push('rtt=' + Math.round(pair.currentRoundTripTime * 1000) + 'ms');
      }
    } else {
      parts.push('pair=none');
    }
    if (outAudio) parts.push('outBytes=' + outAudio.bytesSent);
    if (inAudio) parts.push('inBytes=' + inAudio.bytesReceived);
    if (inAudio && typeof inAudio.packetsLost === 'number') parts.push('lost=' + inAudio.packetsLost);
    console.log('[WebRTC stats]', this.remoteName, parts.join(' '));
  }
}
