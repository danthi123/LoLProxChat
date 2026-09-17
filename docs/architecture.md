# Architecture

How LoLProxChat actually works under the hood. Audience: contributors and curious users. For day-to-day usage, see the [user guide](user-guide.md). For the threat model, see [`threat-model.md`](threat-model.md).

## The 30-second version

LoLProxChat reads your in-game position by **computer vision on the minimap**, reports its XY coordinates to a **stateless signaling server** over the same WebSocket used for presence/signaling, asks the server for pairwise **proximity volumes** at ~10 Hz, and applies those volumes to **WebRTC voice streams** that flow directly between players.

No client ever sees another client's raw position; the server returns only `{ peerName: volume }`. No audio touches the server.

## System map

```
┌────────────────────────────────────────────────────────────────────┐
│  Player's machine — lolproxchat.exe (Tauri 2)                      │
│                                                                    │
│  ┌──────────────────┐         ┌───────────────────────┐            │
│  │  Rust backend    │         │  WebView2 frontend    │            │
│  │  ────────────    │         │  ─────────────────    │            │
│  │  • Win32 BitBlt  │◄────────┤  Orchestrator         │            │
│  │    minimap cap   │         │  (game-state polling, │            │
│  │  • LCU + Live    │────────►│   session lifecycle,  │            │
│  │    Client poll   │         │   position broadcast) │            │
│  │  • Window pos    │         │                       │            │
│  │  • Global keys   │         │  TrackingService      │            │
│  │  • Updater       │         │  (CV pipeline)        │            │
│  │  • Log rotation  │         │                       │            │
│  └──────────────────┘         │  AudioService         │            │
│                               │  (mic, peers, volume) │            │
│                               │                       │            │
│                               │  SignalingService     │            │
│                               │  PeerConnection × N   │            │
│                               │  VolumeClient         │            │
│                               └───────────────────────┘            │
└────────────┬────────────────────────────────┬──────────────────────┘
             │                                │
             │  WSS + HTTPS                   │  WebRTC P2P
             │  (presence, signal             │  (DTLS-SRTP voice
             │   relay, XY coords,            │   only — no data
             │   /compute-volumes)            │   channel)
             ▼                                │
   ┌────────────────────────┐                 │
   │  Signaling server      │                 │
   │  (Node, /mnt/user/      │                 │
   │   appdata/proxchat-     │                 │
   │   server on Unraid)    │                 │
   │  ───────────────────   │                 │
   │  • /ws  room presence  │                 │
   │         + coords store │                 │
   │  • /compute-volumes    │                 │
   │    (dist→volume math   │                 │
   │     against room       │                 │
   │     coords state)      │                 │
   │  • /turn-credentials   │                 │
   │    (Cloudflare proxy)  │                 │
   │  • /health             │                 │
   └────────────┬───────────┘                 │
                │                             │
                │  HTTPS                      │  TURN UDP/TCP/TLS
                ▼                             ▼
   ┌────────────────────────┐    ┌────────────────────────┐
   │  Cloudflare Realtime    │    │  Cloudflare Realtime   │
   │  TURN API               │    │  TURN relay            │
   │  (credential issuance) │    │  (turn.cloudflare.com) │
   └────────────────────────┘    └────────────────────────┘
```

## The three windows

The client runs two Tauri windows, both inside a single WebView2 process:

- **`overlay`** — the **panel** window. Draggable, holds the player list and Settings. Visible, captures input over its hit-rect, click-through everywhere else (via a 30 Hz cursor-position polling loop in `main.rs`).
- **`scanner`** — a transparent click-through window auto-pinned over the detected minimap region. It stays empty, even in Debug: the tracked-position marker and the filtered minimap preview both live in the panel's Settings, deliberately kept out of the scanner so they can't be captured back into the minimap image the tracker reads.

A short-lived third "window" is the splash visible at startup before the orchestrator boots; it's just the panel before CV locks on.

Both windows are declared in `src-tauri/tauri.conf.json`. Both have transparent backgrounds, no decorations, `alwaysOnTop`, no shadow. Capability grants live at `src-tauri/capabilities/default.json` (drag + event emit/listen — without this Tauri 2 silently denies built-in IPC).

## The CV pipeline (`src/services/tracking.ts`)

Tracking is a state machine: **SCANNING → LOCKED → (DEAD)**. Every CV tick:

1. **Capture.** `invoke('capture_minimap')` triggers a Win32 `BitBlt` of a bounded screen rect on a blocking worker (not the window message loop, which also drives the 30 Hz click-through poll). It returns one raw byte buffer: an 8-byte header (LE `u32` width, LE `u32` height) followed by top-down row-major RGBA with no padding. `src/core/capture-frame.ts` decodes it into a `CaptureFrame` as a zero-copy view; the tracker refuses a frame whose dimensions disagree with the capture bounds it pushed, and re-pushes the bounds once. There is no BMP, no base64 and no canvas round-trip on this path.
2. **Color mask.** Build HSV-thresholded masks for each plausible champion-circle color (teal allies + various enemy hues). Tracked via `buildWhiteMasks` / `findBlobs`.
3. **Blob detection.** Flood-fill connected components, filter by size + fill-ratio against the expected icon diameter at the current minimap scale.
4. **Identity.** Candidate icons are cropped and identified by a champion classifier — all of a tick's crops in a single batched inference (`src/services/champion-classifier.ts` — a small CNN trained on champion icons, run in-browser via ONNX Runtime) combined with blob scoring, so the tracker follows *your* champion rather than whatever icon is nearest. Design notes + research: [`docs/plans/2026-06-03-cv-tracking-research.md`](plans/2026-06-03-cv-tracking-research.md).
5. **Track.** In LOCKED state, prefer the blob nearest to last position + velocity; rebuild velocity as an EMA on apparent motion. Allow brief "holds" (no match in range) using extrapolation with a velocity cap (10 px/tick — see `extrapolatePosition`). The scoring/selection math (composite blob score, Phase-1 in-range pick, Phase-2 classifier reacquisition, adaptive thresholds) lives in pure functions in `src/services/tracking-helpers.ts` — testable in isolation; `handleLocked` is the orchestration layer that wires them up plus the side-effect ordering.
6. **Position-jump detection.** All `lastPosition` writes funnel through `setLastPosition`, which warns when a jump exceeds both a distance threshold (>500 game-units) AND a speed threshold (>2000 u/s) — both gates filter out CV pixel-jitter on normal movement while still catching real teleports (recall) or mis-tracks. Thresholds live as `JUMP_WARN_MIN_UNITS` / `JUMP_WARN_MIN_SPEED` static constants on `TrackingService`.

Edge cases the state machine handles: champion deaths (icon disappears), respawn at fountain (re-acquire via classifier), camera pan, overlapping icons in teamfights, minimap scale changes via `game.cfg` MinimapScale.

**Training data + retraining.** The classifier learns from every champion's per-skin circle icon, scraped from [Community Dragon](https://www.communitydragon.org/) — Riot's community mirror of the raw game assets — into `assets/champion-circles/`. `npm run refresh-model` runs the whole loop: scrape → retrain → export `models/champion_classifier.onnx` + `champion_labels.json`. A content-hash manifest (`models/champion-icons-manifest.json`) records which icon set the live model was trained against, so a new champion, skin, or rework surfaces as a manifest diff. See [`CONTRIBUTING.md`](../CONTRIBUTING.md) § "Refreshing the champion classifier".

## Position privacy + volume math

This is the part that matters for both the threat model and the "what does the server see" question.

1. On every position tick (~10 Hz), the client sends a `coords` WebSocket message: `{ type: "coords", x, y }`. The server stamps it with the current time and stores it on the sender's room-client record.
2. Immediately after, the client POSTs `/compute-volumes` with `{ myPosition, roomId, name }`. The server reads the latest position for every *other* client in the room (skipping any whose last `coords` is older than 5 s) and returns `{ peerVolumes: { peerName: volume } }`.
3. Volume math: pairwise distance with quadratic falloff `1 - (d/MAX_HEARING_RANGE)²`, continuous float in `[0, 1]`. `MAX_HEARING_RANGE = 1350` game units (≈ champion vision range). Allies always return 1.0; cross-team peers use the falloff and are omitted entirely beyond the range. See `server/src/volumes.ts`.

On a map the client has no coordinate system for, none of the three steps above happen: tracking never starts, no `coords` are sent, and every peer is held at 1.0 — voice works, proximity is off, and the panel says why. Coordinates are only ever broadcast for a map whose dimensions the client actually knows (`src/core/map-detect.ts`).

The result: **a peer client never sees another client's raw position; the server sees every client's plaintext XY for as long as they're in the room.** That's a deliberate trade — the server needs positions to compute proximity, and a peer never receives another peer's coordinates. The only party who can see positions is whoever runs the server, so self-host if that matters to you. Threat-model implications in [`threat-model.md`](threat-model.md).

## WebRTC voice flow

Voice is the only thing on the WebRTC connection — there is no data channel.

- Each client publishes a single mic stream through a WebAudio graph: `mic → GainNode → MediaStreamDestination → RTCPeerConnection`.
- Each peer's incoming stream goes through the inverse: `RTCPeerConnection → MediaStreamSource → GainNode → AudioContext.destination`.
- The per-peer gain is driven by the server-returned volume, smoothed (`nextSmoothedVolume`, ~1-second ramp) so distance changes ease in instead of snapping, and tracking jitter is damped.
- ICE candidates flow through the signaling server's `/ws` endpoint. Direct P2P (host or srflx) is preferred; TURN relay kicks in if the user opted into "Hide IP" or if direct paths fail. TURN credentials come from Cloudflare's Realtime TURN API, proxied through the signaling server's `/turn-credentials`. The client caches the response in memory for 60 seconds and de-duplicates concurrent requests, so a lobby's worth of peer setups makes one call rather than one per peer. Failed or empty responses are not cached — an ICE server list is frozen into each `RTCPeerConnection` at construction, so caching a STUN-only fallback would strand every peer of that game without a relay.
- ICE failure auto-recovers: initiator side calls `pc.restartIce()` + re-issues an offer, capped at 2 attempts per peer, counter resets on successful re-connect.

## Signaling server (`server/`)

A ~500-LOC Node process. Single container deployed via Docker Compose. Stateless modulo the in-memory rooms table.

**Endpoints:**

- **`/ws`** — WebSocket upgrade. Handles room join/leave, peer presence broadcast, position coords (`coords` message), and relay of `offer` / `answer` / `ice-candidate` signals between named peers. Room IDs are deterministic hashes of sorted player summoner names, so any two players in the same match independently compute the same room ID.
- **`POST /compute-volumes`** — `{ myPosition, roomId, name }` → `{ peerVolumes }`. Reads every other client's stored position from room state (5-second staleness window), applies the team-aware distance→volume falloff, and returns one volume per audible peer.
- **`GET /turn-credentials`** — Returns ICE servers for the requesting client. Calls Cloudflare's TURN API in the background (cached in-process for 24 hours with stale-grace fallback on API failure). Falls back to self-hosted coturn HMAC credentials if `TURN_KEY_ID` is unset and `TURN_SERVER`/`TURN_SECRET` are set.
- **`GET /health`** — `{ status: "ok", rooms: N }`. Used by Docker healthcheck and the public status badge in the README.

Source files:

| File | Responsibility |
|---|---|
| `src/index.ts` | HTTP/WebSocket bootstrap, route dispatch, rate limits (per-player + per-IP backstop) + body cap + WS connection cap |
| `src/ws-handler.ts` | Per-connection lifecycle, room messages, per-connection message rate limit |
| `src/rooms.ts` | In-memory room table, presence tracking, one-entry-per-name-per-room invariant |
| `src/validate.ts` | `join` argument validation (types, length caps, room-id charset, control characters) |
| `src/heartbeat.ts` | WebSocket liveness: ping sweep + termination of half-open connections |
| `src/volumes.ts` | Team-aware distance→volume falloff math (`computeTieredVolumes`), reading coords from room state. Older entry points remain for backward compatibility. |
| `src/turn.ts` | Cloudflare TURN credential fetcher + cache + coturn HMAC fallback |
| `src/rate-limit.ts` | Token-bucket and concurrency limiters used across endpoints. No external dep. |
| `src/types.ts` | Shared request/response types |

165 tests under `server/tests/` (tiered-proximity + team room-state, `join` validation, heartbeat reaping, TURN credentials, and rate-limiting incl. client-IP trust resolution and an end-to-end per-player isolation test).

**Rate-limit defaults** (all in `src/rate-limit.ts::LIMITS`):
- `/turn-credentials`: 60 req/min per IP
- `/compute-volumes`: per player (IP + name) ~90 req/sec sustained (sized for the max scan rate), plus a per-IP backstop (~400 req/sec) for premades sharing a NAT, and a 256 KB body cap
- WebSocket: 20 connections per IP, 60 msg/sec per connection (120 burst), 64 KB per message

Defaults are tuned for ~50% headroom over normal gameplay cadence (10 Hz position broadcasts, occasional signaling bursts). Operators with unusual environments (e.g. CG-NAT'd ISP sharing one public IP among many subscribers) can adjust the constants in `LIMITS` and rebuild.

## Update flow

In-app updater (`src-tauri/src/updater.rs` + `src/services/updater.ts`):

1. On launch, if the user has Auto-update on (localStorage flag), wait ~5 seconds for the orchestrator to settle.
2. `GET https://api.github.com/repos/danthi123/LoLProxChat/releases/latest`, compare `tag_name` against `CARGO_PKG_VERSION`.
3. If newer: prefer the `lolproxchat.exe` asset's `browser_download_url`, fall back to any `.exe`. Stream-download to `<current-exe-dir>/<current-exe-name>.new`.
4. Spawn the new binary with `--complete-update <old-path>` and exit.
5. The new process waits ~800 ms (so the old process releases its file lock), deletes the old `.exe` with up to 5 retries, then renames `.new` → `.exe` (renaming a running `.exe` is allowed on Windows; deleting one isn't).

Manual checks (Settings → Updates → CHECK) skip the launch delay and the Auto-update gate.

**URL validation:** `download_and_apply_update` refuses any URL that doesn't start with `ALLOWED_DOWNLOAD_PREFIX` (defined alongside `GITHUB_LATEST` in `updater.rs`). Defense-in-depth against a hypothetical frontend compromise (XSS, supply-chain attack on a bundled JS dep) being able to call the command with an attacker-controlled URL → arbitrary binary execution. Forks should adjust both constants in lockstep.

## Key client services (under `src/services/`)

| Service | Responsibility |
|---|---|
| `Orchestrator` | Game-state polling, session lifecycle, broadcast cadence, scanning-mode passthrough, peer state registry. The wiring layer between everything else. Its collaborators and its three loop periods come from an `OrchestratorDeps` record with a `defaultDeps()` fallback, so `new Orchestrator()` — the app's only construction — builds exactly what it always did, while tests can substitute fakes. `stop()` is the counterpart to `start()`; the app has no shutdown path that calls it. |
| `TrackingService` | Minimap CV pipeline. State machine described above. Constructed with the League game window's client rect (a `ScreenRect`), not a width/height pair — the capture square is derived from that rect's origin and height. Frames come from an injectable `FrameSource` (default: the Tauri capture command) and the identity signal from a `BlobScorer` (default: `ChampionClassifier`), which is what lets `tests/cv/` drive the real pipeline over synthesized minimaps. |
| `ChampionClassifier` | Champion classifier (a small CNN run via ONNX Runtime Web) — the champion-identity signal for tracking. Implements `BlobScorer`, and owns the one canvas-dependent step in the scan path: it builds the `ImageData` its crop packing needs, so every stage between capture and scoring is DOM-free plain array work. |
| `AudioService` | WebRTC audio + per-peer volume control. Input mode toggle (Always Open / PTT). Mic acquisition with selected device. Output via shared `AudioContext`. Noise suppression handled natively by Chromium. |
| `SignalingService` | WebSocket presence + signal relay. Auto-reconnect with exponential backoff, except on close code 4000 (the room+name was taken over by another connection), which is terminal. |
| `PeerConnection` | Single peer's `RTCPeerConnection` wrapper. EMA-smoothed gain, periodic `getStats()` logging, ICE-restart on failure, ICE-transport-policy reading from privacy settings. |
| `VolumeClient` | Calls `/compute-volumes` with `{ myPosition, roomId, name }` and applies the returned per-peer volumes. |
| `GameStateService` | Wraps Tauri commands for LCU + Live Client Data into a TypeScript surface. |
| `Devices` | localStorage-backed input/output audio device pick. |
| `Privacy` | localStorage-backed Force-TURN toggle. |
| `Updater` | Thin wrapper over the Rust update commands. |

### Internal helpers and shared types

Not services in their own right — small support modules consumed by the services above:

| Module | Used by | Purpose |
|---|---|---|
| `src/services/tracking-helpers.ts` | `TrackingService` | Pure scoring/selection math used by `handleLocked`. Unit-tested in isolation. |
| `src/services/frame-source.ts` | `tracking.ts` | `FrameSource` — one capture, returned as the raw wire bytes `capture.rs` writes. Deliberately not a decoded frame: decoding, the header/bounds agreement check and the bounds resync stay in the tracker, so a test frame source exercises them too. |
| `src/services/blob-types.ts` | `tracking.ts`, `tracking-helpers.ts` | Shared `Blob` interface. Lives outside `tracking.ts` so the helpers can import it without a circular reach back. |
| `src/core/capture-frame.ts` | `tracking.ts` | Decodes the raw `capture_minimap` byte frame into a `CaptureFrame` (`width`, `height`, `Uint8ClampedArray`). DOM-free — it is a view over the transferred buffer, not an `ImageData`. |
| `src/core/identity.ts` | `game-state.ts`, `orchestrator.ts`, `streamer-detect.ts` | Reads whichever Riot ID fields a patch of League provides into one comparable `Identity`, and matches the local player against the roster. |
| `src/core/map-detect.ts` | `game-state.ts` | Resolves the map from `mapNumber` / `mapName` / `gameMode`, or refuses. A refusal is what disables proximity rather than defaulting to Summoner's Rift geometry. |
| `src/core/streamer-detect.ts` | `game-state.ts`, `orchestrator.ts` | Streamer-mode heuristic (displayed name equals champion name, and, where the roster carries tag lines, no tag line on that player). |
| `src/core/window-globals.ts` | `overlay.ts`, `background.ts`, `orchestrator.ts` | `declare global { interface Window { … } }` for the two app-specific properties used as a cross-module bus (`__proxchatRunUpdateCheck`, `__lolproxchat_debug_enabled`). Imported side-effect-only. |

### Where the seams are, and why

Two of the services above take their collaborators as constructor arguments rather than building them inline, and both defaults are exactly the expression that used to be inline — the app constructs them the same way it always did.

- `TrackingService(gameRect, mapType, frameSource?)` plus `setClassifier(scorer)` is what makes the CV pipeline runnable outside the WebView. Everything from `decodeCaptureFrame` down is plain array work, so `tests/cv/` feeds synthesized minimaps through the real colour classification, blob detection, scoring and state machine and checks the reported game coordinates against known ground truth.
- `Orchestrator(deps?)` is what makes the session lifecycle runnable without I/O: the game-state transition table, interval teardown and audio-monitor cleanup run under fake timers in the fast suite, and `tests/e2e/` stands two whole clients up against the real built signaling server.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) § "Testing" for what each suite covers, and [`docs/manual-test-checklist.md`](manual-test-checklist.md) for what only a real match on Windows can prove.

## Key Rust commands (under `src-tauri/src/`)

| Command (file) | Responsibility |
|---|---|
| `capture::set_capture_bounds`, `capture::capture_minimap` | Win32 GDI BitBlt of a bounded screen rect into a raw RGBA byte frame (8-byte width/height header, then top-down RGBA), returned as a Tauri `Response` and produced on a blocking worker. The source is `GetDC(NULL)` — the device context for the whole **virtual** screen — so bounds on a monitor left of or above the primary one (negative coordinates) read back real pixels rather than black. Bounds that do not intersect the virtual screen are rejected with a descriptive error. |
| `lcu::check_league_running`, `lcu::get_game_state`, `lcu::get_live_client_data`, `lcu::read_league_config_file`, `lcu::get_league_install_dir` | LCU + Live Client Data polling. Install-dir resolution via the LCU lockfile path. `read_league_config_file` takes no arguments and reads only `Config/game.cfg` — Rust computes the path so the frontend can't supply arbitrary file paths. |
| `updater::check_for_update`, `updater::download_and_apply_update` | GitHub Releases check + in-place exe swap. Handles the `--complete-update <old-path>` startup arg. |
| `main::position_scanner`, `main::hide_scanner` | Auto-pin the scanner window over the detected minimap region. |
| `game_window::get_game_window_info` | Locates the League **game** window (`FindWindowW("RiotWindowClass")`, rejecting invisible/minimized handles) and returns its client rect in screen coordinates plus the virtual- and primary-screen rects, the matched window's title and owning process, and any Win32 error. All capture geometry derives from this. Plausibility is judged in `src/core/game-window.ts`, not here, so jest can cover it. |
| `main::set_panel_size` | Reports the panel's current hit-rect size to the click-through polling loop. |
| `main::append_log`, `main::append_log_lines` | Writes to the rolling debug log file. The frontend buffers console output and calls `append_log_lines`, which takes one lock and one flush per batch; the single-line `append_log` stays registered for version skew between the bundle and the binary. |
| `main::open_log_folder` | Launches Explorer at the log directory. |

`main.rs` also runs the cursor-position polling loop (30 Hz, skipped while LMB held to avoid tearing down a native window-drag), installs the low-level keyboard hook for the rebindable push-to-talk and toggle-mute keys (push-to-talk defaults to Caps Lock), opens the rolling log file at startup with 3-session rotation, and routes `tauri::WindowEvent::CloseRequested` on any window to `app.exit(0)`.

## What's intentionally not here

A few design choices that look odd until you know the constraints:

- **No `tauri dev` workflow.** No webpack dev server is configured. The iterative loop is `npx tauri build && src-tauri/target/release/lolproxchat.exe`. Adding `tauri dev` is plausible future work but the current cadence is ~60-90 s per iteration which is fast enough.
- **The signaling server is stateful only in-memory.** Rooms vanish on restart. This is intentional — restarts are rare, clients reconnect, and the alternative (a stateful presence DB) is a much bigger ops surface for no real benefit.
- **No code signing.** Code-signing certs are paid + tied to a legal entity. The release flow includes a SHA-256 hash in every release body instead (see the README's verification section).
- **Anti-cheat hardening lives server-side, not client-side.** The client just plays whatever volume the server returns. Client-side bucketing or rounding wouldn't help — a modified client would just bypass it.

## Where the code-base is going next

See open issues and the [CHANGELOG](../CHANGELOG.md). Current threads:

- **Champion-tracking reliability** (`#13`) — keeping the tracked marker glued to your champion across champions and minimap sizes; the main lever is the classifier's confidence on harder-to-recognize icons.
- **Cross-team audio anti-cheat** — optionally gating enemy audio on actual line-of-sight (server-side, against a static map vision mesh) so you only hear enemies your team can see. Benched as a potential mitigation; see [`threat-model.md`](threat-model.md).
- **Cloudflare TURN usage monitoring** — alert before approaching the 1 TB/month cap.

For the longer view, see issue [#10](https://github.com/danthi123/LoLProxChat/issues/10) and the design notes under `docs/plans/`.
