# LoLProxChat

![Server status](https://img.shields.io/website?url=https%3A%2F%2Fproxchat.dant123.com%2Fhealth&label=server&up_message=online&down_message=offline)
[![Latest release](https://img.shields.io/github/v/release/danthi123/LoLProxChat)](https://github.com/danthi123/LoLProxChat/releases/latest)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPLv3-blue)](LICENSE)

**Proximity voice chat for League of Legends.** Hear nearby players (allies *and* enemies) with volume that scales by in-game distance — enemy voices fade in at around champion-vision range and are at full volume within laning distance.

Standalone Windows desktop app built with Tauri 2 + WebView2. No Overwolf, no third-party voice service, no telemetry. Registered + approved on the Riot Developer Portal (App ID 809090).

---

## Install

Download the latest `lolproxchat.exe` from [Releases](https://github.com/danthi123/LoLProxChat/releases/latest). Single portable executable — no installer.

**Requirements:**

- Windows 10 1809+ or Windows 11
- WebView2 Runtime (ships with Windows 11; pushed via Edge on Windows 10)
- **League of Legends in Borderless mode** (Settings → Video → Window Mode → Borderless). Required — DX9 true fullscreen takes exclusive GPU output and no transparent overlay can render over it.

Launch the exe before or during a League match. The panel auto-attaches beside the minimap once a game is detected.

### First run

Windows will show one of these on first launch (the exe isn't code-signed; this is the standard treatment for any unsigned binary downloaded from the internet):

- **"Windows protected your PC"** (SmartScreen) → **More info** → **Run anyway**.
- **"This app has been blocked for your protection"** (Mark of the Web) → right-click `lolproxchat.exe` → **Properties** → check **Unblock** → **OK** → re-launch.

Subsequent launches don't prompt.

### Verify your download

Every release body includes a SHA-256 hash. Compare it against your downloaded exe to confirm you got the official build (defends against in-transit tampering, mirror reposts, typosquatted re-uploads):

```bash
# PowerShell
Get-FileHash lolproxchat.exe

# WSL / git-bash
sha256sum lolproxchat.exe
```

Every release exe is also submitted to [VirusTotal](https://www.virustotal.com/) during the build, and the scan link is included in the release notes — verifiable against 70+ antivirus engines before you download.

---

## Quick start

1. Make sure LoL is in **Borderless** mode.
2. Launch `lolproxchat.exe`. The panel appears in the middle of the screen showing the current lifecycle ("Waiting for League of Legends", "In champion select", etc.).
3. Once you load into a match, the panel jumps to the left edge of the minimap. Other players running LoLProxChat in the same match appear within a few seconds.
4. **Always Open mic** is the default — just talk. **MIC** = self-mute, **VOL** = mute everyone, **MUTE** per row = silence a specific player.

For the rest — every Settings toggle, troubleshooting, log-grab flow, uninstall — see the **[user guide](docs/user-guide.md)**.

---

## Docs

| Doc | When to read |
|---|---|
| [User guide](docs/user-guide.md) | Day-to-day usage, every Settings toggle, troubleshooting, reporting bugs |
| [Architecture](docs/architecture.md) | How it actually works — computer-vision pipeline, WebRTC flow, server design |
| [Threat model](docs/threat-model.md) | What the design protects, what it doesn't, what we collect (and what we don't) |
| [Compliance](docs/compliance.md) | Relationship to Riot's third-party policy + Developer Portal status |
| [Self-hosting](docs/self-hosting.md) | Run your own signaling server |
| [Contributing](CONTRIBUTING.md) | Build, test, release flow + code style |
| [Security policy](SECURITY.md) | How to report vulnerabilities |
| [Changelog](CHANGELOG.md) | What changed in each release |

---

## How it works (in 5 bullets)

1. **Game detection** — reads the LCU and Live Client Data APIs for game phase + player roster. No memory reads, no injection.
2. **Position** — the app captures the minimap image, finds champion icons on it by color and shape, and identifies which champion each one is with a trained image-recognition model — producing your position in in-game coordinates.
3. **Signaling** — players in the same match join a deterministic WebSocket room (room ID = hash of sorted player names) on a self-hosted Node server.
4. **Voice** — WebRTC peer-to-peer audio between players (Opus 128 kbps, DTLS-SRTP). No audio touches any server.
5. **Proximity volume** — each client streams its XY coordinates to the signaling server (over the same WebSocket used for presence/signaling); the server computes pairwise volumes for everyone in the room. **Everyone's voice fades in at ~champion vision range (~1350 game units)** and is at full volume inside ~900 units, about the distance two ranged laners hold — teammates included, unless you turn **Ally proximity** off to hear your whole team at full volume everywhere. Server-enforced — a modified client cannot bypass the team filter or range cutoff. Clients only ever receive `{ peerName: volume }`, never another peer's raw position.

On by default (you can turn it off): **Voice on camera** also lets you hear from wherever your camera is looking — one-way, and only between players who both have it on.

Hearing is based on distance only: the app can't see vision, so an enemy in a brush is as audible as one in the open. [`docs/compliance.md`](docs/compliance.md) covers this and the camera setting in full.

For depth, see [`docs/architecture.md`](docs/architecture.md).

---

## Privacy + anti-cheat in one paragraph

LoLProxChat collects **no analytics, no telemetry, no fingerprinting, no persistent user identifiers**. The only data that leaves your machine is your summoner name (for room routing — same name visible on the match scoreboard), your XY position (sent to the server over TLS, held in process memory only for as long as you're in the room, never logged), WebRTC signaling, and the voice audio itself (DTLS-SRTP, peer-to-peer, never touches the server). Want to keep your public IP private even from peers in your match? **Settings → Hide IP (Force TURN)** routes voice through the TURN relay. See [`docs/threat-model.md`](docs/threat-model.md) for the full breakdown.

---

## License

**[GNU AGPLv3](LICENSE).** Free and open source — use, study, modify, and self-host it, including commercially. The copyleft terms require that if you distribute the app, or run a modified version as a network service, you make the corresponding source available under the AGPLv3. © 2026 Daniel Thiberge.

Champion icons used to train the recognition model come from [Community Dragon](https://www.communitydragon.org/) (a community-maintained mirror of Riot's game assets). They remain Riot Games' intellectual property, are used for training only, and are not distributed with this software.

---

## Acknowledgements

- [LOL_Minimap_Tracker](https://github.com/Quinntana/LOL_Minimap_Tracker) — minimap champion-tracking reference
- [LeagueMinimapDetectionCNN](https://github.com/Maknee/LeagueMinimapDetectionCNN) — reference code for minimap detection
- [Community Dragon](https://www.communitydragon.org/) — champion icon assets used to train the champion-recognition model
- [Tauri](https://tauri.app) — desktop app framework
- Cloudflare Realtime TURN — managed TURN relay infrastructure
- Every user who's filed an issue or attached a log — your reports made this app actually work.
