# Contributing

This is a personal project, but PRs and issues are welcome. This doc is the ground-truth for build / test / release / style. If anything here disagrees with what's checked into the repo, the repo wins — please file an issue.

LoLProxChat is licensed under the [GNU AGPLv3](LICENSE); by contributing, you agree your contributions are licensed under the same terms.

## Getting set up

Prerequisites:

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable toolchain)
- Windows 10/11 with WebView2 Runtime (Windows 11 ships with it; pushed via Edge on Windows 10)

```bash
git clone https://github.com/danthi123/LoLProxChat.git
cd LoLProxChat
npm install
cp .env.example .env       # optional — point at a different signaling server if you want
```

## Common commands

```bash
# Frontend dev build (sourcemaps, no minify)
npm run build

# Frontend production build (called automatically by tauri build)
npm run build:prod

# Full production exe — lands at src-tauri/target/release/lolproxchat.exe
npx tauri build

# Run client tests
npm test

# Run server tests
cd server && npm test

# Run Rust tests (Windows only — the crate links Win32 bindings). Needs a
# frontend build first, because tauri::generate_context!() resolves ../dist
# at compile time.
npm run build:prod && cargo test --manifest-path src-tauri/Cargo.toml

# Re-scrape champion icons + retrain the tracking classifier (needs Python —
# see "Refreshing the champion classifier" below)
npm run refresh-model
```

There is no `tauri dev` flow — the project doesn't run a webpack dev server. The iterative loop is `npx tauri build && src-tauri/target/release/lolproxchat.exe`, which is fast enough at ~60-90 s for incremental Rust compiles.

## Project layout

See [`docs/architecture.md`](docs/architecture.md) for the system-level view (windows, services, server, TURN, etc.). The relevant directories for contributors:

```
src/
├── background/       — Orchestrator entry point (loaded into the overlay window)
├── overlay/          — Panel window (HTML/CSS/TS) — player list, settings, drag handle
├── scanner/          — Scanner window (HTML/CSS/TS) — click-through overlay over minimap
├── core/             — Pure logic modules (deterministic, fully testable)
└── services/         — Runtime services with side effects (network, audio, CV)

src-tauri/
├── src/              — Rust backend (capture, LCU polling, window positioning, updater)
├── capabilities/     — Tauri 2 ACL grants (drag, event emit/listen)
└── tauri.conf.json   — Window definitions, build config

server/                — Node WebSocket + HTTP signaling server
├── src/              — Rooms, signaling handler, volume math, TURN credential issuance
└── tests/            — vitest unit tests

tests/                 — Client jest tests (separate roots: tests/core, tests/services, tests/integration)
docs/                  — User guide, architecture, self-hosting, threat model, compliance
```

## Code style

- **TypeScript:** strict mode (see `tsconfig.json`). Avoid `as any` outside of well-justified bridging to untyped APIs (Tauri responses, ONNX outputs).
- **Comments:** explain *why* if it's non-obvious, not *what* the code does. Don't reference the current task or commit in code comments — those belong in PR descriptions and CHANGELOG.
- **Logging:** `console.log` is the file-log sink (the `core/logging.ts` layer routes it to the rolling log file when Debug is on). Use `console.warn` for unexpected-but-recoverable, `console.error` for "this should not happen." Don't log per-tick high-frequency events without throttling — see `audio.ts::applyPeerVolumes` for the pattern. Lines are buffered and shipped to the Rust writer at most every 250 ms, in emission order, with `console.error` flushing immediately — so a normal quit can lose the last quarter-second of non-error lines, and anything you need to survive a crash should be logged at error level.
- **Error handling:** no silent catches. If something can fail, log the failure with enough context that a future bug report has something to grep for. Suppress-with-comment is acceptable only when the failure is genuinely non-fatal (e.g., the scanner not being ready yet, or a `hide_scanner` cleanup call during teardown).

## Testing

- **Client tests** live under `tests/` (separate root from `src/`). Run with `npm test`. The 307 tests cover core logic, tracking state machine, audio gain math (slider×proximity, plus `resolveProximityTargets` which silences peers the server drops from range), device list filtering, tracking-helper scoring math (composite/jump/hold-cap), the position-jump warning gates, the session-flow integration, the champion-classifier label resolver and batched inference (crop packing and per-row softmax slicing), the debug-log buffering and flush ordering, the raw capture-frame decoder and the tracking tick's dimension guard, Riot ID reading and local-player matching, map detection and streamer-mode detection, the dynamic overlay resize helpers, the game-window geometry resolver and capture-bounds math, and the PTT-rebind keymap.
- **Server tests** live under `server/tests/`. Run with `cd server && npm test`. 165 tests cover room management (team + coords storage), `join` argument validation, WebSocket heartbeat/reaping, TURN credential generation (both coturn-HMAC and Cloudflare paths), the tiered proximity-volume math, and rate-limiting (`TokenBucket`, `ConcurrencyLimiter`, `clientIp`'s proxy-trust rules, plus end-to-end per-player isolation and forwarding-header tests against a real spawned server).
- **Rust tests** live beside the code they cover (`#[cfg(test)] mod tests`). 31 tests across `capture.rs`, `game_window.rs`, `key_decision.rs` and `lcu.rs` cover the pure helpers — lockfile parsing, install-dir caching, capture-bounds validation, the BGRA→RGBA conversion the capture frame ships through, game-rect handling and the PTT key decision. They only build on Windows; see "Common commands" for the invocation.
- New features should land with tests where the logic is testable (pure functions, state machines). DOM-heavy or Tauri-IPC-heavy code can skip tests; mock surfaces are too brittle to be worth maintaining.

## Refreshing the champion classifier

Minimap tracking identifies your champion with a small CNN (`src/services/champion-classifier.ts`, run via ONNX Runtime Web). Its training data is every champion's per-skin circle icon, scraped from [Community Dragon](https://www.communitydragon.org/) — Riot's community mirror of the raw game assets — so new champions, skins, and reworks show up automatically on the live patch.

```bash
# Python deps (one time). CPU-only is fine — the model is tiny (~1.7 MB).
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install -r scripts/requirements.txt

# Scrape the latest icons, retrain, and export the model + labels.
npm run refresh-model
#   --skip-scrape   retrain on the icons already on disk
#   --limit 8       quick smoke test on the first 8 champions
```

This regenerates three tracked files:

- `models/champion_classifier.onnx` — the model webpack bundles into the app.
- `models/champion_labels.json` — the class-index → champion-name map.
- `models/champion-icons-manifest.json` — the patch version plus a content hash per icon. It records which icon set the live model was trained against, so a diff against a fresh scrape tells you when a retrain is due.

The icons themselves (`assets/champion-circles/`) are gitignored and regenerated on demand. **Validate tracking in a real game before committing a retrained model** — per-class accuracy varies by icon, and the model is load-bearing for tracking quality.

## Commit conventions

Loosely [Conventional Commits](https://www.conventionalcommits.org/), used to scan history during release-note drafting:

- `feat:` — user-visible feature
- `fix:` — user-visible bug fix
- `release:` — version bump + CHANGELOG for a release
- `chore:` — Cargo.lock bumps, dependency updates, repo hygiene
- `docs:` — documentation only
- `ci:` — CI workflow changes
- `refactor:` — non-behavioral code restructuring
- `style:` — formatting / comments only
- `test:` — test additions or fixes
- `diag:` — adding diagnostic logging (no functional change)
- `perf:` — performance improvement

**Do not use auto-close keywords (`closes`, `fixes`, `resolves`) in commit messages or PR descriptions.** Issues stay open until the reporter confirms or the maintainer manually closes them. Use bare `#N` references for traceability.

## Release process

A release is triggered by a **version bump landing on `main`** — [`.github/workflows/release.yml`](.github/workflows/release.yml) sees `src-tauri/Cargo.toml`'s version has no matching tag yet, builds `tauri build` on a Windows runner, computes the SHA-256, creates the `vX.Y.Z` tag, and opens a **draft** GitHub Release with the `lolproxchat.exe` asset and notes pulled from the matching `CHANGELOG.md` section. The build also submits the exe to VirusTotal (direct API call) and puts the scan link in the draft notes, so it's reviewable before you publish. You review and publish the draft, and the in-app updater (which reads `releases/latest`; drafts are invisible until published) picks it up on clients' next launch.

So a manual release is:

1. `node scripts/bump-version.mjs --type patch --changelog "### Fixed\n- …"` — bumps `Cargo.toml` + `Cargo.lock` and adds the dated `CHANGELOG.md` section + footnote (use `--type minor` for notable/behavior changes).
   `src-tauri/Cargo.toml`'s version is the single source of truth: the exe's Windows file-properties version comes from it too, because `tauri.conf.json` deliberately has no `version` field. Don't re-add one — it would override `Cargo.toml` and drift the moment someone bumps by hand.
2. Commit (`release:`) and push to `main`.
3. Wait for the draft release to appear, then review and publish it.

(You can also trigger `release.yml` manually via workflow_dispatch — it builds whatever version is in `Cargo.toml`.) To build locally for a sanity check, `npx tauri build` drops the exe at `src-tauri/target/release/lolproxchat.exe`. No build secrets are needed — `PROXCHAT_SERVER` defaults to the public server.

### Automated classifier retrain → release

[`.github/workflows/icon-watch.yml`](.github/workflows/icon-watch.yml) runs daily: it scrapes the latest champion icons and, if the set changed (new champion, skin, or rework), retrains the classifier, **patch-bumps the version**, and opens a PR with the new model + a quality report. Validate tracking in a real game and merge — the version bump then triggers `release.yml` to build the draft release automatically. See § "Refreshing the champion classifier". The PR step needs Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" enabled. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) type-checks, builds, and tests every PR.

## Anti-patterns we've explicitly avoided

These are decisions worth knowing about before proposing a change:

- **Client-side proximity math (with or without per-room E2E encryption)** — would let modified clients read every peer's raw distance vector, which undoes the anti-cheat design. The current model (positions go to the server, server returns only volumes, client never sees another peer's coords) is intentional. See [`docs/threat-model.md`](docs/threat-model.md).
- **A hosted doc site** — flat markdown in the repo is the right resolution for a project this size. If `docs/` ever sprawls beyond 10-15 files, revisit.
- **Telemetry / analytics** — the project commits to none. If ever added, must be opt-in and visible in Settings. See [`docs/threat-model.md`](docs/threat-model.md) § "What we don't collect".
- **Self-hosted coturn as the default TURN backend** — Cloudflare Realtime TURN is the default; coturn remains a supported fallback for self-hosters, see [`docs/self-hosting.md`](docs/self-hosting.md).
