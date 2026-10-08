# Compliance with Riot's Third-Party Policy

LoLProxChat is built to stay within the categories Riot Games explicitly publishes as allowed for third-party tools. The mechanisms it uses are the same as Discord's overlay, Mobalytics, Blitz, Porofessor, and similar widely-used apps that have operated continuously alongside League of Legends for years.

## What it does (Riot's "allowed" column)

- Reads the **League Client (LCU) API** for game phase and your summoner identity, and the **Live Client Data API** (`https://127.0.0.1:2999`) for the player roster. Both are interfaces Riot specifically designed for third-party use. See the [LCU policy](https://www.riotgames.com/en/DevRel/changes-to-the-lcu-api-policy).
- Captures the **minimap region only** via standard Win32 `BitBlt` — the same mechanism OBS, ShareX, and the Snipping Tool use. No video frames from the game render path are touched.
- Locates the **game window** with `FindWindowW` + `GetClientRect` — read-only window-manager queries against a window handle, the same pair every overlay uses to position itself. It is what anchors the capture region to the game's bottom-right corner instead of the primary monitor's, so the app works when League runs windowed or on a second display. No memory read, no injection, and the rect never leaves the machine.
- Renders an **overlay window** that paints **outside** the LoL process — never injects, never reads game memory, never hooks DirectX. Riot's own Vanguard FAQ confirms: *"Overlays and internal tools using the API, game client, and in-game APIs should continue to function"* ([Vanguard FAQ](https://www.riotgames.com/en/DevRel/vanguard-faq)).
- Installs a user-mode **`WH_KEYBOARD_LL` keyboard hook** so push-to-talk reaches the app while the game has focus — the same mechanism Discord, Mumble, and OBS use, running in our own process and never inside LoL's. The hook **observes and passes every key straight through**: it never withholds a keystroke from the game or from any other application.

  The one thing it writes back is a single synthetic Caps Lock press via `SendInput`, and only when Caps Lock is the bound push-to-talk key and the input mode is Push to Talk (since v0.5.17 the default key is the one left of 1, and no key is watched in Always Open). Windows toggles Caps Lock on the down edge of each press, so the app cancels that toggle to stop PTT from flipping your Caps Lock state all game ([#27](https://github.com/danthi123/LoLProxChat/issues/27)). Stated plainly, because the list below is about what the app does not do: this is a real OS-level keystroke on the normal input queue, so the focused window — LoL included — sees one extra Caps Lock press per PTT press. It is not injection into the game process, it carries no gameplay key, and LoL binds nothing to Caps Lock by default. Bind PTT to any other key in Settings and no synthetic input is sent at all.

## What it explicitly does NOT do (Riot ban triggers)

- ❌ No game memory reading — Vanguard blocks this, and we never attempt it.
- ❌ No process injection, DLL loading, or DirectX hooking.
- ❌ No network packet interception, modification, or replay.
- ❌ No automation, scripting, or bot behavior — the app never takes any in-game action on your behalf.
- ❌ No decision-making aids — no enemy ult timers, no warned-by, no jungle timers, no skill suggestions.
- ❌ No warded-by indicators, no enemy item builds, no spectator-mode data.
- ⚠️ **Proximity audio does not respect fog of war.** Hearing is computed from distance alone, so an enemy in a brush or behind a wall is as audible as one standing in the open at the same range. While dead you stay audible, and can hear, at your body. The "Voice on camera" setting widens that further, though only between two players who both have it on — and since v0.5.18 it is on by default. All three are covered below — this is the app's one real departure from "no exposure of obfuscated information", and it is stated here rather than buried.
- ❌ No in-game advertising (banned by Riot in May 2025).
- ❌ No paid tier or freemium gating — Riot's monetization rules require a free tier; LoLProxChat is fully open source and free.

## Specifically: the proximity audio

The volume falloff drops to zero at ~1350 game units — roughly a champion's vision range. You only hear enemies who are close enough that the game would already give you visual indicators of their presence (minimap icon when they walk past warded ground, champion model when they enter your vision); they fade in faintly at that edge and reach full volume once they are within ~900 units, about the distance two ranged champions hold a lane at.

That inner plateau is a loudness choice, not a reach one: the ~1350-unit cutoff is what bounds *which* enemies are audible, and it is unchanged. Inside the plateau volume is constant, so it conveys nothing about how far away the enemy actually is.

The app does not reveal *where* an enemy is — only that one is somewhere within hearing range. This is strictly less information than Discord voice chat with the same opponent already provides (which has zero distance modulation).

### Fog of war, stated plainly

The paragraph above is the argument for why the hearing radius is set where it is. It is an argument about *distance*, and distance is not what the game actually uses to decide what you may know about. League gates that on **vision**, and vision is blocked by brush and terrain. This app cannot see any of that.

So an enemy sitting in a lane brush eight hundred units away is audible at full volume, and an enemy behind a wall is too. A player testing the app described this as fog of war being broken, which is a fair description of the experience.

It is not a bug that can be fixed at this layer. The Live Client Data API reports positions and roster, and reports nothing about what any player can currently see — no vision state, no brush occupancy, no ward coverage. Without that, the only way to model vision would be to ship a static Summoner's Rift brush-and-wall mesh and test line of sight against it server-side, which is sketched in [`threat-model.md`](threat-model.md) under the `MAX_HEARING_RANGE` calibration. That would cover terrain but still not wards, and it is a substantial build. It is not implemented, and so is not claimed.

What bounds the leak today is the hearing radius and nothing else: you learn that *an* enemy is within roughly vision range of you, not which one, not where, and not through any mechanism you could aim. Players who do not want that should not run the app, and anyone running it in a competitive context should understand it is what they are opting into.

For the precise threat-modeling around how a modified client *could* extract additional information from the volume side channel, see [`threat-model.md`](threat-model.md). Note that the volume value the server returns is **continuous** — the v0.1.26 bucket quantization and jitter were reverted in v0.1.33 because the bucket transitions were audible in real games; the mitigations that remain are the hard cutoff at vision range and the staleness window on peer coordinates.

### While dead

A dead player stays where they died for proximity purposes, in both directions, until they respawn: enemies near the body hear them, and they hear enemies near the body. (If the app had already lost track of the champion when they died, there is no body and they are team-only until respawn.)

That is a real widening, and it is stated here because the argument above does not cover it. The case for hearing being anchored to your champion is that getting close enough to hear someone costs you the same risk it costs them. A dead champion is at no risk and gives no vision at the body. So a player killed at Baron or under a tower learns, for the length of the death timer (well over a minute late game), whether enemies are still near that spot and whether they are talking — which the stock client does not tell a dead player, whose camera shows only what their team can see.

What bounds it is the same as everything else here: the ~1350-unit hearing radius from a fixed point (the body cannot move), only players running this app, voice and never game audio, and nothing about *which* enemy or exactly where. The alternative — dead players silent to enemies — was considered and set aside because players testing the app expected enemies to keep hearing them while dead; it is a small, contained change around `onDeath` in `src/services/tracking.ts` and the orchestrator's dead-state path if that judgement changes.

## Specifically: "Voice on camera" (mutual, default ON since v0.5.18, one-way)

Added in v0.5.8 for [#36](https://github.com/danthi123/LoLProxChat/issues/36), reworked in v0.5.9. When enabled, you hear the map from **the centre of your in-game camera** as well as from your champion. The camera position is read the same way as everything else — off the minimap, by finding the camera-viewport rectangle the game already draws there.

**It does not fit the argument made above, and we are not going to pretend otherwise.** The case for the default behaviour is that hearing is anchored to your champion, so you only ever hear enemies the game would already be hinting at, and getting close enough to hear someone costs you the same risk it costs them. A free camera is not anchored to anything and costs nothing — you can pan it over a bush, an objective, or the enemy jungle and learn whether someone there is talking, with no vision and no ward. That is information the game deliberately withholds, which is exactly what the "no fog-of-war reveals" line above rules out.

Three things bound it.

**1. It only reaches other people running this app, in your room.** It cannot hear anyone who has not installed it and joined the lobby with you, and it carries voice, not game audio.

**2. The range cutoff is unchanged.** `MAX_HEARING_RANGE` still applies, measured from the camera. Panning does not let you hear further, only from somewhere else.

**3. It only works between two players who have both turned it on, and that is enforced on the server.** Your client publishes your camera centre to the server only while the setting is on, and the server uses your camera against a player only when *they* have published one too. If you leave it off you publish nothing, nobody else's camera can reach you, and you are heard only by players actually near you on the map — whatever anyone else has chosen. Publishing the camera *is* the opt-in: the server reads your own camera from that published copy when it answers you, and ignores the pre-v0.5.9 `listenPosition` request field, which let a client name a listening point of its own and so skip the opt-in.

**It is one-way.** Your camera is a point you listen *from*, never a point you are heard at: pan onto a fight and you hear it, but the people in it hear you only if they are near your champion or their own camera is on you. A v0.5.9 test build briefly made it two-way, on the argument that listening should cost the listener something. Players testing it found the result worse to play with — hearing someone because they happened to glance at you is unpredictable, while being heard only where your champion stands is not — and the two-way version did not add a protection the mutual opt-in lacks. Between two players who both have it on, listening is free, and either of them can turn it off.

So a player in a competitive game can turn it off and know exactly what they have: plain proximity, no camera reach in either direction, unaffected by what their opponents do. That is the property that was missing.

It ships because it is what people making content with the app asked for, and because the alternative — everyone hearing everything, which is what a plain Discord call already gives them — is no better. Up to v0.5.17 it was off by default. **Since v0.5.18 it is on by default** at the maintainer's decision; an install that had it off is switched on by that update. That makes the widening something a player has to turn off rather than turn on, and we say so here rather than leave the earlier wording standing. The setting's tooltip says plainly what it does, and the mutual rule above still means one player turning it off is enough to take them out of it entirely.

If you play ranked, turn it off. If Riot objects to this feature specifically, it is a single self-contained toggle and it can be removed without touching the rest of the app.

## Riot Developer Portal status

LoLProxChat is **registered and approved** on the Riot Developer Portal — **App ID 809090**. The registration documents the LCU + Live Client Data endpoints used and the architectural approach (Tauri overlay, no memory reads, no injection). This is the official sign-off that the app's design fits Riot's allowed-tools category.

## Honest caveats

- **Korea region restriction.** Riot has restricted LCU-using apps in Korea as of the LCU API policy change. The app does not enforce a region check programmatically — users in Korean regions should not run it.
- **"Unsupported" endpoint status.** LCU and Live Client Data are officially listed as "unsupported." Riot can change endpoint shapes anytime, which would break the app (but won't ban users).
- **This is not legal advice.** Nothing here constitutes legal advice or a guarantee against action by Riot. This document describes the design intent and the published rules, not a contract.

## References

- [League of Legends Third Party Applications policy](https://support-leagueoflegends.riotgames.com/hc/en-us/articles/225266848-Third-Party-Applications)
- [Riot Developer Portal — General Policies](https://developer.riotgames.com/policies/general)
- [Changes to the LCU API Policy](https://www.riotgames.com/en/DevRel/changes-to-the-lcu-api-policy)
- [Vanguard FAQ for Third Party Applications](https://www.riotgames.com/en/DevRel/vanguard-faq)
