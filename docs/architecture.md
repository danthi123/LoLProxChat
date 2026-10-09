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

Edge cases the state machine handles: champion deaths (see **Death** below), respawn at fountain (re-acquire via classifier), camera pan, overlapping icons in teamfights, minimap scale changes via `game.cfg` MinimapScale.

**Lost position.** A hold is the tracker admitting it does not know where we are. Past 2 s of a hold on a readable minimap with our icon missing (a recall, a teleport) — or 5 s when nothing on the minimap was readable at all (a capture failure), or, with no own-team icon anywhere on the minimap (a 1v1), when an enemy icon sits within an icon of where we vanished (most likely a cover the check below missed) — the orchestrator sends `coords` with `stale: true`, the server forgets the position immediately, and cross-team audio fades in both directions until tracking recovers. Allies are unaffected.

**Covered by an enemy icon.** In melee range the enemy's icon is drawn over ours, which looks like a hold but is not one. If our icon visibly shrank under an overlapping red icon before it vanished — a covered icon disappears over several frames, a teleport removes a full-size one at once — the tracker keeps reporting where that red icon was, without starting a hold, while a red icon stays there (0.5 s grace, 10 s cap), and skips long-range re-acquisition. It starts only on the first lost frame, never re-starts until we are found, and never follows the enemy. While an enemy icon covers only part of ours, the centre is measured from the uncovered edge. `tests/cv/tracking-simulation.test.ts` and `tests/cv/real-art.test.ts` (the real minimap; local fixtures) cover each case, including the ones earlier designs got wrong.

**Re-acquiring far away.** Phase 2 takes any teal icon the classifier ranks above an adaptive threshold (0.35-0.85), which was set for finding ourselves again nearby. The classifier's scores are normalized to the best icon in view and smoothed, so a model that recognises no one still drives one icon toward 1.0 — and across the map that teleported us (a 2026-10-07 log: top lane to bot lane on 0.64). An icon further from where we were last seen than we could have travelled (`reacquireReachUnits`: 2500 units plus 700 u/s of hold) now needs a smoothed score of 0.9 and a raw model output of at least 0.3 on its latest run; one in either base corner (a recall) keeps the ordinary threshold. Refusing leaves us holding, so the 2 s disown fades enemies out instead of placing us beside the wrong ones. The rescan after a hold runs out applies the same raw ≥ 0.3 to what counts as the classifier identifying an icon outside `rescanReachPx`.

**Locked on the wrong blob.** Phase 1 follows the nearest teal blob on continuity alone, so if our icon is briefly hidden (in the log that showed it, under an enemy's) right beside something static and teal (a ward), the lock can come out on it. The marker stays visible, so the lock stays put; a hold's Phase 2 would only fix it with a classifier that discriminates, and that rarely happened for the champion in the log (raw scores 0.000-0.03). Each classifier run (every 500 ms) is folded into evidence (`nextWrongLockEvidence`). A supporting run has the model discriminating at all, the followed blob ≤ 0.1 and a distinct blob 1.0 (normalized); silent runs are neutral, any other discriminating run resets. The preferred blob must be the same one each time (it may drift, as a walking champion does), supporting runs must come within 3 s of each other, and the followed blob must stay within a quarter of an icon of where the evidence started (so a champion standing still, or shuffling in place, is not protected by it). Six such runs spanning ≥ 4 s move the lock to the preferred icon. The stillness and same-blob conditions are what keep a weak classifier's noise from dragging a correct lock onto an ally; a champion standing still while the classifier is densely, consistently sure it is one particular ally is not protected. For what the classifier cannot catch, the panel's **Wrong position? → RESET** calls `resetPosition()`: back to SCANNING, and the scan's next lock skips the abandoned spot unless the classifier vouches for it or nothing else is on the minimap. The scan follows the abandoned blob (in steps of at most a quarter icon) and does not lock for the first 1.5 s; if that blob moves more than a quarter icon it is a champion, likely us, and the avoidance is dropped. If the avoidance did exclude something and nothing identifies us — no classifier signal, no movement path — the scan waits rather than lock an arbitrary ally, for up to 10 s (`RESET_AVOID_MS`); walking ends the wait. The avoidance ends at that lock. Since v0.5.23 the scan also starts as if the icon had been lost at the abandoned spot: an icon nothing identifies is taken only within walking reach of it (`rescanReachPx`), or in a base. The icon the user rejects is usually one beside theirs — a teammate they were stacked with — and a scan of the whole map put testers back in the wrong lane on every press. The camera pick (`cameraFavourite`) is the exception: after a RESET it may place us anywhere, since the user pressing it is most likely looking at their champion. The orchestrator disowns the old coordinates on its next tick, and RESET clears the last-seen position, so the player hears their team at full volume until found again (see "Volumes while lost" below). Ignored while dead.

**Shared RESET (opt-in).** With Settings → Shared RESET on, RESET also sends `reset_all` to the server, which relays `{type:'reset', from}` to the other players in the room who have it on — both teams — at most once per 15 s per room and once per 30 s per player name (`SHARED_RESET_ROOM_MS`, `SHARED_RESET_SENDER_MS` in `server/src/ws-handler.ts`). The opt-in is per connection: declared on every `join` (`sharedReset`) and with `shared_reset {on}` on each change, never carried over from an evicted connection. A `reset_all` from a client that has not opted in is ignored. On receipt the client checks its own setting again and drops the message if it is off, acts on at most one per 15 s (`SHARED_RESET_RECEIVE_MS`) and reads nothing from it but `from`, shown in the panel only when it names a player in this room who is on the game's roster. The tracker's `rescan()` acts only from a clean lock — not while holding, covered, merged with a teammate, already scanning (which keeps the user's own RESET's avoidance) or dead: there the tracker is re-finding the player already, and starting over threw away what it knew about the teammates beside them, handing the lock to the nearest one. It is also gentler than `resetPosition()`: nothing is avoided (nobody said *our* lock was wrong), and the scan starts as if the icon had just been lost where the lock was, so an icon nothing identifies is taken only within walking reach (`rescanReachPx`). Without that a clean scan with no classifier signal takes the icon with the cleanest ring, which in testing traded a correct lock for a teammate across the map. Ignored while dead.

**Which teammate icon is ours: the skin each one has on.** Live Client Data gives every player's `skinID` and internal champion name, and Community Dragon serves that skin's minimap icon — the image the game itself draws. `iconFilesForSkin` picks the files from the champion's folder listing: `<alias>_circle_<n>.png`, `_circle.png` for the base skin (under an old codename for seven champions, and `xinzhaorework_` for Xin Zhao), one set per alternate form (`kayn_ass_circle_15.png`, `quinnvalor_circle.png`, but not ability icons such as `briar_certaindeath_circle.png`), and every variant of one skin number (`kayle_circle_4_lvl11`, `lux_circle_7_fire`); a chroma wears its parent skin's, the highest number at or below its id. `SkinAwareScorer` (`skin-matcher.ts`) wraps the classifier: it correlates each own-team icon's inner circle (the ring is team-coloured, not art) with every teammate's icons, over three crop sizes and centre offsets of up to 2 px (every other pixel first, then a pixel either way around each teammate's best — on the real-game fixtures this decides exactly as the full search does, at about 3 ms an icon), and believes the best match only at a correlation of 0.6 with a 0.2 lead over the next teammate. An icon so matched to the local player scores 0.95, which clears every raw-score gate in the tracker; one matched to a teammate scores 0; anything unclear keeps the classifier's score. It stands only in front of a loaded classifier, and matches only with icons for every player on the team — with one missing, that player's icon could clear the margin against the rest. Players are keyed by roster position, as summoner names can be blank or repeated. On the 2026-10-08 Debug zips (one 3v2 custom game, four recordings) it named 219 of 321 own-team icons, never the wrong teammate and never one of the 28 turret or minion clusters the detector had taken for icons; most of the rest were half under an enemy's icon (`tests/cv/real-games.test.ts`, built locally by `scripts/make-game-fixtures.py` and labelled partly by eye; Riot's art is not committed). Icons are fetched once per install into WebView2's cache storage. Separately, the classifier's crop is now one icon's square centred on the blob, not the blob's bounding box — which took in merged neighbours and was stretched square — and on the same crops that alone made the model rank the right teammate first for three of the four champions.

**Icons whose art is teal, and icons the skin match rules out.** An own-team icon is found by its teal ring, and a blob filled past 0.40 is taken for a turret or a minion wave. Gwen's cyan hair passes the teal test and merges with her ring at fill 0.41-0.63, so until v0.5.21 her icon was thrown away on every frame: on the 2026-10-08 evening game both Gwens' trackers followed teammates (a path line drawn from the invisible icon lent the nearest teammate's `white=1.00`), and no teammate's tracker saw them either. `filledIconRing` (`tracking-helpers.ts`) accepts such a blob when its teal ends at one radius at least 75% of the way round (`outlineFit`) and no more than 60% of its centre is teal (`discShare`): a face is not teal, while a turret or a minion wave is, apart from one turret ringed by minions that roundness rejects at 0.69. Both are measured from the centre of a circle fitted to the blob's outline (`fitCircleCentre`, three rounds each keeping the 70% of outline points nearest the last circle), not from its box: minions touching the ring widen the box and move its centre several pixels off the ring's, and Gwen read 0.67-0.73 from there. A fit rather than a search for the roundest point nearby, because from slightly off-centre even an oval reads round. The expected diameter is not used either: it runs a few pixels small and puts the circle on the hair. Such an icon is centred on its ring, not on its pixels, which the hair pulls off-centre. Across the eleven 2026-10-08 recordings that added 279 icons — Gwens, Karmas, icons lit by a recall — and no turret. A merged pair is allowed more fill than a lone icon (`STACK_MAX_FILL`, 0.60) for the same reason: Gwen beside a teammate or a structure filled hers to 0.42-0.56. Separately, `SkinAwareScorer.lastVerdicts` says which icons the skin match called ours and which a teammate's, and `TeammateVerdicts` sets the latter aside like bystanders: not a candidate to lock on (while scanning one verdict is enough), and a lock on one is dropped once two verdicts agree with no "you" between them (runs that cannot tell — the icon half covered, say — neither count nor reset), the latest within 2 s, straight back to scanning rather than through a 5 s hold that would report the teammate's position as ours. Only when it is the icon we follow — within a quarter icon of where we were — and never while our icon is covered, merged or held: then our last position is where ours went out of sight, and a teammate passing it is just a teammate. A verdict of "you" clears it at once.

**Which teammate icon is ours: the camera.** The classifier cannot tell some teammates apart at all (a 2026-10-08 test: Gwen scored 0%, Kayn under 5%), and the scan's pick in the fountain, where every icon starts together, is then a guess that nothing corrected — one player's tracker followed a teammate for four minutes, hearing and being heard where the teammate was. What does tell them apart is the camera rectangle, read every frame whether or not voice on camera is on: players keep their own champion on screen most of the time, locked camera or free, while any one teammate is only in view now and then. `CameraDwell` (`tracking-helpers.ts`) follows each own-team icon frame to frame and records, on every frame the rectangle is readable, whether it was inside it (with a quarter-icon margin); an icon's dwell is its in-view share of that readable time over the last 30 s. "Inside", not "near the centre", because most players use a free camera and keep themselves on screen without centring. An icon's dwell counts only with at least 10 s of readable history that is at least half the time it was seen in the window: the rectangle reads as nothing when the map's edge clips it, so a laner in a corner with the camera on themselves would otherwise be scored on their glances elsewhere alone. Tracks survive up to 5 s undetected (icons drop out for seconds in fights), matched within a radius that grows at walking speed. `cameraSwitchTarget` moves a lock when the icon it follows was in view at most 20% of the time and exactly one other icon at least 60%. Not within 15 s of any lock change (camera, classifier or scan), not during a hold or with our icon covered or merged, not when the model genuinely recognises the icon we follow (raw ≥ `FAR_REACQUIRE_MIN_RAW`), and never away from an icon in a base (players shopping or recalling watch the map, not themselves). A rescan uses `cameraFavourite` — one icon at 60% or more, every other one that counts at 20% or less — before the composite score, but only within walking reach of where a hold ran out, or in a base: after a recall the camera is often still on a teammate in lane. After the user's own RESET it may be anywhere. An icon the user pressed RESET on is never a camera pick for 60 s (`CameraDwell.reject`), outliving the scan's own avoidance, which ends at its lock. Two teammates who stay together (a duo lane) are both in view and neither wins: the camera cannot separate them and does not try. Watching one teammate for 22 s of the 30 still leaves the player above 20%; longer than about 24 s would move the lock, and it moves back once the camera returns. The dwell of every icon is logged every 30 s, for tuning.

**Stacked with a teammate.** Two teal icons overlapping merge into one blob wider than `filterIconBlobs` accepts (1.6 icons), so the tracker saw no icon of ours, held, rescanned at 5 s and locked onto the teammate's — the only clean icon left. `isPossibleStack` keeps such blobs (up to 3.2 icons, so a group of three stays matched while one walks off). On the first frame our icon is missing (never partway through a hold, which may be a recall already disowned), if our last position is inside one (`findStack`), the tracker follows it without a hold. Our side of it comes from where we last saw our icon on its own (within 10 s), kept as an offset from the blob's centroid so we move with the pair (`positionInStack`); the blob's shape changes are not fed into velocity. A two-icon merge needs no cap. Once the blob has been wider than ~2 icons (three or more teammates), what is left after we recall can itself be a merged pair, so the episode ends — a hold, disowning us as for any recall — when the blob loses ~0.6 of an icon's pixels from its peak with no icon appearing beside it (one appearing is a teammate walking off), and in any case after 15 s. When the blob comes apart, an icon on our side is us; if only one on the teammate's side is left, ours vanished out of the pair (a recall) and that icon becomes a *bystander*. So do any icons within two icons of where we were when a hold runs out. Bystanders are excluded from tracking, followed frame to frame, until the classifier vouches for one (≥ 0.5 on three runs in a row — one noisy run reads 1.0 then 0.6, as an icon's first score is unsmoothed), the rescan sees our movement path drawn from it, it can no longer be followed, or we are found again, RESET, respawn or the minimap region changes; there is no timer, since a timer let the rescan take the teammate the moment it ran out. A rescan after a hold ran out also skips any icon that nothing identifies (classifier ≥ 0.5 with a raw output ≥ 0.3) further from where we were lost than two icons plus 8 px/s since (`rescanReachPx`), unless it is in a base (a recall), so it cannot stall for good — but past ~15 s it may take an unidentified icon that far away. White pixels beside an icon stopped counting as identifying it in v0.5.23: meant to be our movement path, they are as often a ping, a ward or another icon's edge, and in a 2026-10-09 test most far re-locks — players put in another lane, and heard by it — were taken that way, some with a full white score.

**Death.** Read from the local player's `allPlayers` entry (`isDead`, `respawnTimer`) — `activePlayer` carries neither, which is why no version before v0.5.10 ever detected one. The 3 s game-state poll and a 1 s `/playerlist` poll both feed it, the second so that a death is seen before the 2 s disown can cut the dying player out. On death the tracker keeps the body — the last position it actually saw us at, or none if it was already rescanning — clears any hold, and goes DEAD: the orchestrator keeps publishing that position, not stale, so the player hears and is heard at their body for the whole timer (see [`compliance.md`](compliance.md) § "While dead"). The camera rectangle is still read a few times a second while dead, so voice on camera follows where the player is watching. The respawn is scheduled from `respawnTimer`; on it the tracker rescans from the fountain and the orchestrator is team-only until it relocks.

**Training data + retraining.** The classifier learns from every champion's per-skin circle icon, scraped from [Community Dragon](https://www.communitydragon.org/) — Riot's community mirror of the raw game assets — into `assets/champion-circles/`. `npm run refresh-model` runs the whole loop: scrape → retrain → export `models/champion_classifier.onnx` + `champion_labels.json`. A content-hash manifest (`models/champion-icons-manifest.json`) records which icon set the live model was trained against, so a new champion, skin, or rework surfaces as a manifest diff. See [`CONTRIBUTING.md`](../CONTRIBUTING.md) § "Refreshing the champion classifier".

## Position privacy + volume math

This is the part that matters for both the threat model and the "what does the server see" question.

1. On every position tick (~10 Hz), the client sends a `coords` WebSocket message: `{ type: "coords", x, y }`, plus `stale: true` when disowning a lost position and `cx, cy` (the camera centre) only while **Voice on camera** is on. The server stamps it with the current time and stores it on the sender's room-client record.
2. Immediately after, the client POSTs `/compute-volumes` with `{ myPosition, roomId, name }`. The server reads the latest position for every *other* client in the room (skipping any whose last `coords` is older than 5 s) and returns `{ peerVolumes: { peerName: volume } }`.
3. Volume math: full volume up to `FULL_VOLUME_RANGE = 900` game units, then a quadratic fade to zero at `MAX_HEARING_RANGE = 1350` (≈ champion vision range); continuous float in `[0, 1]`. Allies return 1.0 unless the requester has ally proximity on (the client default since v0.5.18), in which case they use the same falloff — an ally with no fresh position is scored at the last position they reported, if that was within 20 s (`LOST_ALLY_ANCHOR_MS`; kept as `lastSeen` when the client disowns it), and otherwise stays at 1.0 until found; cross-team peers use the falloff and are omitted entirely beyond the range. With **Voice on camera** on for *both* players, the requester's stored camera is an extra point it listens from — never one it is heard at — so the pair is scored on the closer of champion→champion and camera→champion. See `server/src/volumes.ts`.
4. **Volumes while lost.** While the tracker cannot place us (scanning, or a hold past `disownAfterSec`) the coordinates are disowned and cross-team peers stop hearing us. With ally proximity on, for the first 20 s (`LOST_ALLY_ANCHOR_MS` in `orchestrator.ts`) the client goes on asking `/compute-volumes` from where it was last *seen* (`getLastSeenPosition`: not extrapolated, not a teammate cover; cleared by RESET, death and respawn), with `alliesOnly: true` — the server scores only its teammates and leaves everyone else out, and the client drops anyone else in the answer as well. After that, with ally proximity off, or with no last-seen position, every teammate is at 1.0 and nobody else is heard, as before v0.5.23. Going straight to 1.0 made a lane crowded with icons — where trackers lose players often — sound like the whole team, all game.

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

- **`/ws`** — WebSocket upgrade. Handles room join/leave, peer presence broadcast, position coords (`coords` message), and relay of `offer` / `answer` / `ice-candidate` signals between named peers. Room IDs are deterministic hashes of sorted player summoner names, so any two players in the same match independently compute the same room ID. League's streamer mode rewrites every `summonerName` on the streamer's own client to the champion name while leaving the split Riot ID fields intact, so a name that is exactly its champion's with a different Riot ID behind it is hashed as that Riot ID (`roomNames` in `src/services/game-state.ts`).
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
| `AudioService` | WebRTC audio + per-peer volume control. Input mode toggle (Always Open / PTT). Mic acquisition with selected device; a microphone that cannot be opened leaves the graph built without it (the outgoing track is silence), so the session listens only and the orchestrator retries the mic every 10 s. Output via shared `AudioContext`. Noise suppression handled natively by Chromium. |
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

`main.rs` also runs the cursor-position polling loop (30 Hz, skipped while LMB held to avoid tearing down a native window-drag), installs the low-level keyboard hook for the rebindable push-to-talk and toggle-mute keys (push-to-talk defaults to the key left of 1 on the current layout, scan code 0x29, and is only watched while the input mode is Push to Talk — `set_ptt_active`), runs the Debug per-game bundles (`game_bundle.rs`: the game's log lines are teed into `games/.inprogress-<lobby>_<start>/` along with minimap snapshots and classifier crops from `src/services/debug-bundle.ts`, zipped at game end or at the next launch, newest 20 kept), grants every window's WebView2 microphone access (`mic_permission.rs`: answers the permission prompt itself and overwrites a remembered Block — the app only loads its own pages), opens the rolling log file at startup with 3-session rotation, and routes `tauri::WindowEvent::CloseRequested` on any window to `app.exit(0)`.

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
