# Changelog

All notable changes to this project are documented here. Format adapted from [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [SemVer](https://semver.org/) loosely — `0.x.y` releases may break compatibility without warning.

## [Unreleased]

### Notes
- **Proximity audio does not respect fog of war, and cannot at present.** An enemy in a brush or behind a wall is as audible as one in the open at the same distance. League's client API reports positions but nothing about vision, so there is no signal to gate on; modelling it would need a static terrain mesh and line-of-sight tests, which is not implemented. [`docs/compliance.md`](docs/compliance.md) now says so directly rather than claiming no fog-of-war reveals.

### Changed
- **A player who should stop being heard now goes quiet in under a second, instead of about five.** The fade was advancing one step per proximity update, and those only arrive as fast as a round trip to the signaling server allows — so how quickly someone faded out depended on the network rather than on the fade. It now runs on a local timer at a fixed rate. Most noticeable with **Voice on camera**, where panning off someone used to leave them audible for around four seconds.
- **Enemies are now at full volume out to ~900 game units, instead of fading the whole way in.** The old curve put two ranged champions holding a lane against each other at roughly half volume while a melee trade sat near full — so the people this feature is for could not actually hold a conversation in lane without walking into each other. Voice is now flat inside ~900 units and fades over the last stretch to the unchanged ~1350 cutoff. What you can hear has not changed, only how loud it is; and because volume is constant inside the plateau, it now carries less information about exactly where an enemy is than it used to.

### Fixed
- **A minimap the app briefly could not read no longer cuts you out of everyone's audio.** Two logs from a real two-client session showed the tracker blinking four times in forty seconds — each time with *no* own-team icons anywhere on the minimap, each time recovering on its own within five seconds — and each blink cut the other player's audio dead for one to four seconds. The coordinate disown added for recalls fires at two seconds of lost tracking and did not ask why tracking was lost. But a game always draws four allies on the minimap, so a frame with no own-team icons at all means the capture failed, not that anyone moved; the last position is almost certainly still right. A frame with icons present and none of them yours is the opposite — positive evidence you are not where you say you are, which is exactly what a recall looks like. The app now tells the two apart and waits five seconds for the first and two for the second. Recalls are unaffected.
- **The app now stops vouching for your position the moment the tracker gives up on it.** When tracking is lost for long enough that it abandons its own extrapolation and starts scanning from scratch, the server was still serving that position to your peers for several seconds afterwards.
- **After a recall you could still hear everyone you could hear from the lane you just left.** Two halves, and only one of them was fixed last time. Telling the server to forget your position stopped other players hearing *you*; this stops *you* hearing *them*. While the tracker has lost you the volume pipeline was not being entered at all, so every peer stayed at whatever gain they happened to have at that moment. Teammates are unaffected — team audio needs no coordinates — but players scored by distance now fade out, because with no position of your own there is no distance to score.
- **Caps Lock no longer inverts on every push-to-talk press (#27).** With Caps Lock bound to push-to-talk, each press-and-release was leaving Caps Lock in the opposite state: the app cancelled the key's toggle on *both* edges, but Windows only toggles on the press, so the release added a toggle of its own. The cancel now fires once, on the press, and holding the key does not stack up further cancels. This is the cleaner fix v0.5.7 promised — Caps Lock stays bound and usable as a PTT key, and it keeps typing capitals normally.
- **Tracking never locked when League ran on a second monitor, in windowed mode, or at a non-primary resolution.** All capture geometry was derived from `GetSystemMetrics(SM_CXSCREEN/SM_CYSCREEN)` — the *primary* monitor's size, with an implied origin of (0,0) — so the minimap capture square landed on the wrong display and the CV scan had nothing to find. There is no CV fallback for a wrong region, so the panel sat on "Searching for your champion on the minimap" for the whole game. The app now locates the League game window (`RiotWindowClass`) and derives the capture square from its *client* rect, origin included, which is also correct in windowed mode where the minimap is anchored below the title bar.
- **The screen grab now reads from the whole virtual screen.** It used the desktop window's device context, which is clipped to the primary monitor — without this, the corrected bounds for a secondary display would still have read back black.
- **The panel says why tracking cannot start** instead of showing "Searching for your champion on the minimap" forever: "Can't find the League window — use Borderless, not fullscreen." and two sibling messages, with the full geometry (window title, owning process, client rect, virtual- and primary-screen rects) in the debug log.
- **`capture_minimap` now rejects capture bounds that lie entirely off the virtual screen** with a descriptive error instead of silently returning a black frame. Repeated capture failures are logged at most once per distinct message per 5 s — the 30 Hz tick used to forward every one of them into a flushed file write with Debug on.
- **A capture frame whose size disagrees with the tracker's capture bounds is now refused and the bounds re-pushed**, instead of being indexed with the wrong row stride. While frames arrived as decoded images that mismatch could not happen; now that the tracker reads raw pixels it can, and it would have left tracking stuck in "Searching for your champion on the minimap" with nothing in the log.
- **A `MinimapScale` large enough that the minimap does not fit inside the capture square is now refused and logged**, instead of producing a negative region origin that the mask builder read out of bounds (it wraps into the previous scanline — there is no clamping).
- **An out-of-range `MinimapScale` is now logged.** The in-code note said the value ranges from 0.0 to 1.0; the tracking calibration it feeds is fitted at 0.0 and 3.0. The comment is corrected and a value outside that range is flagged in the log (and still applied, so a Riot range change shows up as an explained wrong region rather than a silently clamped one).
- **Two overlapping polls can no longer fight each other.** The game-state poll and the 5 s geometry poll are now re-entrancy guarded, so a slow LCU or window query cannot let two polls overlap and double-apply a minimap-scale change — which resets tracking to scanning and drops the lock.
- **League detection no longer enumerates every process on the machine several times a minute.** Each game-state poll (every 3 s) and each in-game 5 s poll walked the entire process table — CPU, memory, disk and per-process command lines included — just to find the League install directory, on the same machine that is running League and a 30 FPS screen capture. The directory is now remembered and re-checked with two `exists()` calls; the process table is only walked again when that directory stops looking like a League install, and at most once every 10 s. In a game the steady-state cost is zero process enumerations. The trade-off: League started from a *different* install directory than the one already cached can take up to ~13 s to be noticed instead of 3 s. A launch from the install the app already knows about — the overwhelmingly common case — is unaffected.
- **A stalled League client can no longer hang a poll indefinitely, or drop everyone's voice.** The three loopback requests the app makes to League had no timeout at all and built a fresh TLS connection each time, so a wedged client socket could leave a poll waiting forever. They now share one pooled connection with a 1 s response budget (500 ms to connect) — roughly sixty times a healthy loopback reply. Because the app ends a voice session the moment a poll reports "not in game", a request that times out now reports the last phase League actually gave us for up to 15 s instead of claiming the game ended; a real game end is still detected on the first poll that gets an answer.
- **League client connection failures are no longer silent.** Which branch resolved the install directory (running process, default path, or cache), a failed lockfile lookup, and each failed request to the League client are now logged, so a "League not detected" bug report has something to grep for. A non-default install that resolved via the default paths is visible in the log instead of silently pointing at the wrong drive.
- **One player could be silently inaudible for a whole game.** When someone's offer reached us at the same moment we were setting up our own connection to them, both sides built a connection for that player and one of them was quietly discarded — while still being the one the remote actually connected to. The result was a peer that looked connected, was never retried, and played at zero volume for the rest of the game. There is now exactly one connection per player no matter which side gets there first.
- **A reconnecting player no longer black-holes their own voice chat.** The signaling server allowed two entries under one name in a room, and relayed every offer, answer and ICE candidate to the *first* one it found. When a client reconnected — a dropped Wi-Fi frame, a suspended laptop, anything that leaves the old socket half-open — the stale entry kept the name and every signal addressed to that player was dropped with no error on either side. They appeared in the overlay and the ally/enemy list, and simply never had audio. A `join` now hands the name to the newest connection and removes the old entry immediately.
- **...and no longer force-disconnects the live player when the stale socket finally dies.** `peer_left` is keyed by name, so when the abandoned connection eventually timed out at the TCP layer, every other client was told that name had left and tore down the connection to the player who was actually there. The evicted entry is gone from room state before that close fires, so nothing is broadcast for a name that is still in the room.
- **Players who vanish without disconnecting cleanly are now removed within a minute.** The server had no WebSocket heartbeat at all, so a half-open connection (closed lid, dropped tether) survived until the OS timed the TCP connection out — potentially many minutes. Because ally voice is full-volume and deliberately skips the stale-coordinate check, a teammate in that state stayed audible at full volume the whole time. Idle connections are now pinged every 30 s and terminated after one missed pong, and any inbound traffic counts as proof of life, so a client in a game (which streams coordinates at 10 Hz) is never reaped by mistake.
- **Connections no longer leak when a player leaves (or the game ends) while we are still connecting to them.** The half-built connection used to be finished and filed away anyway, keeping a live peer connection and its 10-second stats loop running for the lifetime of the app — the same class of leak as the audio-meter leak fixed in v0.5.8.
- **ICE candidates that arrive before a connection exists are no longer stranded** when that connection is created by the other player's offer, and a player who leaves and rejoins no longer has the previous connection's candidates replayed into the new one.
- **Automatic recovery from a failed connection now also covers players who reached us first.** Previously a connection created from an incoming offer had no ICE-restart handler at all, so if it failed later there was nothing to recover it.
- **TURN credentials are fetched once per game instead of once per player.** A full lobby fired nine requests per client within seconds of the game starting; they now share one. Failed fetches are deliberately *not* cached, so a single dropped request still only affects the one player it was for.
- **Changing rooms mid-session now tells the old room.** The "already in a room" branch of `join` looked up who to notify *after* removing the joiner, which by construction returned nobody — so peers in the room being left were never told and kept a dead peer in their list.
- **`join` now validates its arguments.** `room` and `name` came straight out of `JSON.parse` and were only checked for truthiness, so a non-string name could be stored in room state and break name-keyed signal routing for everyone in the room. Both must now be strings, with a length cap, a character restriction on room ids and a control-character rejection on names. Names are never trimmed or normalised — the raw string is the player's identity.
- **Every per-IP rate limit on the signaling server could be bypassed by sending a header. ACTION REQUIRED if a CDN sits in front of your server.** The client address the limits key on was taken from the leftmost entry of `X-Forwarded-For`, unvalidated and regardless of who the connection actually came from — so anyone reaching the server directly (the published `:3100` port, or the no-Docker `npm start` path) got a fresh, unlimited budget per request simply by varying that header: TURN-credential issuance, `/compute-volumes` and the 20-connection WebSocket cap all became unenforceable. Forwarding headers are now read only when the connection arrives from loopback / a private range / link-local — i.e. from your own reverse proxy — the entry your outermost trusted proxy observed is used rather than the one the client wrote, values that aren't IP addresses are discarded instead of becoming rate-limit keys, and IPv6 clients are bucketed by /64 so they can't rotate inside their own prefix. **If you run a CDN (Cloudflare, etc.) in front of your reverse proxy, set `TRUST_PROXY=2` on the server and configure the proxy to trust the CDN at the same time** — see [`docs/self-hosting.md`](docs/self-hosting.md) § "Client IP and rate limits". A single proxy, which is what the self-hosting guide describes, needs no change.
- **Signaling failures are no longer silent.** A relay to a socket that is not open, a duplicate-name takeover, and a reaped connection each now log with enough context to grep for; the sender of an undeliverable `signal` gets an error instead of a stall.
- **The shipped `lolproxchat.exe` reported version 0.1.0 in Windows file properties.** `src-tauri/tauri.conf.json` still carried the scaffolded `"version": "0.1.0"`, and that field takes precedence over `Cargo.toml` when building the exe's version resource — so right-click → Properties → Details showed 0.1.0 on every release. The field is gone; the exe's version now comes from `src-tauri/Cargo.toml`, the same place `scripts/bump-version.mjs` writes and `release.yml` reads the tag from. Update checks were never affected (the updater compiles the version in from `Cargo.toml`), and release tags were always correct.
- **The app could stop working entirely, with no error anywhere, if Riot renamed one identity field.** The local player was found in the scoreboard by comparing `activePlayer.riotId` to `allPlayers[].summonerName` with exact string equality — two different fields of two different objects, which League has spelled differently across patches (`summonerName`, `summonerName` carrying a Riot ID, `riotId`, and the split `riotIdGameName` / `riotIdTagLine` pair). Any patch that reintroduced that split would have made the comparison fail, and the failure path returned nothing and logged nothing: the 3 s poll retried forever while the panel sat on "Joining game..." for the whole match. Every spelling is now read, the local player is matched on the full Riot ID first and on the bare game name only where one side genuinely has no tag line, and a match that cannot be made is refused **loudly** — with the name we looked for, the names we saw, and which identity fields the scoreboard actually carried, in the log.
- **A refusal to start is now visible in the panel instead of looking like a hang.** "Couldn't match your Riot ID to the player list — see log", "Couldn't read your Riot ID from League — see log" and "Streamer mode detected — not joining proximity chat" replace the indefinite "Joining game...". The message clears the moment the game is over, so it cannot follow you into the next lobby or champion select.
- **Players genuinely named after their champion are no longer dropped from voice chat.** Streamer mode was detected by comparing the displayed name to the champion name, so an account actually called "Ahri" playing Ahri was treated as obscured: they got no voice chat, and nothing was written to the log to say why. A real Riot ID always carries a tag line, so where the scoreboard tells us about tag lines a champion-name match now only counts as streamer mode when the tag line is missing. Where a patch provides no tag-line information at all the old comparison still applies, and any exclusion is now logged by name.
- **Arena, Swarm and Nexus Blitz no longer broadcast coordinates scaled for Summoner's Rift.** Every mode that was not recognised fell through to Summoner's Rift map dimensions, so on a different map the coordinates sent to the server — and therefore every hearing distance computed from them — bore no relation to in-game distance. The map is now read from `mapNumber`, which classifies every Summoner's Rift-based rotating mode (URF, ARURF, One For All, Ultbook) correctly by construction. On a map we have no coordinate system for, **voice chat still works and proximity is switched off**: no coordinates are sent and everyone in the room is audible at full volume, with the reason shown in the panel.

### Added
- **A minimap simulation suite for champion tracking (`tests/cv/`).** Frames containing champion icons, minion waves, turrets, the camera rectangle and the movement-path trail are synthesized at known positions and fed through the real tracking pipeline — real colour classification, real blob detection, real scoring, real state machine — so the reported game coordinates can be checked against ground truth. It covers the failure that made v0.5.8's tracking bug user-visible: a classifier that scores the local champion 0.000 on every frame must not freeze the broadcast position in a lock → hold → forced-reacquire cycle. A companion test restores the pre-v0.5.8 gate and asserts that the freeze *does* reproduce, so the guard cannot quietly stop guarding. The synthetic icons are flat coloured rings with no champion art and no anti-aliasing: the suite proves geometry, the state machine and the scoring wiring, not that the ONNX classifier recognises real icons.
- **An end-to-end session suite (`tests/e2e/`, `npm run test:e2e`).** Two full clients — real orchestrator, real audio service, real signaling, real volume client — meet in a room on the *actual built server*, spawned as a subprocess, and the whole chain is asserted from the server's own answers: join, presence, coordinates, `/compute-volumes`, and the gain each peer ends up playing at. It covers allies staying audible across the map, enemies fading in over vision range, an enemy leaving range being held through the grace window and then silenced, "voice on camera" moving only the listener, a peer leaving tearing both sides down, and a client reconnecting under the same name taking the room entry over from its own stale socket. Only the Windows-and-hardware edges are faked: the Tauri commands, WebRTC, WebAudio, the League polls and the CV tracker.
- **A standing anti-cheat invariant test.** Every frame the server sends either client, and every `/compute-volumes` response, is swept for anything coordinate-shaped — not just checked against the message shapes we ship today. The point is the *next* change: the way [`docs/threat-model.md`](docs/threat-model.md) Part 1 gets broken is a field quietly added to an existing message, or a well-meaning revival of the deleted peer-avoidance signal, and a per-shape assertion would pass through both.
- **Session lifecycle tests in the fast suite.** The game-state transition table (League closing, a game starting, death and respawn, a game ending), the interval teardown, and the audio level-monitor leak fixed in v0.5.8 now run on every commit under fake timers with no I/O.
- **[`docs/manual-test-checklist.md`](docs/manual-test-checklist.md)** — the honest list of what is still verifiable only on Windows with a real match: GDI capture across resolutions, DPI and monitors; the low-level keyboard hook and Caps Lock push-to-talk; click-through hit-testing; window geometry; the updater's exe swap; audio device switching. Each row names the automated coverage sitting next to it, and the page ends with what the automated suites explicitly do not prove. Run it before publishing a release.
- **Test sources are type-checked.** `tsconfig.json` covers only `src/`, so `tsc --noEmit` never looked at a single test file. `tsconfig.test.json` covers both; it is what `npm test` compiles against, and CI now runs it on every PR.

### Changed
- **Removed a scoring term from minimap self-identification that had stopped doing anything.** The tracker's blob scoring carried a "peer avoidance" penalty meant to push the lock away from allies, but no ally coordinates have reached a client since the v0.2 refactor moved volume computation to the server, so the term scored a constant for every candidate and could not rank anything. The surviving weights are renormalized to keep the exact ratios they had, so which icon the tracker picks is unchanged. Clients are not going to start receiving ally positions — [`docs/threat-model.md`](docs/threat-model.md) now records why.
- **The `SCANNING -> LOCKED` log line now breaks the winning score down per signal** (`cls=`, `white=`, `ring=`) instead of printing the composite alone. Mis-identification is diagnosed from user debug logs, and the composite by itself cannot say whether the classifier or the white-pixel heuristic chose the icon.
- Debug-log lines written from the Rust side now use the same ISO-8601 UTC timestamps as the frontend's lines, so a log reads as one timeline. The keyboard hook also logs whether it actually installed (it previously claimed success unconditionally, before the install had even been attempted) and logs each push-to-talk / mute-key rebind.
- **Rate-limit rejections are no longer invisible.** A 429 wrote a response and nothing else, so an operator whose proxy configuration had quietly collapsed every user into one rate-limit bucket saw a fleet of users with no proximity audio and an empty `docker logs`. The server now prints one aggregate line a minute whenever anything was rejected — counts by reason, plus how many distinct buckets each limiter is holding, which is the tell for exactly that failure — and prints the trust-proxy mode it resolved at startup. The line carries no addresses and no player names; the one existing log line that did print a raw IP (the per-IP WebSocket rejection) no longer does.
- `main::get_screen_size` is gone from the Tauri command surface, replaced by `game_window::get_game_window_info`. Its only caller was the session start-up path.
- **Minimap capture no longer round-trips through base64.** Each 30 Hz frame was built into a BMP, base64-encoded, handed to the WebView as a data URL, decoded back to a string, decoded again as an image, drawn to a canvas and read back out — all on the window message loop. The frame now crosses as raw RGBA bytes and the grab runs on a blocking worker, so those six full-frame passes per tick are gone and a slow grab can no longer starve the overlay's click-through polling loop, which shares that runtime. This is not a bandwidth change — the raw bytes are about the same size as the base64 string they replace — it is CPU. Nothing about what is captured (the same minimap rectangle) or where it goes (nowhere; it never leaves the machine) changes.
- **The debug filtered-image thumbnail is only encoded while Debug is on.** It was PNG-encoded five times a second and re-broadcast over the Tauri event bus at the scan rate even though the overlay discarded it with Debug off.
- **The champion classifier now scores every minimap icon in one pass.** It ran the 173-class ONNX model once per teal icon — up to five sequential WebAssembly inferences per scan, each paying its own call, allocation and output-copy overhead — on the same thread that paints the overlay panel. It now packs the icons into a single batch and runs once. The model has no cross-sample layers, so the per-icon scores are identical; only the per-run overhead goes away.
- **Debug logging writes to disk in batches instead of one IPC call per line.** With Debug on, every `console.*` call made its own round trip into Rust and its own file flush, and because those calls were fired without waiting, lines could land in the file out of order. Lines are now queued and shipped at most every 250 ms with only one write outstanding at a time, so the file reads in emission order. Errors still go out immediately. The trade-off: up to a quarter-second of buffered lines can be lost when the app closes — closing the panel exits the process from the Rust side, so nothing in the web view gets a chance to ship the tail. Errors flush the moment they are logged, so they are only at risk if the process dies in that same instant. If a log ends mid-sentence, that is this window, not a crash.
- **`TrackingService` takes its frames from an injectable source and its classifier through an interface**, and its per-frame tick is a public, awaitable method. No behaviour change in the app: the defaults are the Tauri capture command and the ONNX classifier, constructed exactly as before. The one piece of the CV pipeline that needs a canvas — building an `ImageData` for the classifier — now lives in the classifier itself, so every stage between capture and scoring is plain array work.
- **The orchestrator takes its game state, signaling, audio, tracking, classifier and volume client through injectable factories**, and its three loop periods through one timings record. Every default is the expression that was inline before, so `new Orchestrator()` — the only construction the app itself performs — is unchanged. `AudioService` likewise takes the peer-connection constructor as an optional argument, defaulting to the real one. `Orchestrator` also gains a `stop()` counterpart to `start()`, which clears the game-state poll nothing previously cleared; the app has no shutdown path that calls it yet.

### Notes for self-hosters
- The signaling server now pings idle WebSocket connections every 30 s. If your reverse proxy has a shorter idle timeout you no longer need to configure one for keep-alive, and `HEARTBEAT_MS` can tighten the interval (values below 100 ms, or any non-numeric value, fall back to the 30 s default).
- The nginx snippet in the self-hosting guide was missing `X-Real-IP` and `X-Forwarded-For`. nginx sends neither unless told to, so anyone who copied it was rate-limiting their whole user base as a single client at the proxy's address — a global 20-connection WebSocket cap. The snippet is fixed; if you run nginx, compare it against your config. One new env var, `TRUST_PROXY`, describes how many reverse proxies of yours sit in front (unset = 1, a number, or `off`); note that `scripts/deploy-server.sh` never touches the remote `docker-compose.yml`, so it has to be set on the host itself.

## [v0.5.8] — 2026-09-17

### Fixed
- **Tracking no longer freezes in place when the champion classifier can't recognise your champion (#13).** The tracker would lock onto your icon and then reject that same icon on the very next frame — one tick after locking, sitting in exactly the same spot — because the classifier scored it below the follow threshold. The result was a permanent lock → hold → re-acquire → lock cycle in which the broadcast position never moved off the lock point. Frame-to-frame continuity now wins inside roughly one icon-diameter of where the icon was predicted to be; the classifier still has to vouch for candidates further out, which is what keeps the marker off minion waves and turrets.
- **Enemies are audible again for affected players.** Downstream of the above: a frozen position meant the coordinates being broadcast were stale (often still at the fountain), so every enemy landed outside the 1350-unit hearing range and was dropped from the volume response. Teammates were unaffected, because ally voice is full-volume and skips the staleness check — which is exactly the "allies are perfect, enemies are way too quiet" report.
- **The overlay no longer resizes its own window ~30 times a second.** The panel pushed a new window height to the backend on every frame in which its DOM was rewritten — which is every tracking tick — without checking whether the height had actually changed. It now only resizes on a real change. This was the bulk of the CPU cost of running with Debug on, and it was flooding debug logs at roughly 2 MB per minute, truncating the parts of the log that mattered.
- **Fixed an audio-meter leak across games.** Each session started a level-monitoring loop that was never stopped, so a second game left two running, a third left three, and so on for the lifetime of the process — each still logging against a closed audio context.
- **Output-device selection now reliably applies to peer audio.** The sink was being set on a peer's audio element before that peer's stream had any track, which the browser rejects; it is now applied (and retried) once the track arrives. Symptom was a peer playing on the system default device instead of the one picked in Settings. Switching **back** to "Default" also works now — it previously did nothing, leaving peers on the device you had picked before.
- **Dragging the Scan Rate slider no longer restarts tracking on every pixel of the drag** — the backend hears the value you settle on.

### Added
- **Voice on camera** toggle (Settings): hear the map from wherever your in-game camera is looking instead of from your champion, so you can pan across a fight and listen in. Listen-only — it changes what you hear and never what other players hear from you — and it falls back to your champion's position whenever the camera rectangle isn't readable on the minimap. **Off by default.** (#36)

  This one is a deliberate exception to the "no fog-of-war reveals" line in the compliance doc: a free camera can be pointed at ground you have no vision of. [`docs/compliance.md`](docs/compliance.md) spells out the reasoning, and the setting is a single self-contained toggle. Leave it off for ranked play.

### Notes for self-hosters
- Needs the matching server build, which accepts an optional `listenPosition` on `/compute-volumes`. Back-compat both ways: older clients simply omit it and are scored from their champion as before, and an older server ignores it, so deploy order does not matter.

## [v0.5.7] — 2026-07-09

### Fixed
- **Restored push-to-talk out of the box (#27).** v0.5.6 changed the default push-to-talk key to unbound, which left push-to-talk users unable to transmit (no key was bound) so they could not hear each other. Reverted to the previous Caps Lock default so voice works again; a cleaner fix for the Caps Lock capture that does not strip PTT from people who use it will follow.

## [v0.5.6] — 2026-07-09

### Fixed
- **Caps Lock is no longer captured by default (#27).** Push-to-talk shipped bound to Caps Lock, and the keyboard hook cancels that keys toggle while it is the PTT key, so Caps Lock silently stopped working. PTT is now unbound by default; bind any key (Caps Lock included, if you want it) in Settings.
- **Proximity volume no longer flaps to silence on brief drop-outs (#27).** A single dropped position update on a lossy or VPN connection used to blip a peer to silence and back; the client now holds the last volume for a short grace window before fading, which smooths voice on unstable links.

## [v0.5.5] — 2026-06-24

### Changed
- Champion classifier retrained on the current-patch Community Dragon icon set (game patch 16.13.1).

## [v0.5.4] — 2026-06-15

### Added
- **Ally proximity** toggle (Settings): hear teammates by distance (the same vision-range falloff as enemies) instead of always at full volume. Off by default; takes effect on the next position update, no reconnect needed. (#22)

### Notes for self-hosters
- Needs the matching server build, which adds an optional allyProximity flag to /compute-volumes. Back-compat: older clients omit the flag and keep full-volume allies, so deploy order does not matter.

## [v0.5.3] — 2026-06-10

### Fixed
- Double/echoing voices and overly quiet allies/enemies. Peer voice was unintentionally playing through two audio paths at once (an HTML audio element plus a WebAudio gain node); it now uses a single path, so there's no echo and levels are correct.

## [v0.5.2] — 2026-06-06

### Changed
- **Relicensed from PolyForm Noncommercial 1.0.0 to the GNU AGPLv3** — now free and open source with network copyleft (commercial use allowed; modifications, including server-side, must be shared under the AGPLv3).
- Routine champion-classifier refresh against the current Community Dragon icons — no functional tracking change (upstream re-encoded the icon files).

## [v0.5.1] — 2026-06-05

### Changed
- Champion tracking classifier rebuilt on Community Dragon's official champion icons (replacing the prior icon source). Equivalent-or-better tracking, and new champions and skins are now picked up automatically.

## [v0.5.0] — 2026-06-04

### Changed
- **Champion tracking reverted to the v0.3.1 classifier.** The whole v0.4 line — NCC/SSIM template matching (v0.4.0), then a teal ring/annulus detector with an angular-coverage gate — turned out more brittle in real games than the classifier it replaced: it under-locked (holding/stale between locks) and drifted onto minion lanes, turrets, and the occasional ward/effect ring, especially on the small minimap where dense minion clusters defeat the coverage gate. Real-game testing showed the pre-v0.4 classifier keeps the dot on your champion noticeably better, so tracking is restored to v0.3.1's implementation (its known-bad v0.3.0 confidence gates were already removed). Every non-tracking improvement since v0.4.0 is kept — including the contamination fix below.
- **Cross-team (enemy) proximity is now a single vision-range falloff.** Enemies fade in very faintly at roughly a champion's sight range (~1350u) and get louder as they close, replacing the old two-tier scheme (audible only within ~600u by default, ~1200u with a toggle) which felt too close. Allies are unchanged (always full volume).

### Fixed
- **No proximity audio when two or more players shared one network** (a household or premade on a single public IP). The server rate-limited the volume endpoint per IP, so multiple clients behind one NAT blew the limit and *every* request came back 429 — the client never received peer volumes, so everyone was silent. The limit is now keyed per player (IP + name) and sized for the maximum scan rate, with a per-IP backstop against abuse; players sharing a network each get their own budget.
- **The Debug tracking dot corrupted tracking while Debug was on.** The desktop capture the tracker analyzes included the overlay, so the red position dot was fed back into the computer-vision input as a spurious blob. It no longer renders into the captured region.

### Removed
- **"Hear enemies at full vision range" setting.** Cross-team hearing is always on at vision range now (see Changed), so the toggle and its plumbing are gone.
- The v0.4 computer-vision scaffolding (template-matching module, HSV color-detect module, Data Dragon icon templates) and the Debug "Harvest CV crops" tooling, all of which existed to support the now-reverted template/annulus tracker.

## [v0.4.4] — 2026-06-03

### Fixed
- **Tracked position occasionally teleported across the map (broadcasting a wrong location, breaking proximity audio).** With detection + identity now solid (v0.4.0–v0.4.3), the remaining failure was the *re-acquisition* logic: when your champion briefly wasn't found near its predicted spot, the tracker grabbed the highest-scoring blob **anywhere on the minimap** — and it scored blobs on a *relative* (normalized, best-blob = 1.0) confidence that can't tell the real champion from the least-bad of a frame full of wrong blobs (minion dots, ally icons the looser v0.4.3 detection now also picks up). So it would lock onto a far wrong blob and snap your position to the opposite corner. Both the long-range re-acquisition and the SCANNING→lock transition now also require **absolute** template-match confidence (the raw SSIM score, which real champion blobs clear at 0.56–0.65 while wrong blobs top out ~0.49). Below that bar the tracker holds/extrapolates or keeps scanning rather than chasing a wrong blob — so position stays put instead of teleporting. (This gate is safe only because template matching is reliable; the old 172-class classifier was too weak to gate on, which is why v0.3.1 reverted a similar attempt.)

## [v0.4.3] — 2026-06-03

### Fixed
- **Champion tracking dropped the icon intermittently ("clinging" / loss-of-lock), and was fragile across different in-game display settings.** The minimap color detection that finds your champion's ring was tuned with absolute RGB thresholds that assumed a *dark* teal — but analysis of real harvested icon crops showed the ally ring is actually a *bright* cyan, so the old test rejected ~80% of the ring and left the tracker frequently losing it. Rewrote detection in **HSV**, keying on the cyan/red *hue* (which is stable under brightness/contrast/gamma) with loose saturation/value floors. On the real crops this detects ~4-5× more of the ring per frame and stays robust across simulated gamma (0.7–1.5) and saturation (60%) shifts, where the old RGB threshold collapsed. This should noticeably reduce loss-of-lock for everyone, regardless of their League brightness/contrast/gamma settings.

## [v0.4.2] — 2026-06-03

### Added
- **Settings → Debug → "Harvest CV crops" toggle.** Makes the crop harvester (added in v0.4.1) actually usable without devtools — flip it on from the UI when Debug is on, and it applies to the running game immediately. Saves ~1 labeled crop / 3s of your champion icon to `%LOCALAPPDATA%\com.proxchat.app\harvest\` for tuning CV detection. Off by default.

## [v0.4.1] — 2026-06-03

### Fixed
- **Debug thumbnail clipped at the bottom on scaled displays (#11 follow-up).** The dynamic overlay-window resize treated the panel's logical (CSS) height as physical pixels, so a 125%/150%-scaled laptop got a too-short window that cut off the debug thumbnail (a 100%-scaled monitor was unaffected). The height is now scaled by `devicePixelRatio` before sizing the window.

### Added
- **Opt-in CV crop harvesting (Debug-only developer tooling).** With Debug on and `localStorage 'lolproxchat.harvest'` set to `true`, the tracker saves labeled crops of your champion icon to `%LOCALAPPDATA%\com.proxchat.app\harvest\` during games, to build a real labeled dataset for measuring tracking accuracy. Off by default, zero cost otherwise. Paired with `scripts/eval_real_crops.py` (classifier vs SSIM template matching on real crops). See [CONTRIBUTING](CONTRIBUTING.md#measuring-cv-tracking-accuracy-real-data).

## [v0.4.0] — 2026-06-03

### Changed
- **Champion tracking now matches against the actual champions in your game instead of a trained classifier.** At game start the app fetches the 10 match champions' icons from Riot's Data Dragon CDN and identifies minimap blobs by **SSIM template matching** against them, rather than running a 172-class neural classifier on every frame. This is the v0.4 CV overhaul ([research + rationale](docs/plans/2026-06-03-cv-tracking-research.md)), and it directly targets the failures seen in real games:
  - **No more clinging to minions and structures** — a minion dot or turret icon has essentially zero structural similarity to a champion portrait, so it's rejected outright. The old classifier had to actively distinguish them and often failed.
  - **No per-champion weak spots** — every champion is matched against its own real icon, so there's no "the classifier is bad at Teemo" failure. (The tricky names that broke the old classifier — Nunu & Willump, Dr. Mundo, Wukong — resolve natively.)
  - **Closes the synthetic-to-real gap** — matching against the real in-game-derived icon removes the "trained on clean wiki art" mismatch entirely.
  - **Lighter** — SSIM against 10 templates is far cheaper than a 172-class CNN per frame; the neural model is off the hot path.
- Approach ported from the open-source [LOL_Minimap_Tracker](https://github.com/Quinntana/LOL_Minimap_Tracker) (grayscale SSIM, best-of-N selection, low acceptance threshold).

### Fixed
- (carried in v0.3.1) Stuck-gain proximity bug + reverted CV-tuning regressions.

### Notes
- The 172-class ONNX classifier is retained only as a **fallback** for when the icon fetch fails (offline / CDN down). It will be removed in a future release once template matching is proven in the wild — please report tracking behavior.
- Requires a one-time per-game fetch of ~10 small icons from `ddragon.leagueoflegends.com`.

## [v0.3.1] — 2026-06-03

### Fixed
- **Enemy stayed audible at full volume after moving out of range ("hears me no matter where on the map").** The v0.3 server correctly drops cross-team peers beyond the 600u cap (and stale-position peers) from the `/compute-volumes` response entirely, but the client only updated peers *present* in the response — a peer once heard within range kept its last gain forever. Now any connected peer absent from the response is silenced. (In v0.2 the server always returned far peers at volume 0, so the client never had to handle absence.)
- **Tracking clung to minions and structures / refused to lock on for some champions.** Reverted three v0.3.0 computer-vision tweaks that were tuned narrowly to one user's logs and regressed the general case:
  - The classifier-confidence EMA "snap-up" latched onto a single false-high frame from a wrong blob (a minion dot, a turret icon), making the tracker confidently follow it. Reverted to a standard smoothed average.
  - A lock-acceptance gate hard-blocked tracking from locking on whenever classifier confidence was low — normal for champions the classifier is weak on (e.g. Teemo) — so it never locked and never broadcast a position. Removed; the classifier still contributes to scoring, it's just no longer a veto.
  - A post-lock coordinate-suppression window kept stale positions on the server for weak-classifier champions, so peers couldn't hear them. Removed.

### Changed
- **MIC / VOL buttons indicate mute via color only** — the label stays "MIC" / "VOL" instead of switching to "MIC OFF" / "ALL OFF", so the button row doesn't reflow.

### Notes
- A ground-up CV overhaul (per-game template matching against the actual 10 champion icons, replacing the 172-class classifier) is planned for v0.4 — see [`docs/plans/2026-06-03-cv-tracking-research.md`](docs/plans/2026-06-03-cv-tracking-research.md). v0.3.1 stops the regressions in the meantime.

## [v0.3.0] — 2026-06-02

### Changed
- **Tiered proximity audio (default-config behavioral change).** Team voice is now always full volume regardless of in-game distance (allies already see each other on the minimap — no info leak). Cross-team voice is capped at ~600 game units by default (auto-attack range) instead of the previous 1200 (champion vision range). A new Settings toggle **"Hear enemies at full vision range"** opts in to the old 1200u behavior for users who want the full social experience. The filter is enforced server-side — a modified client cannot bypass the team or range cap because out-of-toggle peers are simply absent from the `/compute-volumes` response. Volume curve uses the full 1200u falloff in both modes, so a peer at distance X sounds the same loudness regardless of toggle state. Full design rationale in [`docs/plans/2026-06-02-v0.3.0-design.md`](docs/plans/2026-06-02-v0.3.0-design.md).
- **PTT global hotkey now works in-game (#1).** Replaced `tauri-plugin-global-shortcut` (which used `RegisterHotKey` — intercepted by LoL's DirectInput layer) with a `SetWindowsHookExW(WH_KEYBOARD_LL)` hook on a dedicated message-pump thread. Same technique Discord/Mumble/OBS use. Default PTT key is **Caps Lock** with a synthetic-input-based LED flip-back so the keyboard light doesn't toggle on every press. Both PTT and toggle-self-mute keys are now rebindable from **Settings → PTT Key / Toggle-mute Key**.

### Added
- **Settings → Hear enemies at full vision range** toggle.
- **Settings → PTT Key / Toggle-mute Key** rebind UI. Click to capture a key; common LoL bindings (Q/W/E/R/D/F/B/P) and modifier-only keys are rejected with a brief warning.
- **CV tracking improvements driven by IXAM's v0.1.33 issue #7 logs:**
  - 5-second cap on continuous holds. Beyond that, the tracker drops back to SCANNING for a full classifier-driven re-acquisition instead of extending the search box. IXAM's logs showed 44-second holds during which the orchestrator was sending phantom coords.
  - Classifier-EMA recovery: a single confident raw score now snaps the EMA up to that value instead of decaying. Prevents a couple of poisoned-to-0 samples from leaving the EMA stuck at 0 for the rest of a 4-minute session.
  - `shouldAcceptLocked` gate on SCANNING→LOCKED transitions: requires either confident composite + classifier-EMA agreement OR a high candidate raw classifier score. Refuses the composite-only "wrong-icon LOCK" pattern that IXAM's logs showed (composite=0.42, classifier=0.00, immediately followed by 8s+ holds).
  - Orchestrator suppresses coords broadcasts for the first 3s after a fresh LOCK if classifier EMA is still near 0 (defense-in-depth against a bad LOCK that holds position without entering the hold-gated path).
- **Debug thumbnail no longer overflows the Settings panel (#11).** Overlay window now dynamically resizes to fit panel content (Settings expanded / Debug thumbnail visible / peer list grown). Click-through hit-rect updates in lockstep so clicks below the shrunk panel pass through to the game.

### Fixed
- Per the above CV improvements, the failure modes from #7's most recent v0.1.33 log set (long holds, classifier-poisoned EMA, composite-only false-LOCK) should no longer manifest.

### Removed
- `tauri-plugin-global-shortcut` dependency (replaced by the custom `WH_KEYBOARD_LL` hook).

### Notes for self-hosters
- Server is back-compat with v0.2.x clients (a v0.2 client omits `team` on join, server falls back to legacy team-blind 1200u behavior). **Deploy server first**, then release the v0.3 client — same rolling deploy pattern as v0.2.0.
- `ENCRYPTION_KEY` remains optional (only needed for legacy v0.1.x clients).

### Deferred to v0.3.1
- Mouse-button PTT binding (`WH_MOUSE_LL`).
- CV model retrain (fresh scrape + retrained ONNX). Code-side improvements above ship now; the retrain is queued.

## [v0.2.1] — 2026-06-02

### Fixed
- **Champion classifier failed for Nunu & Willump and Dr. Mundo players (#7).** The LCU Live Client Data API returns display names (`"Nunu & Willump"`, `"Dr. Mundo"`) but the classifier label file is keyed by sanitized asset names (`"Nunu"`, `"Dr_ Mundo"`). Exact-match lookup returned `localClassIndex=-1`, every scored blob came back `0.000`, and CV never disambiguated the player's icon after the first SCANNING→LOCKED transition — root cause of the "Woosemines never broadcasts position" symptom in the v0.1.33 issue #7 logs. Added a small display-name → label-name normalization map and lifted the resolver into a pure static for unit testing. Confirmed Wukong is unaffected (display name matches the label directly).

### Added
- `tests/services/champion-classifier.test.ts` — 6 tests covering exact match, normalization for Nunu/Dr. Mundo, Wukong-resolves-directly, and a guard that fails if a future model retrain drops one of the normalized target labels. Client tests now 74 (was 68).

## [v0.2.0] — 2026-06-02

### Changed
- **Positions now flow client → server, not peer-to-peer (wire-protocol change).** Replaces the AES-GCM-encrypted-XY-over-WebRTC-data-channel exchange with a direct `coords` WebSocket message; `/compute-volumes` reads peer positions from in-process room state. Removes the entire peer-to-peer position transport — no more blob exchange, no more clock-skew rejections, no more "blob lagging behind" symptoms (closes the root causes of #13 and the design concern raised in #15 by making the encryption layer no longer load-bearing). Server keeps the old `{myPosition, peers}` request shape working so v0.1.33-and-earlier clients keep functioning during the rollout window. See [`docs/plans/2026-06-02-server-side-positions.md`](docs/plans/2026-06-02-server-side-positions.md) for the design.
- **Stale-position window tightened from 60 s → 5 s.** Client sends coords on every ~100 ms position tick and stops sending after CV has been holding/extrapolating for >2 s; the previous 60 s window was loose enough that a peer who hard-disconnected could still affect proximity audio for a full minute. 5 s gives ~3 s of phantom audio worst case while absorbing brief WSS stalls without flickering peers silent.

### Fixed
- **Per-player volume slider felt "clicky" / needed re-grabbing every tick (#12).** The overlay was re-appending every player row to the DOM on every `broadcastOverlayState` event (~10 Hz), which detaches the slider's host element mid-drag and breaks the pointer-event sequence in Chromium. The render loop now diffs the desired peer order against the current DOM order and only reorders when they actually differ — the common case (no change) is a no-op, the slider stays dragged.

### Removed
- `src/services/data-channel.ts` and the entire data-channel surface on `PeerConnection` (`createDataChannel`, `sendData`, `onDataMessage`, `ondatachannel` handler). The WebRTC peer connection now carries audio only.
- `audio.ts` no longer opens a data channel before issuing the offer — the SDP has no `m=application` section in v0.2.0+.

### Notes for self-hosters
- Server is back-compat with v0.1.33 clients. Deploy the server first; clients can roll on the next release without downtime.
- Once all clients in your community are on v0.2.0+, you can remove `ENCRYPTION_KEY` from the server env and (eventually) delete the legacy `computeVolumes` / `encryptPosition` / `decryptPosition` paths from `server/src/volumes.ts`. Not urgent.

## [v0.1.33] — 2026-06-02

### Fixed
- **Per-row volume slider (#12).** Bumped width 50→80 px, thumb 10→14 px, track height 4→6 px. The old 50 px slider for a 0-100 range gave ~0.5 px per value step, which felt like clicking through discrete steps rather than dragging smoothly. Now drags continuously.

### Changed
- **Server: reverted volume quantization + jitter from v0.1.26 (#14).** `calculateVolume` now returns continuous quadratic falloff (`1 - (d/MAX)²`) directly — no 5-bucket snapping, no ±5% jitter. The original anti-cheat rationale (limit a modified client's distance precision) was marginal at our user scale, and the audible "cliffs" when peer CV jittered between adjacent teal blobs in real gameplay (visible across issue #7 and #13 logs) made the smoothness cost dominate. The continuous output is deterministic; the client-side EMA smooths transitions naturally without bridging large cliffs.
- Server tests rewritten to assert continuous behavior + a determinism check (same input = same output). Total server tests now 47 (was 46).

### Removed
- `VOLUME_BUCKETS`, `quantizeVolume`, and `jitterVolume` from `server/src/volumes.ts`. No public API change — the `/compute-volumes` response shape is unchanged.

## [v0.1.32] — 2026-06-02

### Fixed
- **Per-row volume slider now respects real proximity.** Moving the slider used to immediately play the peer at `slider × 1.0` (hardcoded proximity) before the next 100 ms position tick dropped them back to whatever proximity actually was. Caused a fraction-of-a-second blip of audible playback on each slider movement even when the peer was supposed to be silent. The slider now reads the last server-returned proximity volume from `lastProximityVolumes` and applies on top of it. (`#7`)

### Changed
- **Server: `BLOB_MAX_AGE_MS` widened from 10 s to 30 s.** The L7 logging added in v0.1.31 confirmed that even modest Windows-clock drift (~10-15 s, surprisingly common in the wild) was causing the server to reject every position blob from one user in a session, breaking proximity audio asymmetrically with no obvious failure at the connection layer. 30 s absorbs typical drift; the security tradeoff is a longer replay window for captured blobs, but the volume side-channel is already coarsened by quantization + jitter (v0.1.26).

### Added
- `computeFinalPeerVolume(proximity, slider)` exported from `audio.ts` as a pure helper so the slider math is unit-testable without spinning up AudioService + PeerConnection + WebAudio.
- 6 new tests for the helper (`tests/services/audio.test.ts`): clamping, proximity-0 always-silent, slider-0 always-silent, identity. Client tests now 68 (was 62).

## [v0.1.31] — 2026-06-02

### Security
- **Closed: updater URL injection (H1).** `download_and_apply_update` now refuses any URL that doesn't start with the GitHub release-asset prefix for this repo (`https://github.com/danthi123/LoLProxChat/releases/download/`). Without this check, a compromised frontend could have called the command with an attacker-controlled URL → download + spawn arbitrary binary → full RCE on the user's machine. See [`docs/threat-model.md`](docs/threat-model.md) Part 2 § Update flow.
- **Closed: arbitrary file read (H2).** Renamed `read_text_file(path)` → `read_league_config_file()`. The new command takes no arguments; the path is computed Rust-side from `find_league_install_dir()` and reads only `Config/game.cfg`. Removes the arbitrary-file-read primitive that the frontend used to inherit.

### Added
- `server/src/rate-limit.ts` — in-memory token-bucket + per-IP concurrency limiter. No external dep; ~150 LOC. 13 new server tests (`server/tests/rate-limit.test.ts`).
- `server/src/index.ts` and `server/src/ws-handler.ts` wired through the new limiters: per-IP rate limiting on `/turn-credentials` (60/min) and `/compute-volumes` (15/sec sustained, 30 burst); 256 KB body cap on `/compute-volumes`; WebSocket `maxPayload` 64 KB, 20 concurrent connections per IP, 60 msg/sec sustained per connection. Total server tests now 46 (was 33).
- Clock-skew rejections in `decryptPosition` now emit a structured `[volumes]` warn line with the actual blob age. Was silently returning null, which masked some intermittent voice-issue reports.

### Changed
- `lcu::read_text_file` removed from the Tauri command surface; superseded by `lcu::read_league_config_file`. Sole caller (`Orchestrator.readMinimapScale`) updated to use the new command; the `leagueConfigPath` field on `Orchestrator` is gone.

## [v0.1.30] — 2026-06-02

### Changed
- `[Tracking] WARN: position jumped …` now requires both a distance threshold (>500 game-units) AND the existing speed threshold (>2000 u/s) to fire. Previously the speed-only gate produced ~100 false-positive warnings per 5-minute session of normal play (CV pixel-jitter on a stationary champion at high scan rates registered as 2000+ u/s instantaneously). Real recall / teleport / mis-track events still warn.
- Promoted the warn thresholds to named `JUMP_WARN_MIN_UNITS` / `JUMP_WARN_MIN_SPEED` static constants on `TrackingService` for tunability and grep-ability.

### Added
- Two new test cases in `tracking.test.ts` pin the new gating: pixel-jitter at high scan rate now correctly stays silent, and a large-but-slow movement (600 units over 1.5 s) confirms the speed gate still works.

## [v0.1.29] — 2026-06-02

### Changed
- **Internal refactor — no user-visible behavior change.** `TrackingService.handleLocked` reduced from 158 lines to ~65 lines of orchestration. Pure scoring/selection math extracted to a new `src/services/tracking-helpers.ts` module (`computeMaxJumpPx`, `computeReacquireThreshold`, `computeBlobScore`, `pickBestBlobInRange`, `pickClassifierReacquisition`). The phase-2 and phase-1 success paths split into named methods (`acquireViaClassifier`, `finalizeLockedFrame`) so the side-effect ordering is explicit. State-mutation ordering preserved; the 42 pre-existing tracking/audio/devices tests still pass against the refactor.
- Extracted the `Blob` interface to its own `src/services/blob-types.ts` so the pure helpers can import it without reaching back into `tracking.ts`.

### Added
- 19 new unit tests for the extracted helpers, covering boundary conditions the inline code never had isolated coverage for: jump-radius minimums, hold-expansion math, stationary-vs-hold threshold interaction, classifier-on-vs-off scoring symmetry, jump-range exclusion. Total client tests now 61.
- `src/core/window-globals.ts` — typed `declare global { interface Window { … } }` for the two app-specific properties used as an ad-hoc cross-module bus. Removes the 4 `(window as any).foo` casts that existed in `overlay.ts`, `background.ts`, and `orchestrator.ts`.

### Removed
- All 7 `as any` casts in `src/` source code. Remaining 5 casts are in `tests/` only (legitimate test-environment mocks and private-method reflection). Dropped 3 vestigial `(console as any).debug` casts in `core/logging.ts` — `console.debug` has been in TS's standard `Console` interface for years.

## [v0.1.28] — 2026-06-02

### Added
- Client-side test coverage for `nextSmoothedVolume` (peer-connection EMA), `setLastPosition` jump-warning behavior (tracking), and `listAudioDevices` synthetic-entry filtering (devices). 42 client tests across 7 files.

### Changed
- Extracted `nextSmoothedVolume` from `PeerConnection.setVolume` as a pure function at module scope so the EMA math can be unit-tested without instantiating a real `RTCPeerConnection`.

### Fixed
- Autoplay-blocked path in `PeerConnection.tryPlay` now logs the peer name and rejection reason instead of swallowing the error silently. Both the initial attempt and the user-gesture retry are visible in debug logs.

### Removed
- `src/core/proximity.ts` and its test — dead client-side proximity math that disagreed with the (now authoritative) server quadratic + bucketed falloff. Footgun for any future code that might have re-imported it.
- `src/core/types.ts::MAX_HEARING_RANGE` — only referenced by the deleted proximity module.
- `src/core/template-match.ts` (~112 lines) and its test — leftover from a pre-classifier CV iteration. Zero callers.
- `src/services/updater.ts::applyUpdateWhenSafe` — uncalled export.
- `src/services/orchestrator.ts::captureCalibrationData` and `resolveLeagueConfigPath` — uncalled dead methods. Both bore stale TODO comments; the install-path one is already solved at session-start via `get_league_install_dir`.

### Security
- Resolved 8 CVEs (1 critical) in `onnxruntime-web`'s transitive `protobufjs` dependency. `npm audit --omit=dev` now reports zero vulnerabilities. Remaining moderate audit findings are in dev-only deps (`jimp`) and don't ship in the exe.

## [v0.1.27] — 2026-06-02

### Added
- `Settings → Hide IP (Force TURN)` toggle. Sets `iceTransportPolicy: 'relay'` on new peer connections so peers never see the user's public IP — voice routes through the TURN relay instead of direct P2P. Default off; adds ~20-100 ms latency.
- `docs/threat-model.md` Part 2: user-facing threat coverage (public IP exposure, server-operator trust, summoner-name visibility, code-signing absence, WebView2 trust, signaling presence enumeration, voice-in-transit). Plus a "what we don't collect" baseline (no analytics, telemetry, fingerprinting, or persistent user IDs).

## [v0.1.26] — 2026-06-02

### Changed
- HSV-filtered minimap debug image moved off the scanner window into a thumbnail in the Settings panel. Eliminates the capture-feedback loop that previously required `WDA_EXCLUDEFROMCAPTURE`.
- Server-side volume math quantized into 5 buckets (`0`, `0.20`, `0.45`, `0.75`, `1.0`) with ±5% multiplicative jitter. Reduces the precision a modified client can extract from continuous volume values. Audio quality unchanged — client EMA still smooths bucket transitions.
- Signaling server now defaults to Cloudflare Realtime TURN. Self-hosted coturn remains supported as a documented fallback.

### Fixed
- ShadowPlay, Nvidia Game Bar, and OBS now capture the app correctly regardless of Debug state (`#2`). `WDA_EXCLUDEFROMCAPTURE` removed entirely.

### Added
- SHA-256 hash of each release exe included in the release body going forward. Per-OS verification commands inlined for ease.
- `docs/threat-model.md` covering cheat / information-leak threats and the rationale behind current calibration.

## [v0.1.25] — 2026-06-02

### Added
- Rolling log retention: keep last 3 sessions (`lolproxchat.log` / `.1.log` / `.2.log`). Restarting the app no longer wipes a session's diagnostics (`#9`).

### Changed
- Verbose `applyPeerVolumes` log throttled to 1 Hz or on summary change (was 10× per second).
- Default `targetVolume` in `PeerConnection` set to 0 instead of 1. Fixes "hear peer at full volume across the map" during the SCANNING phase when the orchestrator's passthrough only sets ally volumes.

## [v0.1.24] — 2026-06-02

### Added
- Auto-recover from WebRTC ICE failure. Initiator re-issues an offer with `iceRestart: true` on `connectionState === 'failed'`. Capped at 2 attempts per peer; counter resets on successful re-connect.
- Per-peer `getStats()` snapshot every 10 s logged in debug mode (connection state, ICE state, selected candidate pair with IP/port/type, RTT, bytes sent/received, packets lost).

### Changed
- `extrapolatePosition` caps velocity magnitude at 10 px/tick before applying. Prevents the runaway where a single CV jump could drift the tracked position 12000 game-units in 500 ms.

### Fixed
- Closing any window now exits the app cleanly (`#8`). Previously closing the panel left the click-through scanner window orphaned over the minimap.

## [v0.1.23] — 2026-06-01

### Added
- `[Tracking] WARN` log when local position changes faster than 2000 game-units/sec — catches CV mis-tracking events that previously had to be inferred from raw position dumps.
- Explicit log line when a peer is created via incoming WebRTC offer (previously only the "Peer joined" path logged the connection).

### Changed
- Per-peer volume EMA alpha capped at 0.3 so even long silent gaps ramp in over multiple ticks instead of snapping to a loud value.

## [v0.1.22] — 2026-06-01

### Added
- Mic and speaker device picker (`Settings → Input Device / Output Device`), persisted to localStorage. Input changes swap the WebAudio source in place — no WebRTC renegotiation needed. Output uses `AudioContext.setSinkId`. (`#6`)
- `Settings → Debug Logs → OPEN` launches Explorer at `%LOCALAPPDATA%\com.proxchat.app\` for one-click log access.

### Changed
- Log file renamed `proxchat.log` → `lolproxchat.log` for post-rename consistency.

## [v0.1.21] — 2026-06-01

### Added
- `src-tauri/capabilities/default.json` granting `core:window:allow-start-dragging` + event emit/listen. Tauri 2 silently denies built-in plugin IPC without an explicit capability — this is why title-bar drag never worked before.
- Mute / mute-all toggles persisted on `Orchestrator` so they survive between sessions and stay stable when toggled outside an active game.

### Changed
- Scanner window split out from the panel. Panel is the draggable UI; scanner is a separate transparent click-through window auto-pinned over the minimap.
- Panel cursor-position polling loop skips the click-through toggle while LMB is held so Windows' native window-drag doesn't get torn down mid-move.

### Removed
- Legacy `proxchat.exe` asset fallback in the auto-updater. New releases ship only `lolproxchat.exe`.

## [v0.1.20] — 2026-06-01

### Fixed
- ShadowPlay no longer turns off when the app is running (first-pass fix; full resolution arrived in v0.1.26).
- Detects League installed outside the default `C:/Riot Games/...` directory via the LCU lockfile path.
- Window drag works in some configurations (first attempt; capability-based fix landed in v0.1.21).

## [v0.1.19] — 2026-06-01

### Added
- Riot Developer Portal application approved (App ID 809090). README compliance section updated.

## [v0.1.18] and earlier

Initial public iteration: Overwolf → Tauri 2 migration, Supabase-stack → custom 1-container WebSocket signaling server, minimap CV pipeline (HSV color filter + blob detection + ONNX champion classifier), WebRTC P2P voice with AES-GCM encrypted position blobs computed server-side, in-app updater. See `docs/plans/` for the historical design + implementation documents from that period.

[Unreleased]: https://github.com/danthi123/LoLProxChat/compare/v0.4.4...HEAD
[v0.5.7]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.5.7
[v0.5.6]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.5.6
[v0.5.5]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.5.5
[v0.5.4]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.5.4
[v0.5.3]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.5.3
[v0.5.2]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.5.2
[v0.5.1]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.5.1
[v0.5.0]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.5.0
[v0.4.4]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.4.4
[v0.4.3]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.4.3
[v0.4.2]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.4.2
[v0.4.1]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.4.1
[v0.4.0]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.4.0
[v0.3.1]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.3.1
[v0.3.0]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.3.0
[v0.2.1]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.2.1
[v0.2.0]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.2.0
[v0.1.33]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.33
[v0.1.32]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.32
[v0.1.31]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.31
[v0.1.30]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.30
[v0.1.29]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.29
[v0.1.28]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.28
[v0.1.27]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.27
[v0.1.26]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.26
[v0.1.25]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.25
[v0.1.24]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.24
[v0.1.23]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.23
[v0.1.22]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.22
[v0.1.21]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.21
[v0.1.20]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.20
[v0.1.19]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.19
