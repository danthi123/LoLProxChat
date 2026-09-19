import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import {
  GameStateService,
  GameSession,
  SessionFailureReason,
  TauriGameState,
} from './game-state';
import { SignalingService, SignalMessage, PositionBroadcast } from './signaling';
import { AudioService } from './audio';
import { TrackingService, TrackingState } from './tracking';
import { BlobScorer, ChampionClassifier } from './champion-classifier';
import { VolumeClient } from './volume-client';
import { getAllyProximity, getCameraListen } from './audio-prefs';
import { ScreenRect } from '../core/map-calibration';
import {
  GameWindowInfoDto,
  decideGameRectUpdate,
  resolveGameRect,
  WARN_QUERY_FAILED,
} from '../core/game-window';
import { MapType, PeerState, Player } from '../core/types';
import '../core/window-globals';
import { isStreamerMode } from '../core/streamer-detect';
import {
  Identity,
  identityEquals,
  presentIdentityFields,
  readIdentity,
} from '../core/identity';


function rectStr(r: ScreenRect): string {
  return r.width + 'x' + r.height + '@(' + r.x + ',' + r.y + ')';
}

/** Interval periods the orchestrator drives its three loops at, in ms. */
export interface OrchestratorTimings {
  gameStatePollMs: number;
  volumeTickMs: number;
  configPollMs: number;
}

/**
 * Everything the orchestrator builds that reaches outside this process — the
 * Tauri commands behind game state and tracking, the microphone, the signaling
 * socket, the ONNX model — named so a test can substitute it.
 *
 * Factories rather than instances because a session builds its audio, tracking
 * and volume client fresh on every game start and drops them on game end; an
 * injected instance could not survive that.
 *
 * Every default below is the exact expression `startSession` used inline
 * before, so `new Orchestrator()` is unchanged for background.ts.
 */
export interface OrchestratorDeps {
  createGameState(): GameStateService;
  createSignaling(): SignalingService;
  createAudio(signaling: SignalingService, localName: string): AudioService;
  createTracking(gameRect: ScreenRect, mapType: MapType): TrackingService;
  /** Resolves null when no scorer is available; tracking runs without one. */
  createClassifier(championName: string): Promise<BlobScorer | null>;
  createVolumeClient(): VolumeClient;
  timings: OrchestratorTimings;
}

export function defaultDeps(): OrchestratorDeps {
  return {
    createGameState: () => new GameStateService(),
    createSignaling: () => new SignalingService(),
    createAudio: (signaling, localName) => new AudioService(signaling, localName),
    createTracking: (gameRect, mapType) => new TrackingService(gameRect, mapType),
    createClassifier: async (championName) => {
      const classifier = new ChampionClassifier();
      await classifier.load(
        '../models/champion_classifier.onnx',
        '../models/champion_labels.json',
        championName,
      );
      return classifier;
    },
    createVolumeClient: () => new VolumeClient(),
    // The volume tick is 10 Hz because GainNode smoothing turns those steps
    // into a ramp; the other two are housekeeping.
    timings: { gameStatePollMs: 3000, volumeTickMs: 100, configPollMs: 5000 },
  };
}

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private gameState: GameStateService;
  private signaling: SignalingService;
  private audio: AudioService | null = null;
  private tracking: TrackingService | null = null;
  private volumeClient: VolumeClient | null = null;
  private session: GameSession | null = null;

  private localSummonerName = '';
  /** Local player's Riot ID as League spelled it this game, read once. */
  private localIdentity: Identity | null = null;
  /** Roster identities, resolved once per session — handlePeerPosition runs on
   *  every incoming position broadcast. */
  private rosterIdentities: { player: Player; identity: Identity }[] = [];
  /** Why the last session attempt was refused, throttled for the 3s poll. */
  private lastSessionFailure:
    { sig: string; reason: SessionFailureReason; detail: string; at: number } | null = null;
  private peerStates: Map<string, PeerState> = new Map();
  private volumeTickId: number | null = null;
  private configPollId: number | null = null;
  private gameStatePollId: number | null = null;
  private positionTickRunning = false;
  private sessionActive = false;
  private lastOverlayRepositionTime = 0;
  private lastOverlayBounds: { x: number; y: number; w: number; h: number } | null = null;
  private lastLoggedPosition: { x: number; y: number } | null = null;
  private lastMinimapScale: number | null = null;
  private lastGameState: TauriGameState | null = null;
  /** True once we have told the server our position is stale, so the message
   *  goes out on the transition rather than at the tick rate. */
  private coordsDisowned = false;
  private gameStatePollRunning = false;
  private geometryPollRunning = false;
  /** Panel-facing reason the capture geometry may be wrong, or null. */
  private geometryWarning: string | null = null;
  /** Last moved-window rect we logged, so a permanent move isn't logged every poll. */
  private loggedMovedRect: string | null = null;

  // User mute prefs survive across session start/end so the panel's MIC / VOL
  // buttons stay sticky when toggled outside a game (audio is null between
  // games). On session start these get pushed into the new AudioService.
  private selfMutedPref = false;
  private muteAllPref = false;

  constructor(deps: Partial<OrchestratorDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
    this.gameState = this.deps.createGameState();
    this.signaling = this.deps.createSignaling();
  }

  start(): void {
    console.log('[LoLProxChat] Orchestrator.start() called');

    // Poll Tauri backend for game state (3s by default — see defaultDeps)
    this.gameStatePollId = window.setInterval(
      () => this.pollGameState(),
      this.deps.timings.gameStatePollMs,
    ) as unknown as number;

    // Also poll immediately on start
    this.pollGameState();
  }

  /**
   * Counterpart to start(): drop the game-state poll and tear down any live
   * session. The app itself never stops short of process exit, so this exists
   * for anything that owns an orchestrator with a shorter life than the
   * process — today that is the session e2e suite, which would otherwise leave
   * a poll running against a server it has already shut down.
   */
  stop(): void {
    if (this.gameStatePollId !== null) {
      clearInterval(this.gameStatePollId);
      this.gameStatePollId = null;
    }
    if (this.session) this.endSession();
  }

  private async pollGameState(): Promise<void> {
    // The LCU round-trip can outrun the 3s timer on a busy machine; overlapping
    // polls race startSession and endSession against each other.
    if (this.gameStatePollRunning) return;
    this.gameStatePollRunning = true;
    try {
      const state: TauriGameState = await this.gameState.pollGameState();
      this.lastGameState = state;

      if (!state.isLeagueRunning) {
        if (this.session) {
          console.log('[LoLProxChat] LoL closed, ending session');
          this.endSession();
        }
        this.clearSessionAttemptState();
        // Fire an overlay refresh so the empty-state text reflects "Waiting for LoL"
        this.broadcastOverlayState();
        return;
      }

      if (state.isInGame && !this.session) {
        // Game is in progress but we don't have a session yet — try to get live client data
        await this.pollForLiveClientData();
      }

      // Update death state from Tauri backend
      if (this.session && state.isDead !== this.session.localPlayer.isDead) {
        if (state.isDead) {
          this.session.localPlayer.isDead = true;
          this.tracking?.onDeath();
        } else {
          this.session.localPlayer.isDead = false;
          this.tracking?.onRespawn();
        }
      }

      if (!state.isInGame) {
        // A refused attempt never creates `this.session`, so endSession() below
        // can never clear the refusal — it would otherwise follow the user
        // through the post-game client, the next lobby and champ select.
        this.clearSessionAttemptState();
      }

      if (!state.isInGame && this.session) {
        console.log('[LoLProxChat] Game ended (phase: ' + state.gameFlowPhase + ')');
        this.endSession();
      }

      // Refresh overlay even between sessions so lifecycle text stays current
      if (!this.session) {
        this.broadcastOverlayState();
      }
    } catch (e) {
      console.error('[LoLProxChat] pollGameState failed:', e);
    } finally {
      this.gameStatePollRunning = false;
    }
  }

  private async pollForLiveClientData(): Promise<void> {
    if (this.session) return;

    try {
      // Fetch live client data directly from League's local API via Tauri
      const lcd = await this.gameState.pollLiveClientData();
      if (lcd) {
        this.processLiveClientData(lcd);
      }
    } catch (e) {
      console.error('[LoLProxChat] pollForLiveClientData failed:', e);
    }
  }

  private processLiveClientData(lcd: any): void {
    if (this.session) return;

    try {
      let active: any = null;
      if (lcd.activePlayer) {
        active = typeof lcd.activePlayer === 'string'
          ? JSON.parse(lcd.activePlayer)
          : lcd.activePlayer;
        if (!this.localIdentity) {
          // Every identity field League has ever used is read here, not just
          // riotId/summonerName: when a patch moves the spelling, collapsing to
          // one field yields '' and every diagnostic below becomes unreachable.
          this.localIdentity = readIdentity(active);
          if (this.localIdentity) {
            console.log('[LoLProxChat] Local summoner: ' + this.localIdentity.display +
              ' (key=' + this.localIdentity.key + ')');
          }
        }
      }

      if (!lcd.allPlayers) return;

      const playersData = typeof lcd.allPlayers === 'string'
        ? JSON.parse(lcd.allPlayers)
        : lcd.allPlayers;
      const players = this.gameState.parsePlayerList({ players: playersData });
      console.log('[LoLProxChat] Parsed players:', players.length);

      if (!this.localIdentity) {
        this.reportSessionFailure('identity-unreadable',
          'activePlayer carried no usable name; identity fields present=[' +
          presentIdentityFields(active).join(',') + '] keys=[' +
          (active && typeof active === 'object' ? Object.keys(active).join(',') : '') + ']');
        return;
      }

      const gameData = lcd.gameData
        ? (typeof lcd.gameData === 'string' ? JSON.parse(lcd.gameData) : lcd.gameData)
        : null;

      const result = this.gameState.createSession(players, this.localIdentity, gameData);
      if (!result.ok) {
        this.reportSessionFailure(result.reason, result.detail);
        return;
      }

      const session = result.session;
      this.lastSessionFailure = null;
      // The wire name stays the most qualified spelling League gave us — the
      // full Riot ID where there is one. Peers resolve it against their own
      // roster through identityEquals, so it does not have to match the
      // roster's spelling, and keeping the tag is what makes the name globally
      // unique for the server's one-entry-per-name rule.
      this.localSummonerName = this.localIdentity.display;
      if (this.localSummonerName !== session.localPlayer.summonerName) {
        console.log('[LoLProxChat] activePlayer and allPlayers spell this player' +
          ' differently: "' + this.localSummonerName + '" vs "' +
          session.localPlayer.summonerName + '"');
      }
      this.rosterIdentities = session.allPlayers.flatMap((player) => {
        const identity = readIdentity(player);
        return identity ? [{ player, identity }] : [];
      });
      this.session = session;
      console.log('[LoLProxChat] Session created! Room:', session.roomId);
      this.startSession(session);
    } catch (e) {
      console.error('[LoLProxChat] Failed to process live client data:', e);
    }
  }

  /**
   * Record and log why no session was created. The 3s poll retries forever, so
   * an unthrottled line here would be the rolling log file's whole content.
   */
  private reportSessionFailure(reason: SessionFailureReason, detail: string): void {
    const sig = reason + '|' + detail;
    const now = Date.now();
    const previous = this.lastSessionFailure;
    const quiet = previous !== null && previous.sig === sig && now - previous.at < 30000;
    this.lastSessionFailure = { sig, reason, detail, at: quiet ? previous!.at : now };
    if (quiet) return;

    const line = '[LoLProxChat] Not joining proximity chat (' + reason + '): ' + detail;
    if (reason === 'streamer-mode') console.warn(line);
    else console.error(line);
  }

  private sessionFailureText(reason: SessionFailureReason): string {
    switch (reason) {
      case 'identity-unreadable':
        return "Couldn't read your Riot ID from League — see log";
      case 'identity-unmatched':
        return "Couldn't match your Riot ID to the player list — see log";
      case 'streamer-mode':
        return 'Streamer mode detected — not joining proximity chat';
    }
  }

  /** Reset everything a refused session attempt left behind. */
  private clearSessionAttemptState(): void {
    this.lastSessionFailure = null;
    this.localIdentity = null;
  }

  private async startSession(session: GameSession): Promise<void> {
    console.log('[LoLProxChat] Starting session: room=' + session.roomId);

    // Initialize audio (mic + WebRTC)
    this.audio = this.deps.createAudio(this.signaling, this.localSummonerName);
    try {
      await this.audio.initMicrophone();
      console.log('[LoLProxChat] Microphone initialized');
    } catch (e) {
      console.error('[LoLProxChat] Mic init failed — aborting session:', e);
      this.audio = null;
      return;
    }
    // Carry over any mute toggles the user set before/between sessions.
    this.audio.setSelfMuted(this.selfMutedPref);
    this.audio.setMuteAll(this.muteAllPref);

    // Join signaling room. v0.3: team is sent so the server can do team-aware
    // proximity (allies always full volume; enemies fade out at vision range).
    // Older servers ignore the team field and fall back to team-blind behavior.
    this.signaling.joinRoom(
      session.roomId,
      this.localSummonerName,
      session.localPlayer.team,
      (peer) => this.handlePeerPosition(peer),
      (signal) => this.handleSignal(signal),
      (name) => this.handlePeerLeave(name),
    );

    this.sessionActive = true;

    if (session.mapType === null) {
      // Unsupported map: keep voice, drop proximity. Tracking is never started,
      // so no coordinates leave this client and positionTick applies 1.0 to
      // everyone — which is both closer to Riot's line than broadcasting
      // Summoner's Rift-scaled coordinates for a map that isn't Summoner's
      // Rift, and better for the user than losing voice chat outright.
      console.warn('[LoLProxChat] ' + session.proximityDisabledReason);
      this.volumeTickId = this.startVolumeTick();
      this.broadcastOverlayState();
      return;
    }

    // Start tracking service
    try {
      // All capture geometry hangs off the League GAME window's client rect:
      // the minimap is anchored to that corner, which is the primary monitor's
      // corner only when League runs borderless at native resolution on the
      // primary display.
      //
      // No fabricated fallback if the query fails — set_capture_bounds and
      // capture_minimap travel the same channel, so a made-up rect would only
      // buy a wrong-pixels session instead of a legible error.
      const info = await invoke<GameWindowInfoDto>('get_game_window_info').catch((e) => {
        this.geometryWarning = WARN_QUERY_FAILED;
        throw new Error('get_game_window_info failed: ' + e);
      });
      const resolved = resolveGameRect(info);
      this.geometryWarning = resolved.warning;
      console.log('[LoLProxChat] Game geometry: source=' + resolved.source +
        ' rect=' + rectStr(resolved.rect) +
        ' matchedBy=' + (info.matchedBy ?? 'none') +
        ' title="' + (info.windowTitle ?? '') + '"' +
        ' process=' + (info.processName ?? 'unknown') +
        ' virtual=' + rectStr(info.virtualScreen) +
        ' primary=' + rectStr(info.primaryScreen) +
        (info.error ? ' error=' + info.error : ''));
      if (resolved.warning) console.warn('[LoLProxChat] ' + resolved.warning);

      // Note: League install dir is resolved Rust-side via the
      // read_league_config_file command (computes the path from the running
      // LeagueClient process or common defaults). The frontend no longer
      // handles the path directly — closing an arbitrary-file-read attack
      // surface that v0.1.30 and earlier had via read_text_file.

      this.tracking = this.deps.createTracking(resolved.rect, session.mapType);
      this.tracking.loadChampionTemplate(session.localPlayer.championName);

      // Set capture bounds in Tauri backend
      await this.tracking.initCaptureBounds();

      // Load champion classifier (async, non-blocking — tracking works without it)
      this.deps.createClassifier(session.localPlayer.championName).then((classifier) => {
        if (classifier && this.tracking) {
          this.tracking.setClassifier(classifier);
          console.log('[LoLProxChat] Champion classifier loaded');
        }
      }).catch(err => {
        console.warn('[LoLProxChat] Champion classifier failed to load (tracking continues without it):', err);
      });

      // Read minimap scale from League config and apply before starting tracking
      this.readMinimapScale((scale) => {
        if (scale !== null && this.tracking) {
          this.lastMinimapScale = scale;
          this.tracking.setMinimapScaleFromConfig(scale);
        }
      });

      this.tracking.start((_pos) => {
        // Fast overlay refresh at scan rate so position/debug visuals don't
        // wait for the 4 Hz positionTick. Volume + peer state still flow
        // through positionTick — broadcastOverlayState is read-only.
        this.broadcastOverlayState();
      }, 30);

      // Volume client speaks the v0.2 /compute-volumes shape — peer positions
      // come from server-side room state populated by `coords` WSS messages,
      // not from peer-to-peer data channels.
      this.volumeClient = this.deps.createVolumeClient();

      // Start volume computation tick (~10 Hz). GainNode setTargetAtTime
      // smoothing on the peer connections turns the discrete steps into a
      // continuous ramp; the tick rate just sets how often we refresh the
      // *target*, not how often the audio gain actually moves.
      this.volumeTickId = this.startVolumeTick();

      // Re-check the game window and game.cfg every few seconds
      this.configPollId = window.setInterval(
        () => this.pollGameGeometry(),
        this.deps.timings.configPollMs,
      ) as unknown as number;

    } catch (e) {
      console.error('[LoLProxChat] Tracking initialization failed:', e);
    }

    // Overlay is managed by Tauri window configuration — no manual window open needed
  }

  private startVolumeTick(): number {
    return window.setInterval(
      () => this.positionTick(),
      this.deps.timings.volumeTickMs,
    ) as unknown as number;
  }

  private async positionTick(): Promise<void> {
    if (this.positionTickRunning) return;
    if (!this.audio || !this.session) return;
    this.positionTickRunning = true;
    try {
      await this.positionTickInner();
    } finally {
      this.positionTickRunning = false;
    }
  }

  private async positionTickInner(): Promise<void> {
    if (!this.audio || !this.session) return;

    // Keep camera-viewport detection in step with the toggle. Set before the
    // early returns below so the 30 FPS tracking loop is already producing
    // camera positions by the time we need one, rather than a tick behind.
    this.tracking?.setCameraTracking(getCameraListen());

    // Broadcast presence over signaling so peers can discover us.
    // Coordinates go separately via sendCoords() — kept off this message so
    // every peer doesn't see them, and so server-side staleness can be
    // computed against the actual position update time.
    this.signaling.broadcastPosition({
      summonerName: this.localSummonerName,
      championName: this.session.localPlayer.championName,
      team: this.session.localPlayer.team,
      isMuted: this.audio.isSelfMuted(),
      isDead: this.session.localPlayer.isDead ?? false,
    });

    // Proximity off (unsupported map): everyone in the room stays audible at
    // full volume and no coordinates are sent.
    if (!this.tracking || !this.volumeClient) {
      const flat: Record<string, number> = {};
      for (const name of this.peerStates.keys()) flat[name] = 1.0;
      this.audio.applyPeerVolumes(flat);
      this.broadcastOverlayState();
      return;
    }

    // Before CV locks on (SCANNING), pass through all ally audio at full volume (fountain)
    if (this.tracking.getState() === TrackingState.SCANNING) {
      const allyVolumes: Record<string, number> = {};
      for (const [name, state] of this.peerStates) {
        if (state.team === this.session.localPlayer.team) {
          allyVolumes[name] = 1.0;
        }
      }
      this.audio.applyPeerVolumes(allyVolumes);
      this.broadcastOverlayState();
      return;
    }

    const position = this.tracking.getLastPosition();
    if (!position || (position.x === 0 && position.y === 0)) {
      this.broadcastOverlayState();
      return;
    }

    // The tracker has lost the player and is extrapolating. Say so, once, and
    // stop reporting.
    //
    // Simply going quiet is not enough: the server keeps serving the last
    // position it has for STALE_POSITION_MS, so the two silences compound into
    // several seconds during which peers are still scored against wherever we
    // were last seen. A recall is the case that makes this obvious — it is an
    // instant teleport the tracker cannot follow, so an enemy standing where
    // we recalled from goes on hearing us long after we are in base.
    if (this.tracking.getHoldDurationSec() > 2) {
      if (!this.coordsDisowned) {
        this.coordsDisowned = true;
        this.signaling.sendCoords(position.x, position.y, /*stale*/ true);
      }
      this.broadcastOverlayState();
      return;
    }

    // Push our latest XY to server-side room state. /compute-volumes reads
    // every peer's stored position from there — no more P2P blob exchange.
    this.coordsDisowned = false;
    this.signaling.sendCoords(position.x, position.y);

    // Log our position whenever it moves >500 game units so we can see the
    // coordinates we're broadcasting (useful for verifying CV accuracy).
    const moved = !this.lastLoggedPosition
      || Math.abs(position.x - this.lastLoggedPosition.x) > 500
      || Math.abs(position.y - this.lastLoggedPosition.y) > 500;
    if (moved) {
      this.lastLoggedPosition = { x: position.x, y: position.y };
      console.log('[LoLProxChat] My position: (' + Math.round(position.x) + ', ' + Math.round(position.y) + ')');
    }

    // "Voice on camera" (#36): when the user has opted in, hear the map from
    // wherever they're looking instead of from their champion. Falls back to the
    // champion position whenever the camera rectangle isn't readable this frame,
    // so a missed detection is a no-op rather than a dropout. Listen-only — the
    // coords we broadcast above are always the champion's.
    const listenPosition = getCameraListen() ? this.tracking.getCameraPosition() : null;
    this.logCameraListen(listenPosition);

    try {
      const result = await this.volumeClient.computeVolumes(
        position,
        this.session.roomId,
        this.localSummonerName,
        getAllyProximity(),
        listenPosition,
      );
      this.audio.applyPeerVolumes(result.peerVolumes);
    } catch (e) {
      console.error('[LoLProxChat] Volume computation failed:', e);
    }

    this.broadcastOverlayState();
  }

  // Log camera-listen transitions only — at 10 Hz a per-tick line would be the
  // next resizeOverlay-style log flood.
  private lastCameraListenState: string | null = null;
  private logCameraListen(listenPosition: { x: number; y: number } | null): void {
    if (!getCameraListen()) {
      this.lastCameraListenState = null;
      return;
    }
    const miss = listenPosition ? null : this.tracking?.getCameraMiss() ?? null;
    // The pixel count is worth logging but must stay OUT of the comparison key:
    // it moves by a pixel or two between frames, so including it made a steady
    // failure re-log continuously and read like rapid flapping in a report.
    const state = listenPosition ? 'camera' : 'fallback-champion:' + (miss ? miss.reason : 'unknown');
    if (state === this.lastCameraListenState) return;
    this.lastCameraListenState = state;
    console.log('[LoLProxChat] Voice on camera: hearing from ' + state +
      (listenPosition
        ? ' (' + Math.round(listenPosition.x) + ', ' + Math.round(listenPosition.y) + ')'
        : ' — camera rectangle not readable on the minimap (' +
          (miss ? miss.markedPixels : 0) + ' marked px)'));
  }

  private async handlePeerPosition(peer: PositionBroadcast): Promise<void> {
    if (!this.session || !this.audio) return;

    // Skip streamer mode players. The roster lookup goes through the same
    // identity rules as the local match, so the two can't drift apart and
    // leave this one silently matching nobody.
    const peerIdentity = readIdentity({ summonerName: peer.summonerName });
    const entry = peerIdentity
      ? this.rosterIdentities.find((r) => identityEquals(r.identity, peerIdentity))
      : undefined;
    if (entry && isStreamerMode(entry.player, this.session.hasTagLines)) return;

    const existing = this.peerStates.get(peer.summonerName);
    if (!existing) {
      const sameTeam = peer.team === this.session.localPlayer.team;
      console.log('[LoLProxChat] Peer joined: ' + peer.summonerName +
        ' (' + (sameTeam ? 'ALLY' : 'ENEMY') + ', ' + peer.championName + ')');
    }
    const peerState: PeerState = {
      summonerName: peer.summonerName,
      championName: peer.championName,
      team: peer.team as 'ORDER' | 'CHAOS',
      isMuted: peer.isMuted,
      isDead: peer.isDead,
    };

    this.peerStates.set(peer.summonerName, peerState);

    // Connect to peer (audio only — positions go via the server in v0.2)
    try {
      if (!this.audio.hasPeer(peer.summonerName)) {
        const isInitiator = this.localSummonerName < peer.summonerName;
        await this.audio.connectToPeer(peer.summonerName, isInitiator);
      }
    } catch (e) {
      console.error('[LoLProxChat] Failed to connect to peer:', peer.summonerName, e);
      this.peerStates.delete(peer.summonerName);
    }
  }

  private async handleSignal(signal: SignalMessage): Promise<void> {
    await this.audio?.handleSignal(signal);
  }

  private handlePeerLeave(name: string): void {
    this.audio?.disconnectPeer(name);
    this.peerStates.delete(name);
    this.broadcastOverlayState();
  }

  private computeLifecycleStatus(): string {
    const gs = this.lastGameState;
    if (!gs || !gs.isLeagueRunning) return 'Waiting for League of Legends';
    if (this.session) {
      // Proximity being off is the whole story for this session, and unlike a
      // geometry warning it never resolves itself.
      if (this.session.proximityDisabledReason) return this.session.proximityDisabledReason;
      // A refused minimap region outranks everything below: tracking can never
      // leave SCANNING while it stands, and the log line that explains it is
      // only written to disk when Debug is already on. Optional call because
      // orchestrator test doubles implement only the surface they exercise.
      const refusal = this.tracking?.getGeometryRefusal?.() ?? null;
      if (refusal) return refusal;
      const ts = this.tracking?.getState();
      // A geometry problem is the most useful thing to say while nothing is
      // locked — including when tracking never started at all, which is what a
      // failed game-window query leaves behind. Once LOCKED it is moot, so a
      // warning that was never explicitly cleared cannot pin itself to the panel.
      if (this.geometryWarning && ts !== 'locked') return this.geometryWarning;
      if (ts === 'scanning') return 'Searching for your champion on the minimap';
      // LOCKED with no peers in the room — empty waiting state handled elsewhere
      return '';
    }
    // A refusal beats the phase text: without it the panel sits on
    // "Joining game..." forever with no hint that we decided not to join.
    if (this.lastSessionFailure) return this.sessionFailureText(this.lastSessionFailure.reason);

    const phase = gs.gameFlowPhase || 'None';
    switch (phase) {
      case 'None':         return 'In client';
      case 'Lobby':        return 'In lobby';
      case 'Matchmaking':  return 'Searching for match';
      case 'ReadyCheck':   return 'Ready check';
      case 'ChampSelect':  return 'In champion select';
      case 'GameStart':
      case 'InProgress':   return 'Joining game...';
      case 'WaitingForStats': return 'Game complete';
      case 'PreEndOfGame':
      case 'EndOfGame':    return 'End of game';
      default:             return phase;
    }
  }

  private broadcastOverlayState(): void {
    const audio = this.audio;
    const nearbyPeers = audio ? Array.from(this.peerStates.values())
      .map((p) => ({
        summonerName: p.summonerName,
        championName: p.championName,
        team: p.team,
        isMuted: p.isMuted,
        isMutedByLocal: audio.isPlayerMuted(p.summonerName),
        isDead: p.isDead,
      })) : [];

    const data = {
      selfMuted: this.selfMutedPref,
      muteAll: this.muteAllPref,
      nearbyPeers,
      trackingState: this.tracking?.getState() ?? 'none',
      lastPosition: this.tracking?.getLastPosition() ?? null,
      filteredImageUrl: this.tracking?.getFilteredImageUrl() ?? null,
      detectedMinimapBounds: this.tracking?.getDetectedMinimapScreenBounds() ?? null,
      localTeam: this.session?.localPlayer.team ?? null,
      lifecycleStatus: this.computeLifecycleStatus(),
    };

    // Auto-position the SCANNER window over the minimap whenever bounds
    // change (HUD scale, resolution swap, etc). The panel window is never
    // auto-moved — the user owns its position via drag.
    if (data.detectedMinimapBounds) {
      const mb = data.detectedMinimapBounds;
      const next = { x: mb.screenX, y: mb.screenY, w: mb.screenWidth, h: mb.screenHeight };
      const last = this.lastOverlayBounds;
      const changed = !last
        || Math.abs(next.x - last.x) > 4
        || Math.abs(next.y - last.y) > 4
        || Math.abs(next.w - last.w) > 4
        || Math.abs(next.h - last.h) > 4;
      const now = performance.now();
      if (changed && now - this.lastOverlayRepositionTime > 1000) {
        this.lastOverlayRepositionTime = now;
        this.lastOverlayBounds = next;
        invoke('position_scanner', {
          x: mb.screenX,
          y: mb.screenY,
          width: mb.screenWidth,
          height: mb.screenHeight,
        }).catch((e) => console.warn('[LoLProxChat] position_scanner failed:', e));
      }
    }

    // Push the scanner-specific scene (tracking dot + debug image + debug-on)
    // to the scanner window via Tauri events. We rely on the panel window
    // having access to a tauri-emit; reuse the existing invoke pattern so
    // background.ts doesn't need to know about scanner internals.
    emit('scanner:scene', {
      filteredImageUrl: data.filteredImageUrl,
      lastPosition: data.lastPosition,
      debugEnabled: window.__lolproxchat_debug_enabled === true,
    }).catch(() => { /* scanner may not be ready yet — non-fatal */ });

    // Broadcast panel-relevant state to the overlay UI
    window.dispatchEvent(new CustomEvent('overlayUpdate', { detail: data }));
  }

  // Public controls (called from overlay via messaging)
  toggleSelfMute(): boolean {
    this.selfMutedPref = !this.selfMutedPref;
    this.audio?.setSelfMuted(this.selfMutedPref);
    this.broadcastOverlayState();
    return this.selfMutedPref;
  }
  toggleMuteAll(): boolean {
    this.muteAllPref = !this.muteAllPref;
    this.audio?.setMuteAll(this.muteAllPref);
    this.broadcastOverlayState();
    return this.muteAllPref;
  }
  toggleMutePlayer(name: string): boolean { return this.audio?.toggleMutePlayer(name) ?? false; }
  setPlayerVolume(name: string, volume: number): void { this.audio?.setPlayerVolume(name, volume); }
  setScanRate(fps: number): void {
    if (!this.tracking) return;
    const clamped = Math.max(1, Math.min(60, Math.round(fps)));
    // Restarting the scan loop resets warmup + classifier timers, so a slider
    // drag used to tear tracking down dozens of times a second (NotOtakuu's log
    // has ~50 setScanRate in one second). The overlay debounces the drag; this
    // is the backstop for any caller that doesn't.
    if (clamped === this.tracking.getScanFps()) return;
    console.log('[LoLProxChat] Scan rate changed to ' + clamped + ' FPS');
    this.tracking.stop();
    this.tracking.start(() => {
      // Position updates handled by volume tick
    }, clamped);
  }
  setPTTState(held: boolean): void { this.audio?.setPTTState(held); }
  updateSettings(settings: any): void { this.audio?.updateSettings(settings); }
  applyInputDevice(id: string | null): Promise<void> | void { return this.audio?.applyInputDevice(id); }
  applyOutputDevice(id: string | null): Promise<void> | void { return this.audio?.applyOutputDevice(id); }

  getSessionPlayers(): { summonerName: string; championName: string; team: string }[] {
    if (!this.session) return [];
    return this.session.allPlayers.map((p) => ({
      summonerName: p.summonerName,
      championName: p.championName,
      team: p.team,
    }));
  }

  /**
   * Receive minimap screen bounds from calibration overlay and convert to
   * capture-relative coordinates for the tracking service.
   */
  setMinimapCalibration(bounds: { screenX: number; screenY: number; screenWidth: number; screenHeight: number }): void {
    if (!this.tracking) {
      console.warn('[LoLProxChat] setMinimapCalibration called but no tracking service');
      return;
    }
    const capture = this.tracking.captureBounds;
    // Convert screen coordinates to capture-relative coordinates
    const region = {
      x: bounds.screenX - capture.x,
      y: bounds.screenY - capture.y,
      width: bounds.screenWidth,
      height: bounds.screenHeight,
    };
    console.log('[LoLProxChat] Calibration bounds (screen):', JSON.stringify(bounds));
    console.log('[LoLProxChat] Calibration region (capture-relative):', JSON.stringify(region));
    this.tracking.setMinimapRegion(region);
  }

  /**
   * Read MinimapScale from League's game.cfg. The file is an INI-style config
   * with [Section] headers. MinimapScale is under [HUD] and ranges from 0.0 to
   * 3.0 — the calibration in `TrackingService.setMinimapScaleFromConfig` is
   * fitted at scale 0 and scale 3.
   * The Rust side computes the install dir and reads only `Config/game.cfg`;
   * the frontend never handles arbitrary paths.
   */
  private readMinimapScale(callback: (scale: number | null) => void): void {
    invoke<string>('read_league_config_file')
      .then(text => this.parseMinimapScale(text, callback))
      .catch(err => {
        console.warn('[LoLProxChat] Failed to read game.cfg:', err);
        callback(null);
      });
  }

  private parseMinimapScale(text: string, callback: (scale: number | null) => void): void {
    const lines = text.split('\n');
    let inHudSection = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        inHudSection = trimmed.toLowerCase() === '[hud]';
        continue;
      }
      if (inHudSection && trimmed.toLowerCase().startsWith('minimapscale=')) {
        const rawVal = trimmed.split('=')[1].trim();
        const val = parseFloat(rawVal);
        if (!isNaN(val)) {
          console.log('[LoLProxChat] MinimapScale raw="' + rawVal + '" parsed=' + val);
          // Applied anyway: a Riot range change should show up in the log as a
          // wrong-looking minimap region we can explain, not be clamped into a
          // wrong region silently.
          if (val < 0 || val > 3) {
            console.warn('[LoLProxChat] MinimapScale ' + val +
              ' is outside the expected 0.0-3.0 range — minimap region may be wrong');
          }
          callback(val);
          return;
        }
      }
    }
    console.warn('[LoLProxChat] MinimapScale not found in game.cfg, text length=' + text.length);
    callback(null);
  }

  /**
   * 5s housekeeping: refresh the game-window warning the panel shows while
   * scanning, then pick up MinimapScale changes from game.cfg.
   *
   * Re-anchoring capture bounds when the window actually moves is deliberately
   * NOT wired up — it tears the in-flight capture frame against the canvas and
   * invalidates any stored calibration, and a mid-game monitor move is rare
   * enough to cost less than that risk. A moved window is logged and left alone.
   */
  private async pollGameGeometry(): Promise<void> {
    // The two awaits below can outrun the 5s timer; two overlapping polls would
    // each be free to re-apply the minimap scale, which resets tracking to
    // SCANNING and drops the lock.
    if (this.geometryPollRunning) return;
    this.geometryPollRunning = true;
    try {
      const current = this.tracking?.getGameRect() ?? null;
      if (current) {
        let info: GameWindowInfoDto | null = null;
        try {
          info = await invoke<GameWindowInfoDto>('get_game_window_info');
        } catch (e) {
          console.warn('[LoLProxChat] get_game_window_info failed:', e);
        }
        const decision = decideGameRectUpdate(current, info);
        this.geometryWarning = decision.warning;
        if (decision.action === 'apply' && decision.rect) {
          const moved = rectStr(decision.rect);
          if (moved !== this.loggedMovedRect) {
            this.loggedMovedRect = moved;
            console.warn('[LoLProxChat] League window moved to ' + moved +
              ' — capture stays on ' + rectStr(current) + ' until the next game');
          }
        }
      }

      const scale = await new Promise<number | null>((resolve) => this.readMinimapScale(resolve));
      if (scale !== null && this.tracking && scale !== this.lastMinimapScale) {
        console.log('[LoLProxChat] MinimapScale changed:', this.lastMinimapScale, '->', scale);
        this.lastMinimapScale = scale;
        this.tracking.setMinimapScaleFromConfig(scale);
      }
    } finally {
      this.geometryPollRunning = false;
    }
  }

  private endSession(): void {
    this.positionTickRunning = false;
    this.sessionActive = false;

    if (this.volumeTickId !== null) {
      clearInterval(this.volumeTickId);
      this.volumeTickId = null;
    }
    if (this.configPollId !== null) {
      clearInterval(this.configPollId);
      this.configPollId = null;
    }

    this.tracking?.stop();
    this.tracking = null;
    this.volumeClient = null;
    this.audio?.cleanup();
    this.signaling.leaveRoom();
    this.gameState.clearSession();
    this.session = null;
    this.peerStates.clear();
    this.localSummonerName = '';
    this.rosterIdentities = [];
    this.clearSessionAttemptState();
    // Allow re-positioning on the next session
    this.lastOverlayBounds = null;
    this.lastOverlayRepositionTime = 0;
    this.geometryWarning = null;
    this.loggedMovedRect = null;

    // Hide the scanner window so it doesn't float wherever the minimap last was
    invoke('hide_scanner').catch(() => { /* non-fatal */ });

    // Notify overlay that session ended
    window.dispatchEvent(new CustomEvent('sessionEnded'));
  }
}
