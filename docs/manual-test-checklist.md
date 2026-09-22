# Manual test checklist

Everything on this page is a thing no runner in this repo can check. CI has no
Windows host, no GPU, no League client and no second machine, and `src-tauri`
does not build on Linux at all, so the GDI capture, the low-level keyboard hook,
click-through hit-testing, multi-monitor geometry, the updater's exe swap and
real voice are verified here or not at all.

Run this before publishing a release. Copy the table into the release PR, fill
in the build and date, and say which rows you actually ran — a blank row is more
useful than a hopeful tick.

Each row names the automated coverage that sits next to it. That column is the
point of the page: when a row's automated cover grows, the row shrinks or goes
away, rather than the two quietly duplicating each other forever.

**Preconditions for every row:** League in **Borderless** (DX9 exclusive
fullscreen takes the GPU output and nothing can render over it), Debug toggled
on in Settings so the rolling log captures the run, and a build you installed
rather than one you ran from `npm run dev`.

---

## 1. GDI capture and minimap geometry

| # | Steps | Expected | Automated cover |
|---|---|---|---|
| 1.1 | Load a game at 1920x1080, 100% display scale, Borderless | The tracking dot follows your champion on the minimap within a few seconds of leaving the fountain | Pipeline and state machine: `tests/cv/tracking-simulation.test.ts`. Nothing proves real pixels decode. |
| 1.2 | Repeat at 2560x1440 | Same, and the log's `Minimap from config:` line reports a region that grows with the resolution | `tests/core/map-calibration.test.ts` covers the size formula |
| 1.3 | Repeat at 125% and 150% Windows display scaling | Capture bounds still land on the minimap; the scanner window sits over it, not beside it | None — DPI is a Win32 fact |
| 1.4 | Set MinimapScale to 0, then 1, then 3 in game.cfg; restart the game for each | Each is picked up within 5s and the region tracks; scale 3 either tracks or logs `tracking cannot run` rather than tracking something wrong | `tests/core/map-calibration.test.ts`; the refusal path has no real-scale evidence |
| 1.5 | Change HUD scale mid-game | The scanner re-anchors within ~5s, or the log says why it did not | `tests/overlay/resize-helpers.test.ts` |
| 1.6 | Move the League window to a second monitor mid-game | Capture stays on the original rect and the log warns `League window moved to …` exactly once, not per poll | `tests/core/game-window.test.ts` |
| 1.7 | Run League on a secondary monitor from the start | Geometry derives from the game window, not the primary monitor: tracking works | `tests/core/game-window.test.ts` covers the decision, not the Win32 call |

## 2. Keyboard hook and push-to-talk

| # | Steps | Expected | Automated cover |
|---|---|---|---|
| 2.1 | Bind PTT to Caps Lock; hold it through a sentence | You transmit while held; the Caps Lock **LED and state end where they started** (#27) | `src-tauri/src/key_decision.rs` unit tests — Windows-local only |
| 2.2 | With PTT on Caps Lock, type in game chat | Caps Lock still works normally for the game | None |
| 2.3 | Bind PTT to a modifier (e.g. right Alt) and to a mouse side button | Both bind and transmit; the log shows the new `VK 0x..` | `tests/core/keymap.test.ts` (label side) |
| 2.4 | Hold PTT, alt-tab away, release outside the game | Transmission stops — no stuck-open mic | None |
| 2.5 | Unbind PTT entirely | Always-open still transmits (the default install) | None |

## 3. Click-through and window behaviour

| # | Steps | Expected | Automated cover |
|---|---|---|---|
| 3.1 | Click through the scanner window onto the minimap | The game receives the click and the camera moves | None |
| 3.2 | Drag the panel by its title bar; click its buttons | Panel moves, buttons respond, and no click meant for the game is eaten | None |
| 3.3 | Turn Debug on and watch the scanner | The debug image shows the mask and blobs, and the overlay's own dot never appears inside the captured region (the v0.5.0 feedback loop) | None |
| 3.4 | Restart the app | The panel returns to where you left it | None |

## 4. Self-updater

| # | Steps | Expected | Automated cover |
|---|---|---|---|
| 4.1 | Publish a draft release, then publish it for real, with Auto-update on | The update is detected, downloaded, the exe swapped and the app relaunched on the new version | None — `updater.ts` has no test host |
| 4.2 | Decline the update when prompted | The app keeps running the old version and does not re-prompt in a loop | None |
| 4.3 | Check the version shown in the panel after the swap | Matches the published tag, which is `src-tauri/Cargo.toml`'s version | None |

## 5. Audio hardware

| # | Steps | Expected | Automated cover |
|---|---|---|---|
| 5.1 | Switch input device mid-call | Peers keep hearing you with no renegotiation dropout | `tests/services/devices.test.ts` (list filtering only) |
| 5.2 | Switch output device mid-call, then back to "Default" | Audio follows the pick both ways (the v0.5.8 `setSinkId` fix) | None |
| 5.3 | Toggle MIC and VOL, and a per-player slider | Each takes effect immediately and the log shows the transition | `tests/services/audio.test.ts` covers the gain math |
| 5.4 | Speak with two peers at different distances | The nearer one is louder; the change is a ramp, not a step | Server math: `server/tests/volumes.test.ts`. Wiring: `tests/e2e/session.e2e.test.ts` |

## 6. Real match, two machines

| # | Steps | Expected | Automated cover |
|---|---|---|---|
| 6.1 | Both players on the same team, far apart | Full volume regardless of distance | `tests/e2e/session.e2e.test.ts` (E2) |
| 6.2 | Opposing teams, walk into and out of each other's vision range | Fades in around vision range and out again | `tests/e2e/session.e2e.test.ts` (E3, E4) |
| 6.3 | Die and respawn | Voice continues; tracking re-acquires at the fountain | `tests/cv/tracking-simulation.test.ts`, `tests/services/orchestrator-lifecycle.test.ts` |
| 6.4 | Turn on "voice on camera" and pan the camera across the map | You hear from the camera; the other player's volume for you does not change | `tests/e2e/session.e2e.test.ts` (E5) |
| 6.5 | End the game, then start a second one without restarting the app | The second session joins cleanly, and the log shows one meter loop, not two | `tests/services/orchestrator-lifecycle.test.ts` |
| 6.6 | Restart the app mid-game while the other player stays in | The restarted client rejoins under the same name and voice comes back | `tests/e2e/session.e2e.test.ts` (E7), server takeover path |
| 6.7 | One player closes their laptop lid / drops the network without quitting | The other stops hearing them within ~60s (one to two 30 s heartbeat sweeps) rather than holding them at full volume | `server/tests/heartbeat.test.ts` |

---

## What the automated suites do *not* prove

Stated here so a green CI run is not read as more than it is.

- **The e2e suite fakes WebRTC entirely.** ICE, TURN relay, SDP negotiation,
  autoplay policy and actual audio are untouched by it. Rows 4.x, 5.x and 6.x
  are the only evidence those work.
- **The e2e suite is not WebView2.** It runs under node with the real
  `SignalingService` and the real server, so it proves the protocol wiring, not
  that WebView2 behaves the same way.
- **The CV suite synthesizes its minimaps.** Flat coloured rings, exact colours,
  no anti-aliasing and no champion art: it proves the geometry, the state
  machine and the scoring wiring, not that the classifier recognises real icons
  or that `classifyPixel`'s thresholds survive real minimap rendering. Rows 1.x
  and 6.x are what cover that.
- **No Rust runs in CI.** The `#[cfg(test)]` modules under `src-tauri/src` build
  and pass on Windows only, locally.
