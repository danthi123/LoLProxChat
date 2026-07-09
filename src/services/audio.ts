import { PeerConnection } from './peer-connection';
import { SignalingService, SignalMessage } from './signaling';
import { AudioSettings } from '../core/types';
import { getStoredInputDeviceId, getStoredOutputDeviceId } from './devices';

function peakRms(buf: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) {
    sumSq += buf[i] * buf[i];
  }
  return Math.sqrt(sumSq / buf.length);
}

/**
 * Compute the per-peer audio gain by combining the server-returned proximity
 * volume with the user's per-player slider preference. Exported so the
 * slider-fix logic (issue #7) can be unit-tested without spinning up
 * AudioService + its PeerConnection / WebAudio dependencies.
 *
 * Both inputs are clamped to [0, 1] defensively. The output is their product.
 */
export function computeFinalPeerVolume(proximityVol: number, sliderVol: number): number {
  const p = Math.max(0, Math.min(1, proximityVol));
  const s = Math.max(0, Math.min(1, sliderVol));
  return p * s;
}

/**
 * Resolve a target proximity volume for every peer that needs one: the union
 * of peers present in the server response and currently-connected peers.
 *
 * Connected peers that are ABSENT from the response are silenced (0). The
 * v0.3 server omits peers it filtered out (cross-team beyond the hearing cap,
 * or stale position) from the response entirely, so a missing entry means
 * "not audible" — NOT "leave unchanged". Without this, a peer once heard
 * within range stays stuck at its last gain forever after moving out of
 * range (the "enemy hears me no matter where on the map" bug: the server
 * correctly drops them, the client failed to act on the absence). In v0.2
 * the server always included far peers at volume 0, so the client never had
 * to handle absence.
 *
 * `grace` (optional) softens that absence: if a peer was in the response very
 * recently (within `graceMs`), HOLD its last volume instead of dropping to 0.
 * A single dropped coords packet — common on lossy / DPI-bypass tunnels (#27)
 * — briefly removes a peer from the response; without the grace that blips the
 * audio to silence and straight back, which reads as the volume "flapping".
 * After the window elapses the peer falls to 0 and the caller's EMA fades it.
 *
 * Exported for unit testing without AudioService's WebAudio dependencies.
 */
export function resolveProximityTargets(
  responseVolumes: Record<string, number>,
  connectedPeerNames: Iterable<string>,
  grace?: {
    lastVolumes: Map<string, number>;
    lastSeenMs: Map<string, number>;
    now: number;
    graceMs: number;
  },
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, v] of Object.entries(responseVolumes)) out.set(name, v);
  for (const name of connectedPeerNames) {
    if (out.has(name)) continue;
    if (grace) {
      const seen = grace.lastSeenMs.get(name);
      if (seen !== undefined && grace.now - seen <= grace.graceMs) {
        out.set(name, grace.lastVolumes.get(name) ?? 0);
        continue;
      }
    }
    out.set(name, 0);
  }
  return out;
}

// How long to keep a peer at its last proximity volume after it drops out of
// the server response before fading to 0. Covers a dropped coords packet or two
// on a lossy / DPI-bypass connection so the audio doesn't blip to silence and
// back (#27).
const PROXIMITY_GRACE_MS = 1500;

export class AudioService {
  private localStream: MediaStream | null = null;
  private peers: Map<string, PeerConnection> = new Map();
  private signaling: SignalingService;
  private localName: string;
  private selfMuted = false;
  private muteAll = false;
  private mutedPlayers: Set<string> = new Set();
  // Track last reported volume state per peer so we only log transitions
  private lastAppliedVolume: Map<string, string> = new Map();
  // Last proximity volume the server returned for each peer. Used by
  // setPlayerVolume so the slider applies on top of real distance, not a
  // hardcoded 1.0. Updated on every applyPeerVolumes tick.
  private lastProximityVolumes: Map<string, number> = new Map();
  // performance.now() of the last tick each peer appeared in the server
  // response — drives the proximity grace window (see PROXIMITY_GRACE_MS, #27).
  private lastSeenInResponseMs: Map<string, number> = new Map();
  // Throttling state for the verbose applyPeerVolumes snapshot log
  private lastVolumeLogLine = '';
  private lastVolumeLogMs = 0;
  private settings: AudioSettings = {
    // Always-open by default. Push-to-talk is unbound by default (#27) and
    // bound in Settings; the real PTT keybind lives in the overlay (localStorage
    // `lolproxchat.pttVk`) + the Rust hook, not this (vestigial) field.
    inputMode: 'always',
    inputVolume: 1.0,
    pttKey: '',
    playerVolumes: {},
  };

  // Audio processing state
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private outputStream: MediaStream | null = null;
  // Held so we can swap it when the user picks a different input device at
  // runtime without renegotiating WebRTC (the destination MediaStream that
  // PeerConnections received stays the same).
  private micSource: MediaStreamAudioSourceNode | null = null;

  // Guard against concurrent connectToPeer calls for the same peer
  private connectingPeers: Set<string> = new Set();
  // Buffer signals that arrive before the peer connection is created
  private pendingSignals: Map<string, SignalMessage[]> = new Map();

  // PTT state
  private pttHeld = false;

  constructor(signaling: SignalingService, localName: string) {
    this.signaling = signaling;
    this.localName = localName;
  }

  async initMicrophone(): Promise<void> {
    this.localStream = await this.acquireMicStream();

    this.audioContext = new AudioContext();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    // Honor stored output-device pick if AudioContext.setSinkId is available
    // (Chromium 110+, which WebView2 evergreen ships).
    await this.applyStoredOutputDevice();

    this.micSource = this.audioContext.createMediaStreamSource(this.localStream);
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.settings.inputVolume;
    const destination = this.audioContext.createMediaStreamDestination();

    // Simple straight-through chain: mic → gain → destination. Noise
    // suppression is handled by the browser's native DSP (set via the
    // getUserMedia constraints above) which runs off the JS main thread.
    this.micSource.connect(this.gainNode);
    this.gainNode.connect(destination);
    console.log('[Audio] Using native browser noise suppression');

    this.outputStream = destination.stream;
    // Apply initial transmit state through the normal path so the first
    // [Audio] Local mic transmit log line is emitted.
    this.updateLocalTrackState();

    // Attach analysers to monitor whether the mic is actually producing audio
    // and whether the WebRTC-output stream contains audio. Reported every 2s.
    this.startAudioLevelMonitor(this.micSource, destination);
  }

  private micLevelAnalyser: AnalyserNode | null = null;
  private outputLevelAnalyser: AnalyserNode | null = null;
  private levelMonitorId: number | null = null;

  private startAudioLevelMonitor(
    micSource: MediaStreamAudioSourceNode,
    outputDest: MediaStreamAudioDestinationNode,
  ): void {
    if (!this.audioContext) return;
    this.micLevelAnalyser = this.audioContext.createAnalyser();
    this.micLevelAnalyser.fftSize = 1024;
    micSource.connect(this.micLevelAnalyser);

    // The destination node is a sink — to monitor its output we need to
    // re-source from its stream via a second source node.
    const outSource = this.audioContext.createMediaStreamSource(outputDest.stream);
    this.outputLevelAnalyser = this.audioContext.createAnalyser();
    this.outputLevelAnalyser.fftSize = 1024;
    outSource.connect(this.outputLevelAnalyser);

    const micBuf = new Float32Array(this.micLevelAnalyser.fftSize);
    const outBuf = new Float32Array(this.outputLevelAnalyser.fftSize);

    this.levelMonitorId = window.setInterval(() => {
      if (!this.micLevelAnalyser || !this.outputLevelAnalyser) return;
      this.micLevelAnalyser.getFloatTimeDomainData(micBuf);
      this.outputLevelAnalyser.getFloatTimeDomainData(outBuf);
      const micPeak = peakRms(micBuf);
      const outPeak = peakRms(outBuf);
      const transmitting = !this.selfMuted && this.isTransmitting();
      console.log(
        '[Audio] mic=' + micPeak.toFixed(3) +
        ' out=' + outPeak.toFixed(3) +
        ' transmit=' + transmitting +
        ' inputMode=' + this.settings.inputMode +
        ' selfMuted=' + this.selfMuted,
      );
    }, 2000) as unknown as number;
  }

  private isTransmitting(): boolean {
    if (this.selfMuted) return false;
    if (this.settings.inputMode === 'ptt') return this.pttHeld;
    // 'always' (default) — transmit unless muted
    return true;
  }

  setPTTState(held: boolean): void {
    console.log('[Audio] setPTTState(' + held + '), inputMode=' + this.settings.inputMode);
    this.pttHeld = held;
    this.updateLocalTrackState();
  }

  private lastTrackEnabled: boolean | null = null;
  private updateLocalTrackState(): void {
    if (!this.outputStream) return;
    const enabled = !this.selfMuted && this.isTransmitting();
    for (const track of this.outputStream.getAudioTracks()) {
      track.enabled = enabled;
    }
    if (enabled !== this.lastTrackEnabled) {
      this.lastTrackEnabled = enabled;
      const reason = this.selfMuted
        ? 'selfMuted'
        : this.settings.inputMode === 'ptt'
          ? 'ptt=' + this.pttHeld
          : 'always-open';
      console.log('[Audio] Local mic transmit → ' + enabled + ' (' + reason + ')');
    }
  }

  // Connect to a new peer
  async connectToPeer(remoteName: string, isInitiator?: boolean): Promise<void> {
    if (this.peers.has(remoteName) || this.connectingPeers.has(remoteName)) return;
    this.connectingPeers.add(remoteName);

    console.log('[Audio] Connecting to peer:', remoteName);
    let peer: PeerConnection;
    try {
      peer = await PeerConnection.create(remoteName);
      void peer.setOutputDevice(getStoredOutputDeviceId());
    } catch (e) {
      this.connectingPeers.delete(remoteName);
      throw e;
    }
    this.peers.set(remoteName, peer);
    this.connectingPeers.delete(remoteName);

    if (this.outputStream) {
      peer.addLocalStream(this.outputStream);
    }

    peer.onIceCandidate = (candidate) => {
      this.signaling.sendSignal({
        type: 'ice-candidate',
        from: this.localName,
        to: remoteName,
        payload: candidate.toJSON(),
      });
    };

    // Initiator creates data channel + offer
    const shouldInitiate = isInitiator ?? (this.localName < remoteName);

    // Auto-recover from ICE failure. Only the original initiator re-issues
    // the offer (with iceRestart=true) so we don't both restart and race.
    // The other side just handles the incoming offer via the normal flow.
    if (shouldInitiate) {
      peer.onIceFailed = () => {
        peer.createOffer({ iceRestart: true })
          .then((offer) => {
            console.log('[Audio] Sending ICE-restart offer to:', remoteName);
            this.signaling.sendSignal({
              type: 'offer',
              from: this.localName,
              to: remoteName,
              payload: offer,
            });
          })
          .catch((e) => console.warn('[Audio] ICE-restart offer failed for', remoteName, e));
      };
    }

    if (shouldInitiate) {
      console.log('[Audio] Creating offer (initiator) to:', remoteName);
      try {
        const offer = await peer.createOffer();
        this.signaling.sendSignal({
          type: 'offer',
          from: this.localName,
          to: remoteName,
          payload: offer,
        });
      } catch (e) {
        console.error('[Audio] Failed to create offer for:', remoteName, e);
        this.peers.delete(remoteName);
        peer.close();
      }
    }

    // Flush any signals that arrived before this peer was created
    const pending = this.pendingSignals.get(remoteName);
    if (pending) {
      this.pendingSignals.delete(remoteName);
      for (const sig of pending) {
        this.handleSignal(sig).catch(e =>
          console.error('[Audio] Failed to replay buffered signal:', sig.type, e));
      }
    }
  }

  // Handle incoming WebRTC signals
  async handleSignal(signal: SignalMessage): Promise<void> {
    console.log('[Audio] Received signal:', signal.type, 'from:', signal.from);
    try {
      let peer = this.peers.get(signal.from);

      if (signal.type === 'offer') {
        if (!peer) {
          // Peer is reaching us first via the signaling channel — orchestrator's
          // "Peer joined" log only fires once their first position broadcast
          // arrives, which can be seconds later (or never if they're idle in
          // base). Log here so the join is always traceable in diagnostics.
          console.log('[Audio] Peer created via incoming offer: ' + signal.from);
          peer = await PeerConnection.create(signal.from);
          void peer.setOutputDevice(getStoredOutputDeviceId());
          this.peers.set(signal.from, peer);
          if (this.outputStream) peer.addLocalStream(this.outputStream);

          peer.onIceCandidate = (candidate) => {
            this.signaling.sendSignal({
              type: 'ice-candidate',
              from: this.localName,
              to: signal.from,
              payload: candidate.toJSON(),
            });
          };
        }
        const answer = await peer.handleOffer(signal.payload);
        this.signaling.sendSignal({
          type: 'answer',
          from: this.localName,
          to: signal.from,
          payload: answer,
        });
      } else if (signal.type === 'answer' && peer) {
        await peer.handleAnswer(signal.payload);
      } else if (signal.type === 'ice-candidate' && peer) {
        await peer.addIceCandidate(signal.payload);
      } else if (!peer && (signal.type === 'answer' || signal.type === 'ice-candidate')) {
        // Buffer signals that arrive before the peer connection is created
        let pending = this.pendingSignals.get(signal.from);
        if (!pending) {
          pending = [];
          this.pendingSignals.set(signal.from, pending);
        }
        pending.push(signal);
      }
    } catch (e) {
      console.error('[Audio] Signal handling failed:', signal.type, 'from:', signal.from, e);
    }
  }

  disconnectPeer(remoteName: string): void {
    const peer = this.peers.get(remoteName);
    if (peer) {
      peer.close();
      this.peers.delete(remoteName);
    }
  }

  applyPeerVolumes(volumes: Record<string, number>): void {
    // Verbose snapshot of every server-returned per-peer volume. Lets us
    // distinguish "server said 0 / we played 0" from "server said 0.8 /
    // EMA stuck near 1" when debugging volume bugs. Already silent unless
    // Debug is on (console.log is no-op'd by core/logging.ts). Throttled
    // to ≥1s OR when the summary string changes, so an active session
    // doesn't drown the log in ~10 lines/sec of identical snapshots.
    const entries = Object.entries(volumes);
    const summary = entries.length
      ? entries.map(([n, v]) => `${n}=${v.toFixed(2)}`).join(' ')
      : '(none)';
    const skipped = entries.filter(([n]) => !this.peers.has(n)).map(([n]) => n);
    const skippedTag = skipped.length ? `(skipped no-peer: ${skipped.join(',')})` : '';
    const fullLine = summary + (skippedTag ? ' ' + skippedTag : '');
    const now = performance.now();
    if (fullLine !== this.lastVolumeLogLine || now - this.lastVolumeLogMs >= 1000) {
      console.log('[Audio] applyPeerVolumes:', fullLine);
      this.lastVolumeLogLine = fullLine;
      this.lastVolumeLogMs = now;
    }

    // Mark every peer present in this response as freshly seen, so the grace
    // window below only holds peers that genuinely just dropped out.
    for (const name of Object.keys(volumes)) this.lastSeenInResponseMs.set(name, now);

    // Process the union of response peers AND connected peers. Connected peers
    // absent from `volumes` are silenced (0) — but a peer seen within the last
    // PROXIMITY_GRACE_MS holds its last volume first, so a single dropped coords
    // packet on a lossy tunnel doesn't blip the audio to silence and back (#27).
    const targets = resolveProximityTargets(volumes, this.peers.keys(), {
      lastVolumes: this.lastProximityVolumes,
      lastSeenMs: this.lastSeenInResponseMs,
      now,
      graceMs: PROXIMITY_GRACE_MS,
    });
    for (const [name, volume] of targets) {
      // Remember the proximity volume per peer so setPlayerVolume (the
      // per-row slider in the UI) can recompute finalVol correctly without
      // waiting for the next position tick. Was using a hardcoded 1.0 which
      // briefly played peers at full volume regardless of real distance —
      // caused user-reported "moved the slider and started hearing them"
      // blip on issue #7.
      this.lastProximityVolumes.set(name, volume);

      const peer = this.peers.get(name);
      if (!peer) continue;
      const playerVolume = this.settings.playerVolumes[name] ?? 1.0;
      const finalVol = computeFinalPeerVolume(volume, playerVolume);
      const wasState = this.lastAppliedVolume.get(name);
      // Always update volume so it's correct when unmuted. Don't hard-mute on
      // finalVol === 0 — the smoothed gain ramp handles it without a click,
      // and it lets brief proximity zeros (CV tracking glitches) fade gracefully.
      peer.setVolume(finalVol);
      const muteNow = this.muteAll || this.mutedPlayers.has(name);
      if (muteNow) {
        peer.mute();
      } else {
        peer.unmute();
      }
      // Log audible/silent transitions (skip steady-state to keep noise down)
      const stateNow = muteNow ? 'silent' : finalVol.toFixed(2);
      if (wasState !== stateNow) {
        console.log('[Audio] peer ' + name + ' → ' + stateNow +
          (wasState !== undefined ? ' (was ' + wasState + ')' : ''));
        this.lastAppliedVolume.set(name, stateNow);
      }
    }
  }

  // Mute controls
  toggleSelfMute(): boolean {
    this.setSelfMuted(!this.selfMuted);
    return this.selfMuted;
  }

  setSelfMuted(value: boolean): void {
    if (this.selfMuted === value) return;
    this.selfMuted = value;
    this.updateLocalTrackState();
  }

  toggleMuteAll(): boolean {
    this.setMuteAll(!this.muteAll);
    return this.muteAll;
  }

  setMuteAll(value: boolean): void {
    if (this.muteAll === value) return;
    this.muteAll = value;
    for (const [name, peer] of this.peers) {
      if (this.muteAll || this.mutedPlayers.has(name)) {
        peer.mute();
      } else {
        peer.unmute();
      }
    }
  }

  toggleMutePlayer(name: string): boolean {
    if (this.mutedPlayers.has(name)) {
      this.mutedPlayers.delete(name);
    } else {
      this.mutedPlayers.add(name);
    }
    const peer = this.peers.get(name);
    if (peer) {
      if (this.mutedPlayers.has(name)) {
        peer.mute();
      } else {
        peer.unmute();
      }
    }
    return this.mutedPlayers.has(name);
  }

  setPlayerVolume(name: string, volume: number): void {
    this.settings.playerVolumes[name] = Math.max(0, Math.min(1, volume));
    const peer = this.peers.get(name);
    if (peer) {
      // Use the last server-returned proximity volume — NOT a hardcoded 1.0.
      // The old hardcoded path briefly played the peer at slider-value × 1.0
      // before the next 100 ms position tick zeroed it out (issue #7
      // "moved the slider and started hearing them" symptom).
      const proximityVol = this.lastProximityVolumes.get(name) ?? 0;
      peer.setVolume(computeFinalPeerVolume(proximityVol, this.settings.playerVolumes[name]));
    }
  }

  isSelfMuted(): boolean { return this.selfMuted; }
  isMuteAll(): boolean { return this.muteAll; }
  isPlayerMuted(name: string): boolean { return this.mutedPlayers.has(name); }

  getPeer(name: string): PeerConnection | undefined {
    return this.peers.get(name);
  }

  hasPeer(name: string): boolean {
    return this.peers.has(name);
  }

  updateSettings(settings: Partial<AudioSettings>): void {
    Object.assign(this.settings, settings);
    this.applyInputVolume();
    this.updateLocalTrackState();
  }

  private applyInputVolume(): void {
    if (this.gainNode) {
      this.gainNode.gain.value = this.settings.inputVolume;
    }
  }

  private async acquireMicStream(): Promise<MediaStream> {
    const inputId = getStoredInputDeviceId();
    const constraints: MediaTrackConstraints = {
      // Native Chromium DSP runs in the audio thread — can't be starved by
      // our main-thread CV work the way RNNoise's ScriptProcessorNode was.
      // Quality is the WebRTC NS3 algorithm Discord used pre-Krisp.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (inputId) constraints.deviceId = { exact: inputId };
    return navigator.mediaDevices.getUserMedia({ audio: constraints });
  }

  private async applyStoredOutputDevice(): Promise<void> {
    const outputId = getStoredOutputDeviceId();
    if (!outputId) return;
    // Playback is element-only, so the output device is applied per peer via
    // HTMLMediaElement.setSinkId (more widely supported than AudioContext.setSinkId).
    for (const peer of this.peers.values()) {
      await peer.setOutputDevice(outputId);
    }
    console.log('[Audio] Output device applied to', this.peers.size, 'peer(s):', outputId);
  }

  // Re-acquire mic from the new device, swap the source node in place.
  // outputStream / destination stay the same so peer connections keep
  // working without renegotiation.
  async applyInputDevice(_id: string | null): Promise<void> {
    if (!this.audioContext || !this.gainNode) {
      console.log('[Audio] applyInputDevice: not initialized yet, will pick up on next session');
      return;
    }
    try {
      const newStream = await this.acquireMicStream();
      this.micSource?.disconnect();
      this.localStream?.getTracks().forEach((t) => t.stop());
      this.localStream = newStream;
      this.micSource = this.audioContext.createMediaStreamSource(newStream);
      this.micSource.connect(this.gainNode);
      this.updateLocalTrackState();
      console.log('[Audio] Input device switched');
    } catch (e) {
      console.warn('[Audio] applyInputDevice failed:', e);
    }
  }

  async applyOutputDevice(_id: string | null): Promise<void> {
    if (!this.audioContext) {
      console.log('[Audio] applyOutputDevice: not initialized yet, will pick up on next session');
      return;
    }
    await this.applyStoredOutputDevice();
  }

  cleanup(): void {
    for (const [, peer] of this.peers) {
      peer.close();
    }
    this.peers.clear();
    this.outputStream?.getTracks().forEach((t) => t.stop());
    this.outputStream = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.audioContext?.close();
    this.audioContext = null;
  }
}
