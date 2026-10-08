# User Guide

Everything you need to use LoLProxChat day-to-day. For installation, see the [README](../README.md). For privacy and the threat model, see [`threat-model.md`](threat-model.md). For self-hosting the signaling server, see [`self-hosting.md`](self-hosting.md).

## First-time setup

1. **Set League of Legends to Borderless mode** (Settings → Video → Window Mode → Borderless). This is non-negotiable — DX9 true fullscreen takes exclusive GPU output and no overlay (including this one) can render over it. Borderless is functionally identical performance-wise.
2. Launch `lolproxchat.exe`. The panel appears in the middle of the screen showing the current lifecycle status: "Waiting for League of Legends", "In champion select", "Joining game…", etc.
3. Once you load into a match the panel jumps to the left edge of the minimap. You can drag it anywhere by grabbing the title bar.
4. Other players running LoLProxChat in the same match appear in the player list within a few seconds.

## Panel controls

| Button | What it does |
|---|---|
| **MIC** | Toggle self-mute (no one hears you) |
| **VOL** | Mute everyone for you (you hear no one) |
| **POS** | Wrong position? Re-finds your champion on the minimap — then walk somewhere. Same as **Settings → Wrong position? → RESET** (see below); stays available when the panel is collapsed. |
| **SET** | Open / close the Settings panel |
| **»** | Collapse the panel to a thin column |

Each player row has:

- **Champion name** (or summoner name on hover)
- **Per-player volume slider** — adjust how loud this specific player is for you
- **MUTE button** — silence this specific player without affecting others

## Settings

| Setting | What it does |
|---|---|
| **Language** | The panel's language: English or Español. Applies immediately and persists. On first launch it follows your Windows display language (Spanish if Windows is in Spanish, English otherwise). |
| **Input Device** | Which microphone to use. "Default" follows Windows' default communications device. Selection persists across launches. Switching mid-game swaps the source in place — no peer reconnection needed. |
| **Output Device** | Which speaker / headset to send voice to. Same persistence behavior. |
| **Input Mode** | "Always Open" (default) — mic is always live unless self-muted. "Push to Talk" — hold the bound PTT key (default: the key left of 1) to transmit; it works while League has focus. |
| **PTT Key** | The push-to-talk key. Default: the key left of 1 — ` on US keyboards, º on Spanish ones (until v0.5.16 it was Caps Lock; a key you chose yourself is kept). The key is only watched in Push to Talk mode, so in Always Open it types normally. If you bind Caps Lock, its LED is flipped back on each press so it doesn't toggle. Click the button to capture a new key; the app rejects common LoL bindings (Q/W/E/R/D/F/B/P) and modifier-only keys. |
| **Toggle-mute Key** | Optional global hotkey to flip self-mute on/off. Unbound by default — click the button to bind. |
| **Mic Volume** | Pre-transmission gain on your mic, 0-100%. Useful if your hardware mic is too quiet or too hot. |
| **Hide IP (Force TURN)** | Routes all voice through the TURN relay so peers in your match never see your public IP. Defends against DDoS / port-scan attempts from random players. Adds ~20-100 ms latency. Default off; takes effect on the next peer connection. See [`threat-model.md`](threat-model.md) for the full discussion. |
| **Ally proximity** | When on (default), teammates fade with distance exactly like enemies do. When off, teammates are always at full volume no matter where they are on the map. Takes effect on the next position update. On by default since v0.5.18 — an install that had it off before is switched on by that update, so turn it off again if you prefer. |
| **Voice on camera** | When on, you hear the map from wherever your **camera** is looking as well as from your champion, so panning across a fight lets you listen in on it. **It's one-way:** the people you're listening to don't hear you through your camera — they hear you only if they're near your champion, or have it on and are looking at you. And it only works between players who have **both** turned it on — leave it off and nobody's camera can reach you, only players actually near you on the map. **On by default since v0.5.18 (an install that had it off is switched on by that update), and worth turning off in ranked:** it lets you hear enemies your champion has no vision of, which is information the game normally withholds. See [`compliance.md`](compliance.md). |
| **Wrong position? → RESET** | If people next to you can't hear you but you can hear them, the app is probably tracking the wrong icon on your minimap (it can latch onto a ward you walked past). RESET drops the position and finds your champion again — **then walk somewhere**, which is how it tells you apart if it doesn't recognise your champion. Only your team hears you until it finds you. It does nothing while you're dead. |
| **Shared RESET** | Off by default. When on, pressing RESET (or **POS**) also makes everyone else in the game who has it on re-find their champion, and their RESETs do the same for you — the panel says who pressed it. Handy when a whole lobby's tracking went wrong at once. Only works between players who have it on: leave it off and nobody else's RESET ever reaches you (the server does not send it to you, and the app would ignore it anyway). Either team can use it, at most once every 15 seconds per game. Someone else's RESET never moves you onto an icon far from where you were unless the app recognises you there or you walk. |
| **Debug** | Toggles diagnostic mode — shows a filtered minimap thumbnail with the tracked position marked, exposes the Scan Rate slider, and starts writing a debug log to disk. Off by default; turn on only when investigating a problem or asked by a maintainer. |
| **Debug Logs → OPEN** | Launches Explorer at `%LOCALAPPDATA%\com.proxchat.app\` so you can grab `lolproxchat.log` to attach to a GitHub issue. With Debug on, every game is also saved as one zip in the `games` folder there, named after the lobby and start time (e.g. `vrb9uf_2026-10-07_17-05.zip`): that game's log, a minimap snapshot every 10 s and at each tracking event, and the icon crops the champion classifier scored. The newest 20 are kept. Debug is off each time the app starts, so turn it on again before (or during) the game you want saved. |
| **Auto-update** | When on, the app checks GitHub Releases ~5 seconds after launch and applies any newer version automatically (process exits cleanly, new binary takes over, old one is deleted). Off by default. The setting persists. |
| **Updates → CHECK** | Force an immediate update check, regardless of the Auto-update toggle. |
| **Scan Rate** *(Debug only)* | How often the minimap is scanned — 0 ≈ 1 FPS, 50 ≈ 30 FPS, 100 = 60 FPS. The rate doesn't change how tracking feels (smoothing adjusts to it). Lower it if you hear audio crackling under heavy load (rare on modern hardware). |

## Global keyboard shortcuts

These work even while League has focus:

- **The key left of 1** *(hold, default; Push to Talk mode only)* — push-to-talk. Rebindable in **Settings → PTT Key**.
- **Toggle-mute** — unbound by default. Bind in **Settings → Toggle-mute Key**.

PTT is only effective when **Input Mode** is set to "Push to Talk".

## Reporting bugs

If something's broken — voice not working, weird volume, players not appearing, crashes — please open an issue at <https://github.com/danthi123/LoLProxChat/issues> with the debug log attached. The log captures everything the app sees (connection state, network negotiation, champion tracking, and more) and is by far the fastest way to figure out what went wrong.

### Three-step log grab

1. **Settings → Debug** — flip from **OFF** to **ON**. Diagnostic writes start immediately; overhead is negligible.
2. **Reproduce the bug.** Start a game, repeat whatever triggered the issue.
3. **Settings → Debug Logs → OPEN.** Explorer pops up at `%LOCALAPPDATA%\com.proxchat.app\`. Open the `games` folder and send the zip for the game that went wrong (named after the lobby and when it started). Otherwise, drag `lolproxchat.log` into your GitHub issue.

> If you restarted the app between the bug and grabbing the log, the previous session is at `lolproxchat.1.log`. The app keeps three rolling sessions: `.log` (current) → `.1.log` (previous) → `.2.log` (oldest).

The log is plain text. It contains your summoner name and nearby players' summoner names (gameplay-public), plus technical IP info from the connection setup. If any of that is sensitive in your situation, skim through and redact before posting.

## Troubleshooting

| Symptom | Most likely cause |
|---|---|
| Overlay invisible during gameplay | League is in true fullscreen — switch to **Borderless** in Video Settings. |
| Panel sits in the middle of the screen | No game detected yet, or tracking hasn't locked on. The panel's status text tells you which. |
| Panel sits above the minimap instead of beside it | The detected minimap bounds are off. Turn on **Debug** and check the tracking log lines. (The draggable panel never auto-positions — only the minimap overlay does.) |
| Panel says it can't find the League window | League is in true fullscreen, or minimized. Switch to **Borderless** in Video Settings. |
| A teammate stays at full volume after I recall, with Ally proximity on | Fixed in v0.5.13 — update. Walking next to a teammate could make the app lock onto their icon instead of yours. |
| After recalling I can still hear the enemy in lane | With **Voice on camera** on, you hear from wherever your camera is — after a recall with an unlocked camera that is still the lane, until you move it. They can't hear you. The same goes for teammates while **Ally proximity** is on; with it off you hear teammates everywhere anyway. |
| I can hear someone next to me but they can't hear me | The app is tracking the wrong icon, usually a ward you walked past. It usually corrects itself after several seconds if the app recognises your champion; if not, click **POS** in the panel header (or **Settings → Wrong position? → RESET**), then walk somewhere. Send the log either way. |
| What happens to voice while I'm dead? | You stay where you died until you respawn: enemies near your body hear you, and you hear them. Teammates hear you as always. (If the app had already lost track of you when you died, you're team-only until you respawn.) |
| An enemy you're fighting up close cuts out for a few seconds | Fixed in v0.5.9 — update. Your minimap icons overlapping made the app think you had recalled. If it still happens, attach a log with the game time: it now records what the tracker could see at that moment. |
| Tracking never locks when League is on a second monitor | Fixed in v0.5.9 — update. Older builds only ever looked at the primary monitor, so the capture region landed on the wrong display. |
| Tracking never locks at a very large minimap | The debug log says `capture square is only NNNpx`. Lower **MinimapScale** in League's HUD settings. |
| Audio cuts out or crackles | Usually the minimap scan competing for the main thread at a high scan rate. Lower the **Scan Rate** slider to ~50 (Debug). |
| Connected to a peer but hear nothing | First check your **Output Device** (Settings) — the wrong default device is the most common cause. Then turn on Debug and confirm the connection reaches `connected`; if it shows `failed`, you're behind a restrictive network and need **Hide IP (Force TURN)**. |
| Can't hear one specific player | Check their per-player volume slider isn't at zero and their **MUTE** isn't on. |
| An enemy in a brush or behind a wall is audible | Expected. Hearing is worked out from distance, and the app has no way to know what you can see — League's client API reports positions but not vision. See [`compliance.md`](compliance.md) § "Fog of war, stated plainly". |
| Faint or no audio from a nearby enemy | Enemy voices are full volume within about 900 game units and fade over the last stretch to ~1350 (roughly champion-vision range), where they cut out — that's by design. Allies follow the same falloff while **Ally proximity** is on (the default), and are full volume everywhere with it off. If an enemy standing next to you is still faint, that's tracking, not the falloff: turn on Debug and check the log. |
| Something else seems off | Make sure you're on the latest version: turn on **Auto-update**, or grab the newest build from [Releases](https://github.com/danthi123/LoLProxChat/releases/latest). |

## Updating

If **Auto-update** is on (Settings), the app downloads and applies new releases automatically on launch.

You can also force a check at any time via **Settings → Updates → CHECK**. If an update is available it downloads and applies immediately; if not you get an "Up to date" message.

For manual updates: download the new `lolproxchat.exe` from [Releases](https://github.com/danthi123/LoLProxChat/releases/latest) and replace your existing copy.

### Verifying downloads

Every release body includes a SHA-256 hash of the exe. Compare against your download:

```bash
# Windows PowerShell
Get-FileHash lolproxchat.exe

# WSL / git-bash
sha256sum lolproxchat.exe

# Linux/macOS
shasum -a 256 lolproxchat.exe
```

The hash defends against in-transit tampering, mirror reposts, and typosquatted re-uploads. It does *not* defend against you having downloaded from the wrong URL — always start from <https://github.com/danthi123/LoLProxChat/releases>.

## Uninstalling

LoLProxChat is a portable executable with no installer. Removing it is two steps:

1. **Delete the exe** wherever you put it (probably Downloads or a folder you chose).
2. **Delete app data:** open `Run` (Win+R), paste `%LOCALAPPDATA%\com.proxchat.app\`, then delete the folder. It contains:
   - WebView2 cache (cookies, localStorage, IndexedDB)
   - Your Settings (auto-update toggle, device picks, etc.)
   - `lolproxchat.log` + `lolproxchat.1.log` + `lolproxchat.2.log` if you ever turned Debug on

That's the full footprint. No registry entries, nothing under "Programs and Features", no startup tasks, no services.
