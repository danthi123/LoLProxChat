# Compliance with Riot's Third-Party Policy

LoLProxChat is built to stay within the categories Riot Games explicitly publishes as allowed for third-party tools. The mechanisms it uses are the same as Discord's overlay, Mobalytics, Blitz, Porofessor, and similar widely-used apps that have operated continuously alongside League of Legends for years.

## What it does (Riot's "allowed" column)

- Reads the **League Client (LCU) API** for game phase and your summoner identity, and the **Live Client Data API** (`https://127.0.0.1:2999`) for the player roster. Both are interfaces Riot specifically designed for third-party use. See the [LCU policy](https://www.riotgames.com/en/DevRel/changes-to-the-lcu-api-policy).
- Captures the **minimap region only** via standard Win32 `BitBlt` — the same mechanism OBS, ShareX, and the Snipping Tool use. No video frames from the game render path are touched.
- Locates the **game window** with `FindWindowW` + `GetClientRect` — read-only window-manager queries against a window handle, the same pair every overlay uses to position itself. It is what anchors the capture region to the game's bottom-right corner instead of the primary monitor's, so the app works when League runs windowed or on a second display. No memory read, no injection, and the rect never leaves the machine.
- Renders an **overlay window** that paints **outside** the LoL process — never injects, never reads game memory, never hooks DirectX. Riot's own Vanguard FAQ confirms: *"Overlays and internal tools using the API, game client, and in-game APIs should continue to function"* ([Vanguard FAQ](https://www.riotgames.com/en/DevRel/vanguard-faq)).
- Installs a user-mode **`WH_KEYBOARD_LL` keyboard hook** so push-to-talk reaches the app while the game has focus — the same mechanism Discord, Mumble, and OBS use, running in our own process and never inside LoL's. The hook **observes and passes every key straight through**: it never withholds a keystroke from the game or from any other application.

  The one thing it writes back is a single synthetic Caps Lock press via `SendInput`, and only when Caps Lock is the bound push-to-talk key. Windows toggles Caps Lock on the down edge of each press, so the app cancels that toggle to stop PTT from flipping your Caps Lock state all game ([#27](https://github.com/danthi123/LoLProxChat/issues/27)). Stated plainly, because the list below is about what the app does not do: this is a real OS-level keystroke on the normal input queue, so the focused window — LoL included — sees one extra Caps Lock press per PTT press. It is not injection into the game process, it carries no gameplay key, and LoL binds nothing to Caps Lock by default. Bind PTT to any other key in Settings and no synthetic input is sent at all.

## What it explicitly does NOT do (Riot ban triggers)

- ❌ No game memory reading — Vanguard blocks this, and we never attempt it.
- ❌ No process injection, DLL loading, or DirectX hooking.
- ❌ No network packet interception, modification, or replay.
- ❌ No automation, scripting, or bot behavior — the app never takes any in-game action on your behalf.
- ❌ No decision-making aids — no enemy ult timers, no warned-by, no jungle timers, no skill suggestions.
- ❌ No exposure of obfuscated information — no fog-of-war reveals, no warded-by indicators, no enemy item builds, no spectator-mode data. **One caveat: the opt-in "Voice on camera" setting is a deliberate exception — see below.**
- ❌ No in-game advertising (banned by Riot in May 2025).
- ❌ No paid tier or freemium gating — Riot's monetization rules require a free tier; LoLProxChat is fully open source and free.

## Specifically: the proximity audio

The volume falloff drops to zero at ~1350 game units — roughly a champion's vision range. You only hear enemies who are close enough that the game would already give you visual indicators of their presence (minimap icon when they walk past warded ground, champion model when they enter your vision); they fade in faintly at that edge and grow louder as they approach.

The app does not reveal *where* an enemy is — only that one is somewhere within hearing range. This is strictly less information than Discord voice chat with the same opponent already provides (which has zero distance modulation).

For the precise threat-modeling around how a modified client *could* extract additional information from the volume side channel, see [`threat-model.md`](threat-model.md). Note that the volume value the server returns is **continuous** — the v0.1.26 bucket quantization and jitter were reverted in v0.1.33 because the bucket transitions were audible in real games; the mitigations that remain are the hard cutoff at vision range and the staleness window on peer coordinates.

## Specifically: "Voice on camera" (opt-in, default OFF)

Added in v0.5.8 for [#36](https://github.com/danthi123/LoLProxChat/issues/36). When enabled, hearing range is measured from **the centre of your in-game camera** instead of from your champion. The camera position is read the same way as everything else — off the minimap, by finding the camera-viewport rectangle the game already draws there. It is **listen-only**: your own broadcast position remains your champion's, so panning your camera changes what *you* hear and never what anyone hears from you.

**This one does not fit the argument made above, and we are not going to pretend otherwise.** The case for the default behaviour is that hearing is anchored to your champion, so you only ever hear enemies the game would already be hinting at. A free camera is not anchored to anything — you can pan it over a bush, an objective, or the enemy jungle and learn whether someone is there, with no vision and no ward. That is information the game deliberately withholds, which is exactly what the "no fog-of-war reveals" line above rules out.

It ships because it is what people making content with the app asked for, and because the alternative — everyone hearing everything, which is what a plain Discord call already gives them — is no better. It is **off by default and stays off until you turn it on**, the setting says plainly what it does, and it is confined to what you hear rather than to what your team hears.

If you play ranked, leave it off. If Riot objects to this feature specifically, it is a single self-contained toggle and it can be removed without touching the rest of the app.

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
