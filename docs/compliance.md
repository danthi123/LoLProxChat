# Compliance with Riot's Third-Party Policy

The *mechanisms* LoLProxChat uses are ones Riot's published rules allow for third-party tools, the same as Discord's overlay, Mobalytics, Blitz, Porofessor and similar apps that have run alongside League of Legends for years. What it lets you *hear* is a different question: some settings let you hear enemies the game is hiding from you, which Riot's rules on hidden information do not allow. [Where it falls short](#where-it-falls-short-of-riots-rules) lists them.

LoLProxChat isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.

## What it does (Riot's "allowed" column)

- Reads the **League Client (LCU) API** for game phase and your summoner identity, and the **Live Client Data API** (`https://127.0.0.1:2999`) for the player roster. Riot allows third-party apps to use both, but lists them as officially unsupported. See the [LCU policy](https://www.riotgames.com/en/DevRel/changes-to-the-lcu-api-policy).
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
- ⚠️ **Fog of war is respected in Camera mode only.** In Camera mode (the default since v0.5.24) the app hears an enemy only while their icon is drawn on your own minimap — which the game draws only for enemies your team can see — so an enemy in a brush or in the fog is silent. With Camera mode off, hearing is decided by distance alone, brush or not. While dead you stay audible at your body; you hear enemies there only with Camera mode or Voice on camera on, which keep reading the minimap while you are dead (with both off, a dead player hears only teammates until respawn). **Camera mode** (on by default since v0.5.24) lets you hear the players on your screen at any distance, and **Voice on camera** widens proximity hearing to your camera's view between players who both have it on. All of this is covered below — it is the app's one real departure from "no exposure of obfuscated information", and it is stated here rather than buried.
- ❌ No in-game advertising (banned by Riot in May 2025).
- ❌ No paid tier or freemium gating — Riot's monetization rules require a free tier; LoLProxChat is fully open source and free.

## Specifically: the proximity audio

The volume falloff drops to zero at ~1350 game units — roughly a champion's vision range. You only hear enemies who are close enough that the game would already give you visual indicators of their presence (minimap icon when they walk past warded ground, champion model when they enter your vision); they fade in faintly at that edge and reach full volume once they are within ~900 units, about the distance two ranged champions hold a lane at.

That inner plateau is a loudness choice, not a reach one: the ~1350-unit cutoff is what bounds *which* enemies are audible, and it is unchanged. Inside the plateau volume is constant, so it conveys nothing about how far away the enemy actually is.

The app does not reveal *where* an enemy is — only that one is somewhere within hearing range. While they talk, the speakers overlay (top-left of the game) names them and their champion, so you do learn *which* enemy it is.

### Fog of war, stated plainly

The paragraph above is the argument for why the hearing radius is set where it is. It is an argument about *distance*, and distance is not what the game actually uses to decide what you may know about. League gates that on **vision**, and vision is blocked by brush and terrain.

Up to v0.5.23 the app could not see any of that: an enemy sitting in a lane brush eight hundred units away was audible at full volume, and one behind a wall was too. A player testing the app described this as fog of war being broken, which was a fair description. The Live Client Data API reports positions and roster, and nothing about what any player can currently see.

**In Camera mode the minimap answers it.** League draws an enemy's icon on your minimap exactly while your team has vision of them — champions, wards and all — and Camera mode only ever hears the icons your own minimap draws (below). A brush, a wall or the fog makes an enemy silent, and walking out of it makes them audible again, as the game would show them.

**Proximity mode still has the leak.** A server-side version of the same check (v0.5.24: the client sent the server its minimap's enemy icons, and the server left every other enemy out) was rolled back on the public server on 2026-10-17 after reports of problems in games. v0.5.24 clients still send the icons; the server ignores them and scores by distance, as in v0.5.23.

What bounds the leak in proximity mode is the hearing radius: you learn that an enemy is within roughly vision range of you (and, while they talk, which one: the speakers overlay names them), not where, and not through any mechanism you could aim. Players who do not want even that should not run the app, and anyone running it in a competitive context should understand it is what they are opting into.

For the precise threat-modeling around how a modified client *could* extract additional information from the volume side channel, see [`threat-model.md`](threat-model.md). Note that the volume value the server returns is **continuous** — the v0.1.26 bucket quantization and jitter were reverted in v0.1.33 because the bucket transitions were audible in real games; the mitigations that remain are the hard cutoff at vision range and the staleness window on peer coordinates.

### While dead

A dead player stays where they died for proximity purposes, in both directions, until they respawn: enemies near the body hear them, and they hear enemies near the body. (If the app had already lost track of the champion when they died, there is no body and they are team-only until respawn.)

That is a real widening, and it is stated here because the argument above does not cover it. The case for hearing being anchored to your champion is that getting close enough to hear someone costs you the same risk it costs them. A dead champion is at no risk and gives no vision at the body. So a player killed at Baron or under a tower learns, for the length of the death timer (well over a minute late game), whether enemies are still near that spot and whether they are talking — which the stock client does not tell a dead player, whose camera shows only what their team can see.

What bounds it is the same as everything else here: the ~1350-unit hearing radius from a fixed point (the body cannot move), only players running this app, voice and never game audio, and nothing about exactly where (though the speakers overlay names whoever is talking). The alternative — dead players silent to enemies — was considered and set aside because players testing the app expected enemies to keep hearing them while dead; it is a small, contained change around `onDeath` in `src/services/tracking.ts` and the orchestrator's dead-state path if that judgement changes.

## Specifically: "Camera mode" (default ON since v0.5.24)

Contributed in v0.5.24. With camera mode on — the default — you hear **exactly the players whose minimap icons are inside your camera rectangle**, and nobody else: not proximity, not voice on camera, not even a teammate standing beside your champion if your camera is elsewhere. Enemies are heard only while their icon is drawn on your minimap, so the fog of war applies (see above). Each icon is told apart by matching it against the ten players' base champion icons from Community Dragon, and followed from frame to frame.

It is decided **on your own PC**, from your own minimap: your client asks the server for no volumes while it is on, and gives it no position that enemies are scored against. It does keep reporting where its tracker last saw your own icon, as a "last seen" spot (the same one a lost proximity client sends), which the server uses only to score you for your own teammates. That makes it independent of finding your own icon, which is what made proximity fragile.

**How it fits the argument above.** Everyone it lets you hear is on your screen right now: their champion is in your view, visible to you in the game. It reveals nobody the game hides — an enemy in a brush or the fog has no icon on your minimap — and it has no hearing range, because the bound is your screen.

One exception, by design: an enemy whose icon disappears right beside a teammate's icon (within ~0.7 icon widths) is taken to be *under* it — League draws allies on top, and in a fight an enemy's icon is often fully covered — and stays heard there for up to 6 seconds. If that enemy actually stepped into a brush beside your teammate, you go on hearing them for up to those 6 seconds. That is a few seconds of "an enemy is right next to your teammate", which your teammate's champion was standing beside anyway.

**It is one-way, and it is not mutual.** You hear someone when *their* icon is inside *your* camera box; they hear you when yours is inside theirs. Looking at someone never makes them hear you. But nothing on the other player's side is needed: a player in camera mode hears whoever is on their screen, including a player who has camera mode off, or an older version, and that player cannot opt out of being heard that way except by leaving the game's room. This is a deliberate difference from Voice on camera below, chosen because it is what makes the mode work for everyone at once; the limit is the screen and the fog of war rather than the other player's consent.

**Mixing it with proximity.** Players still on proximity (camera mode off, or an older version) cannot score a camera-mode player as an enemy: enemies on proximity do not hear them. Teammates on proximity hear them by distance from that "last seen" spot (with Ally proximity on), or at full volume when their tracker has not seen them for 20 seconds. Everyone in a game should use the same version and mode for it to work both ways.

In ranked, note what turning it off does: it drops you into proximity mode, which hears through brush and fog. Of the two modes, Camera mode is the one closer to Riot's rules ([below](#where-it-falls-short-of-riots-rules)), though it hears anyone on your screen, however far away. If neither is acceptable for ranked, don't run the app there.

## Specifically: "Voice on camera" (mutual, default ON since v0.5.18, one-way)

Added in v0.5.8 for [#36](https://github.com/danthi123/LoLProxChat/issues/36), reworked in v0.5.9. When enabled, you hear the map from **the centre of your in-game camera** as well as from your champion. The camera position is read the same way as everything else — off the minimap, by finding the camera-viewport rectangle the game already draws there.

**It does not fit the argument made above, and we are not going to pretend otherwise.** The case for the default behaviour is that hearing is anchored to your champion, so you only ever hear enemies the game would already be hinting at, and getting close enough to hear someone costs you the same risk it costs them. A free camera is not anchored to anything and costs nothing — you can pan it over a bush, an objective, or the enemy jungle and learn whether someone there is talking, with no vision and no ward. That is information the game deliberately withholds, which is exactly what the "no fog-of-war reveals" line above rules out.

Three things bound it.

**1. It only reaches other people running this app, in your room.** It cannot hear anyone who has not installed it and joined the lobby with you, and it carries voice, not game audio.

**2. The range cutoff is unchanged.** `MAX_HEARING_RANGE` still applies, measured from the camera centre. Panning does not let you hear further, only from somewhere else. (v0.5.24 clients also send the camera rectangle's size; the server ignores it since the 2026-10-17 rollback.) Voice on camera applies in proximity mode; camera mode replaces it while on.

**3. It only works between two players who have both turned it on, and that is enforced on the server.** Your client publishes your camera centre to the server only while the setting is on (it reads the rectangle either way, to tell which own-team icon is yours — that use never leaves your PC), and the server uses your camera against a player only when *they* have published one too. If you leave it off you publish nothing and nobody else's *Voice on camera* can reach you. (Camera mode, above, is a different matter: it is decided by the listener and is not mutual, so a player in camera mode hears you whenever your icon is on their screen.) Publishing the camera *is* the opt-in: the server reads your own camera from that published copy when it answers you, and ignores the pre-v0.5.9 `listenPosition` request field, which let a client name a listening point of its own and so skip the opt-in.

**It is one-way.** Your camera is a point you listen *from*, never a point you are heard at: pan onto a fight and you hear it, but the people in it hear you only if they are near your champion or their own camera is on you. A v0.5.9 test build briefly made it two-way, on the argument that listening should cost the listener something. Players testing it found the result worse to play with — hearing someone because they happened to glance at you is unpredictable, while being heard only where your champion stands is not — and the two-way version did not add a protection the mutual opt-in lacks. Between two players who both have it on, listening is free, and either of them can turn it off.

So a player in a competitive game can turn it off and know exactly what they have from *this* setting: no Voice on camera reach in either direction, unaffected by what their opponents do. Since v0.5.24 that is no longer the whole picture, because Camera mode lets others hear whoever is on their screen; see above.

It ships because it is what people making content with the app asked for, and because the alternative — everyone hearing everything, which is what a plain Discord call already gives them — is no better. Up to v0.5.17 it was off by default. **Since v0.5.18 it is on by default** at the maintainer's decision; an install that had it off is switched on by that update. That makes the widening something a player has to turn off rather than turn on, and we say so here rather than leave the earlier wording standing. The setting's tooltip says plainly what it does, and the mutual rule above still means one player turning it off is enough to take them out of it entirely — out of Voice on camera, not out of others' Camera mode.

If you play ranked, turn it off. If Riot objects to this feature specifically, it is a single self-contained toggle and it can be removed without touching the rest of the app.

## Riot Developer Portal status

LoLProxChat is registered on the Riot Developer Portal — **App ID 809090** — and was approved on 2026-06-01, at v0.1.19. The registration documents the LCU + Live Client Data endpoints used and the architectural approach (Tauri overlay, no memory reads, no injection).

That approval covered the app as it was then: proximity by distance only, at a shorter range. Riot's [General Policies](https://developer.riotgames.com/policies/general) say "any new features or changes to a product must be audited", so on 2026-11-27 the product description was updated to cover everything added since (Camera mode, Voice on camera and what it can reveal, hearing from where you died, the speakers overlay, the 1350-unit range, the TURN relay) and resubmitted. The status shown afterwards is **Approved**. Approval is not an endorsement: the same policy requires the notice at the top of this page.

## Where it falls short of Riot's rules

Riot's League policy rules out using "information not present in the game client" for a competitive edge, and any "game-session-specific information that would be previously unknown to the player" ([League developer docs](https://developer.riotgames.com/docs/lol)). Measured against that:

- **Camera mode** (default) is close: you hear an enemy only while the game shows you their icon. The exception is the up-to-6-second grace when an enemy's icon disappears beside a teammate's.
- **Proximity mode** (Camera mode off) does not meet it: it hears by distance, through brush, walls and fog.
- **Voice on camera** does not meet it: it lets you hear enemies your champion has no vision of. It is on by default.
- **While dead**, hearing enemies near your body does not meet it either.

### Left as is, and what that means

Two things Riot's rules point at were looked at and deliberately left unchanged for now:

- **Voice on camera stays on by default.** v0.5.24 also switched it back on, once, for every install that had it off. So unless a player turns it off themselves, they are running the setting that falls furthest short of the hidden-information rule above, including players who had turned it off before. Turning it off sticks.
- **The non-endorsement notice is only in the README and these docs, not in the app.** Riot's policy wants it "readily visible to players". Someone who downloads only the exe from Releases never sees it, so this probably does not fully meet that requirement yet.

Either is a small change if Riot's review asks for it.

None of this involves reading memory, injecting or automating anything; it is about what the audio tells you. The resubmitted description states each of these plainly, and the status is Approved; if Riot asks for changes to any of them, this page will say so.

## Honest caveats

- **Korea region restriction.** Riot has restricted LCU-using apps in Korea as of the LCU API policy change. The app does not enforce a region check programmatically — users in Korean regions should not run it.
- **"Unsupported" endpoint status.** LCU and Live Client Data are officially listed as "unsupported." Riot can change endpoint shapes anytime, which would break the app (but won't ban users).
- **This is not legal advice.** Nothing here constitutes legal advice or a guarantee against action by Riot. This document describes the design intent and the published rules, not a contract.

## References

- [League of Legends Third Party Applications policy](https://support.riotgames.com/en-us/riot/events/third-party-applications)
- [League developer docs — game policy](https://developer.riotgames.com/docs/lol)
- [Riot Developer Portal — General Policies](https://developer.riotgames.com/policies/general)
- [Changes to the LCU API Policy](https://www.riotgames.com/en/DevRel/changes-to-the-lcu-api-policy)
- [Vanguard FAQ for Third Party Applications](https://www.riotgames.com/en/DevRel/vanguard-faq)
