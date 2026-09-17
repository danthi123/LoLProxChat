# Threat Model

This document describes the threats LoLProxChat protects against, the threats it doesn't, and the mitigations applied or available. Two broad categories:

1. **Cheat / information leak** — using the app to gain an unfair in-game advantage
2. **Threats to users** — privacy, network, trust risks faced by people who run the app

---

# Part 1 — Cheat / Information Leak

## Design intent

A user running a modified ("cheating") client should not be able to derive enemy player locations from the app's data. The proximity-audio experience should not give a stock client noticeably more game information than a normal Riot vision-range check would.

## What the design protects

### Raw position data is never sent between clients

- Clients send their XY coordinates **directly to the server** over the WebSocket (`coords` message). The server stores the latest position per client per room and uses it to compute pairwise volumes.
- Clients never see another client's raw position — only volumes come back from `/compute-volumes`. The residual concern is the server operator reading positions — see ["The server operator can read positions"](#the-server-operator-can-read-positions) below.

### Stale-position window prevents zombie-peer audio

- Stored coords older than 5 seconds (`STALE_POSITION_MS` in `server/src/volumes.ts`) are skipped during volume computation.
- A peer who disconnects without a clean close or whose CV stops reporting won't continue to affect proximity audio for more than ~5 seconds.

### Server returns volumes, not positions

- The `/compute-volumes` response is `{ "PeerName": volume, ... }` where each volume is a number between 0 and 1.
- No coordinate data leaves the server in either direction of `/compute-volumes`.

## What the design does not protect

### Volume itself is a coarse side channel

- A modified client can read its per-peer volume vector to learn whether an enemy is within `MAX_HEARING_RANGE` (1350 game units, calibrated to roughly match LoL vision range).
- That binary "enemy is in audible range" signal is information the stock game wouldn't provide if the enemy is in fog of war.
- The volume is continuous, so the leak is "presence within range, plus a distance estimate" — accurate only to the noise floor of the underlying minimap tracking.
- This leak is **inherent to proximity audio existing at all** — closing it would mean abandoning the feature.

### Two coordinated modified clients can triangulate

- If two players in the same lobby both run modified clients and share their per-peer volume vectors out-of-band, distance estimates from two known points can localize an enemy.
- Localization accuracy is bounded only by the tracking jitter on the modified clients' side.
- This is an accepted trade at our scale: a determined pair sharing data out-of-band can already approximate enemy positions from coordinated vision and pings, so the audio side channel adds little a stock client wouldn't have.

### Single-client self-reported position trust

- Each client tells the server "I'm at (X, Y)" with no way for the server to verify.
- A modified client can broadcast a fake position to make itself appear at base, at an enemy's location, or anywhere else.
- This is fundamentally unfixable without Riot exposing authoritative game state to third-party tools (they don't).

### "Voice on camera" widens the stock client's own reach (opt-in)

- With the v0.5.8 `Voice on camera` setting enabled, the client sends a `listenPosition` (its camera centre) and the server scores what that client hears from *that* point instead of from their champion. An unmodified client can therefore hear enemies its champion has no vision of, by panning the camera — the fog-of-war reveal that [`compliance.md`](compliance.md) otherwise rules out. That is the feature working as designed, not an attack; it ships off by default and the setting says so.
- It does **not** widen the side channel beyond what a *modified* client could already do. `myPosition` in the `/compute-volumes` request has always been client-asserted and unverifiable (see above), so a modified client could already ask "what would I hear from over there?" about any point on the map. `listenPosition` gives that to honest clients too, and changes nothing about the attacker's ceiling.
- It stays **listen-only** on the server: the requester's `listenPosition` is used solely to score their own response. Peers' distances are measured against the requester's champion position held in room state (fed by `coords`), which the camera never touches. So the feature cannot be used to make yourself audible from somewhere you aren't.
- The team filter and `MAX_HEARING_RANGE` cutoff still apply from the listen point — the server remains the authority for both.

### The server operator can read positions

- The server holds every connected client's plaintext XY in process memory for as long as they're in a room. A malicious operator running the signaling server can log the positions of every player in every game using their server.
- Trust in the server operator is required — this is why the default deployment uses a server we control. Users who don't trust that can self-host and point their client at their own deployment.

## Calibration of `MAX_HEARING_RANGE`

The 1350-game-unit hearing range was chosen to roughly match the radius at which a player would already gain visual information about an enemy in stock LoL (champion vision range). The intent is that a stock client doesn't expose information the player wouldn't have anyway — the audio "fades in" right around when the enemy would become visible or warded. (A possible follow-up would gate cross-team audio on actual line-of-sight — only channel an enemy if a teammate has unobstructed vision of them — by testing champion positions against a static Summoner's Rift vision mesh (brush + walls) server-side. Positions alone don't suffice: hearing range ≈ sight range, so every audible enemy is already within the sight *radius*; the residual leak is terrain occlusion (a gank from a brush, an enemy behind a wall), which needs the mesh to detect. Server-side keeps it un-bypassable (the server withholds the audio), but it would model champion vision only — not wards — and is a non-trivial build.)

If this range is increased, the side-channel value to a modified client grows. If decreased, the proximity-audio experience loses utility (you can only hear teammates in melee range of each other). The current value is the result of those competing pressures.

## Mitigations applied vs. mitigations possible

| Mitigation | Status | Notes |
|---|---|---|
| Server computes volumes; clients never receive raw positions | **Applied** | The core anti-cheat — a modified client can read its own volume vector but never another player's coordinates. |
| Stale-position window (5 s) | **Applied** | Stored coords older than `STALE_POSITION_MS` are skipped, so a disconnected or lost peer stops affecting audio within ~5 s. |
| Hearing range ≈ champion vision range | **Applied** | `MAX_HEARING_RANGE` is sized so audio only reveals enemies a stock client would roughly already sense. |
| Line-of-sight gate on cross-team audio | Possible (benched) | Only channel an enemy a teammate can actually see, checked server-side against a static map vision mesh. See "Calibration of `MAX_HEARING_RANGE`" above. |
| Drop volumes below a noise floor | Not applied | Would prevent "barely audible = exactly N units away" signaling |
| Snap positions to a coarse grid client-side | Not applied | Lossy at source; slightly degrades volume accuracy for legitimate users. Would also reduce what a compromised server can see. |
| Reduce `MAX_HEARING_RANGE` | Not applied | Would shrink the side channel proportionally but also shrink the proximity-audio feature itself |
| Stateful per-pair smoothing on the server | Not applied | Would resist sample averaging but adds per-room state, undoing the stateless-math design |

The applied mitigations raise the floor for casual abuse without imposing measurable cost on legitimate use. The unapplied mitigations are tracked in [issue #10](https://github.com/danthi123/LoLProxChat/issues/10) for consideration if abuse becomes evident in the wild.

---

# Part 2 — Threats to Users

These are risks the *user* takes on by running the app, separate from in-game cheating. Some are mitigated, some are documented-and-accepted.

## What we don't collect

LoLProxChat collects **no analytics, no telemetry, no usage statistics, no crash reports, no device fingerprints, and no persistent user identifiers.** There are no user accounts. There is no third-party analytics SDK. The signaling server does not log per-user activity beyond what's needed to route a single in-flight request.

The only data that ever leaves the user's machine is:

- **Summoner name** — sent to the signaling server so peers in the same match can find each other in a room. Same name visible to anyone on the match scoreboard.
- **XY position coordinates** — sent in plaintext over the WebSocket (`coords` message) so the server can compute proximity volumes against the room's other players. Held only in process memory, never logged or persisted, replaced on every ~100 ms tick, dropped on disconnect. Only the server ever sees them (see "Server operator can read all positions" below).
- **WebRTC signaling messages** (SDP offers/answers, ICE candidates) — exchanged peer-to-peer via the signaling server as a relay. Standard WebRTC handshake; contains your public IP unless `Hide IP (Force TURN)` is enabled (see below).
- **Voice audio** — flows peer-to-peer over DTLS-SRTP, never touches the signaling server. Goes through the TURN relay (Cloudflare) only if direct P2P fails or `Hide IP (Force TURN)` is on, and even then the relay can't decrypt it.

The only data persisted locally is:

- **Settings** — input mode, mic/speaker device IDs, volume preferences, auto-update opt-in, Hide-IP toggle, per-player mute prefs. Stored in WebView2 localStorage at `%LOCALAPPDATA%\com.proxchat.app\`. Never sent anywhere.
- **Debug log** (only when `Debug` is toggled on) — written to `%LOCALAPPDATA%\com.proxchat.app\lolproxchat.log`. Only leaves your machine if you manually attach it to a GitHub issue. Rotates after 3 sessions.

There is no opt-in/opt-out switch for analytics because there is no analytics. The same applies to any future release — if telemetry is ever introduced, it will be opt-in, explicitly documented here, and clearly visible in Settings.

## Public IP exposure via WebRTC ICE candidates

**Risk:** WebRTC peer connections exchange ICE candidates to figure out how to reach each other. The "server-reflexive" (srflx) candidate contains each player's public IP, and that candidate is signaled to every peer in the match. A malicious player in the lobby can extract everyone else's public IP. With it, they can launch a DDoS against the home network, attempt port scanning, etc. This is the same class of risk Discord had pre-2017 before they forced all voice through their relays.

**Status:** **Mitigated by opt-in toggle.**

- **Settings → Hide IP (Force TURN)** sets `iceTransportPolicy: 'relay'` on the RTCPeerConnection. Chromium then refuses to gather or use any non-relay candidate, so peers only ever see the TURN server's IP, never the user's public IP.
- Default is **off**, because TURN relay adds ~20-100 ms latency and uses TURN bandwidth (which we pay for via the Cloudflare free tier). Most users on default config still expose their IP to fellow players.
- Takes effect on the next peer connection (existing connections keep their original transport policy until re-established).
- Only matters in matches where you don't already trust everyone. If you're queuing with a premade of friends, they're not the threat — but the other 8 players in the match could be, and the toggle is what protects you from them.

**Server-side mitigation alternative (not chosen):** forcing all clients TURN-only by default would protect users transparently but multiply server-side bandwidth costs and add latency for everyone. Opt-in keeps the cost on the users who choose it.

## Server operator can read all positions

**Risk:** The server holds every connected client's plaintext XY in process memory for as long as they're in a room. A malicious or compromised server operator can log every player's movement in every game using their server.

**Status:** Not mitigated in code. Trust-or-self-host.

**Available controls:**

- Self-host the signaling server (see [`self-hosting.md`](self-hosting.md)) and point the client at it via the `PROXCHAT_SERVER` env var at build time. Eliminates third-party-operator trust.
- The default deployment points at a server we operate. Users who don't trust that operator should self-host.

**Why not end-to-end encrypt instead:** moving to per-room shared keys that the server can't decrypt would force volume math client-side, which would let modified clients see peer positions directly — that undoes the anti-cheat design in Part 1. The trade-off favors keeping the server as the proximity-math authority as the price of a meaningful anti-cheat posture.

## Summoner names visible in signaling traffic + logs

**Risk:** WebSocket signaling messages include summoner names. The signaling server sees them, the per-session debug log records them, anyone observing the network path between the client and the signaling server (e.g., an ISP doing TLS inspection on a corporate network) sees them inside the WebSocket frames.

**Status:** Accepted as low severity. Summoner names are gameplay-public — anyone who can see the match scoreboard already has them. The debug log warning ("contains your summoner name and nearby players' names") covers the case of users sharing logs publicly via GitHub issues.

## Code-signing absence → typosquatting risk

**Risk:** The release `.exe` is not code-signed (paid certificate tied to a legal entity, out of scope for a personal project). Windows shows a SmartScreen warning on first run, which the user has to override. A malicious lookalike binary would produce the same warning. A typosquatted GitHub release (e.g., a fork pretending to be official) is hard for users to distinguish from the real one.

**Status:** Partially mitigated.

- **SHA-256 hash published in every release body.** The hash + per-OS verification instructions are included in the release notes. Users can compare their downloaded `.exe` against the official hash; anyone sharing the release link elsewhere (Reddit, Discord) can post the hash alongside.
- The hash defends against in-transit tampering, mirror reposts, and typosquatted re-uploads, but **does not defend against initial trust** — a user who downloads from the wrong GitHub URL has no way to know.
- Users wary of unsigned binaries can build from source (`npx tauri build`) — locally-built binaries skip the SmartScreen warning entirely.

## WebView2 process trust

**Risk:** The Tauri client loads the orchestrator + WebRTC code into a WebView2 process. Any vulnerability in the bundled WebView2 (which the WebView2 runtime updates separately via Microsoft Edge) — or in a JS dependency loaded inside it (e.g. `onnxruntime-web`, supply-chain compromise) — could in principle let attacker-controlled code run inside the WebView. The Tauri command surface then becomes the *blast radius* of any such compromise.

**Status:** Low practical risk for the vulnerability itself, with the blast radius now tightly bounded.

- The WebView2 attack surface is small: it only talks to one trusted signaling server endpoint (HTTPS-only) and one TURN provider.
- WebView2 receives security updates from Microsoft Edge automatically — no patching responsibility on us.
- **Tauri command blast-radius mitigations:**
  - `download_and_apply_update` validates the URL prefix matches our GitHub release-assets path. A compromised WebView can no longer redirect the auto-updater to an attacker-controlled binary → RCE.
  - `read_league_config_file` takes no path argument and is hard-coded to read only `Config/game.cfg`. A compromised WebView has no arbitrary-file-read primitive.
  - These don't *prevent* WebView2 compromise — they ensure a compromise can't trivially be escalated to local code execution or file exfiltration via our IPC surface.
- A compromised signaling server could in principle target this vector, but a compromised signaling server has bigger problems (it already sees every client's plaintext position and routes all signaling).

## Signaling-server resource abuse / DoS

**Risk:** The signaling server's HTTP endpoints (`/turn-credentials`, `/compute-volumes`) and WebSocket relay are open to the public internet. Without per-IP limits, a malicious script can:

- Exhaust the operator's Cloudflare TURN quota by spamming `/turn-credentials`.
- Pin CPU by flooding `/compute-volumes` with valid-shaped requests (a per-peer distance + falloff calc — cheap individually, but flood-able).
- OOM the server with a single massive POST body.
- Open thousands of WebSocket connections from one IP to exhaust file descriptors.
- Flood relay traffic through a legitimate joiner to all other peers in their room.

**Status:** Mitigated. Application-layer limits in `server/src/rate-limit.ts`:

- `/turn-credentials`: 60 req/min per IP (legit clients call ~once per peer connection)
- `/compute-volumes`: per player (IP + name), sized for the max scan rate, with a per-IP backstop — so players sharing one NAT each get their own budget (a shared per-IP limit previously 429'd everyone behind one IP, silencing proximity audio)
- `/compute-volumes` body cap: 256 KB (real payload is ~2 KB)
- WebSocket: 20 concurrent connections per IP, 60 msg/sec per connection, 64 KB per message

All limits return `429` / `413` / WS close `1008` cleanly — legitimate clients see no impact.

**What this doesn't cover:** distributed attacks from many IPs, large premades behind a single CG-NAT'd ISP (lift WS connection cap), or sustained slow attacks under the rate threshold. The first two would need an operator-level intervention (e.g. Cloudflare in front of the signaling server); the third is a fundamental limit of any open service.

## Signaling-server presence enumeration

**Risk:** Anyone with WebSocket access to the signaling server, or its operator, can enumerate currently-active users (those connected to rooms right now). Tells an observer "this player is currently using LoLProxChat."

**Status:** Accepted as low severity. There is no public list, no API for enumeration. The threat requires either compromising the server or being its operator. Mitigations would require breaking presence-broadcast semantics, which is core to how peers discover each other.

## Voice content in transit

**Risk:** Voice flows P2P over WebRTC, but the media layer encryption is the standard DTLS-SRTP — anyone observing the network path can tell *that* there's voice traffic between two endpoints, just not what's being said.

**Status:** Standard WebRTC baseline. Not specifically mitigated. Not user-facing in any practical sense.

## Mitigations applied vs. mitigations possible (Part 2)

| Threat | Status | Notes |
|---|---|---|
| Analytics / telemetry / fingerprinting | **Not applicable** | None collected. No SDKs, no usage stats, no crash reporting service |
| Public IP exposure | **Mitigated (opt-in)** | Force-TURN toggle in Settings |
| Updater URL injection (RCE via compromised WebView) | **Mitigated** | `ALLOWED_DOWNLOAD_PREFIX` check in `updater.rs` |
| Arbitrary file read (via compromised WebView) | **Mitigated** | No-arg `read_league_config_file`; no arbitrary-file-read primitive |
| Server resource abuse / DoS | **Mitigated** | Per-player + per-IP rate limits, body cap, WS hardening |
| Server-operator decrypt | Doc-only | Self-host alternative documented in [`self-hosting.md`](self-hosting.md) |
| Summoner names visible | Accepted | Gameplay-public; redact-before-share warning in README |
| Code-signing absence | Partially mitigated | SHA-256 in release notes; build-from-source as full bypass |
| WebView2 process trust | Accepted | Auto-updated by Microsoft Edge; small attack surface |
| Signaling presence enumeration | Accepted | No mitigation without breaking peer-discovery |
| Voice in transit | Standard DTLS-SRTP | Inherent to WebRTC |
