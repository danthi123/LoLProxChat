# CV Minimap Tracking — Research Findings & Improvement Plan

> Deep-research pass (2026-06-03): 22 sources, 25 claims adversarially verified (23 confirmed, 2 refuted). Goal: move toward near-perfect realtime champion-icon tracking. This doc captures the findings and the prioritized plan; it is the input to the v0.4 CV overhaul.

## TL;DR

Stop using a pre-trained 172-class classifier to decide "is this blob my champion." Instead **exploit the known-10-templates constraint**: at game start, fetch the 10 actual champion icons (Data Dragon / Community Dragon) and match detected blobs against those real icons by **template matching** (SSIM / normalized cross-correlation), optionally upgraded to a **learned siamese embedding** later. This single reframe kills three of our observed failure modes at once:

- **Minion / structure clinging** → a minion dot or turret icon has ~0 similarity to a champion portrait, so it's rejected for free (the classifier had to actively distinguish them and failed).
- **Per-champion weakness (Teemo)** → no per-champion training; every champion is matched against its own real icon, so there's no "weak class."
- **Synthetic-to-real domain gap** → matching against the *real in-game-derived icon* removes the "trained on clean wiki art" gap entirely.

It's also **lighter** (10 cheap comparisons vs a 172-class CNN per frame) and needs **no model file or training**.

## Critical meta-finding: our 92% eval number is not trustworthy

> "While synthetic validation metrics were consistently high, they proved to be poor predictors of real-world performance." — arXiv:2509.15045 (Synthetic-to-Real Object Detection w/ YOLOv11 + Domain Randomization)

The CV eval harness measured the shipped model at ~92% top-1 / 97.5% self@10 — but that's on synthetically-augmented wiki icons. The research confirms (with the caveat it was the one 2-1 split vote, corroborated by Syn2Real + arXiv:2510.12208/2505.17959) that synthetic scores don't predict real performance. **A real labeled minimap-crop test set is required to gauge true accuracy.** Our real-game logs (Teemo mis-tracking, minion clinging) are the real signal; the 92% was a mirage.

## Prior art (what others shipped)

| Project | Approach | Lesson |
|---|---|---|
| **LOL_Minimap_Tracker** (Quinntana) | capture → OpenCV circle/blob detect → **SSIM** match vs known champion icons → overlay. **No CNN classifier.** | Validates the exact reframe: same blob-detect front-end we have, classifier swapped for direct template comparison. |
| **League-Minimap-Scanner** (dcheng728) | isolate red ring (R − B − G channel math) → HoughCircles → 24×24×3 CNN over 31 champs | Classical detection + a *small* fixed-class CNN. Smaller/weaker than ours; confirms blob-then-identify structure. |
| **boboyes/leagueoflegends-minimap-detection** (HF) | fine-tuned **YOLOv11**; n: mAP@50 0.773 / recall **0.704** | Detector route works, but nano-class recall is weak (~30% icons missed/frame absent temporal smoothing) AND trained on synthetic data → real gap. Heavier than template matching. |
| **DeepLeague** (farzaa) | 100k+ real labeled minimap crops, **auto-labeled** from lolesports websocket per-second position JSON synced to VOD frames (OCR timer alignment). | The blueprint for harvesting real training/validation data without hand-labeling. Caveat: 2018-era, ~55 LCS-meta champs (almost no Teemo), pro 1080p broadcast ≠ solo-queue overlay capture. |
| **LeagueAI** (Oleffa) | synthetic data: 3D model viewer → ~1000 masked PNGs/champ → composite on real map screenshots → domain randomization (blur, noise, counts, HUD/scale) | Blueprint for synthetic augmentation if we generate our own. Hand-labeling 700 imgs took 4 days → synthetic justified. |

## The matching paradigm (research Q2)

Ranked for our case (10 known small icons, in-browser realtime):

1. **SSIM / NCC template matching** — shipped-and-working (LOL_Minimap_Tracker), no training, cheap, brightness-robust (NCC especially). Best impact-per-effort first step.
2. **Learned siamese embedding + NCC in feature space (NCCNet, arXiv:1705.08593)** — "siamese convolutional networks significantly reduce false matches" vs tuned baseline (to reach zero false matches, rejects only 0.12% of true matches). The robust upgrade: train a small embedding once, match crops against the 10 icon embeddings computed at game start. Per-sample-prototype few-shot (arXiv:2109.07734) supports the "each known icon is its own prototype" formulation.
3. **YOLOv11-nano detector** — proven but heavier, weak nano recall, synthetic-trained. Overkill given we already have good blob localization.

Caveat: no source benchmarks SSIM vs NCC vs siamese vs YOLO-nano head-to-head on *real* LoL minimap crops — ranking is from each technique's properties, not measured on this task. So we validate empirically on harvested real crops.

## Temporal tracking (research Q3)

- **Norfair** (tryolabs) — lightweight SORT-based point tracker, **detector-agnostic** (any front-end emitting (x,y) drives it), Kalman prediction + Hungarian matching built in, ReID optional. Bolts onto our pipeline with no detector retraining. The principled replacement for our ad-hoc velocity-extrapolation + hold logic, and it naturally tracks *all 10* icons (not just self), which helps disambiguation.
- Standard **constant-velocity Kalman is fine** for slow minimap motion. The "KF fails on tiny objects" result (arXiv:2509.18451) is about *fast bouncing* objects (frequent direction changes), not our regime — explicitly does not apply.

## Domain gap / data (research Q5)

- Dominant root cause. Fix = **real labeled crops**, harvested via known roster + positions (DeepLeague method). Open question: whether the modern Live Client Data API exposes enough position signal to auto-label our own solo-queue overlay captures the way DeepLeague did from the 2018 broadcast websocket. **We can harvest from our OWN app**: during a real game we know the roster and our own CV-confident positions — save labeled crops opt-in (debug) to build a real test/train set.
- Domain randomization must model the *minimap-specific* nuisances: fog-of-war darkening, teal/red ring borders, level-up rings, summoner-spell overlays, overlapping icons, 16–40px scale across HUD settings. (Refuted: "more perspective/background diversity closes the gap" — 0-3; not the lever here.)

## Realtime in-browser (research Q6)

- ONNX Runtime Web (WASM CPU / WebGL→WebGPU GPU). **WASM multi-threading + SIMD ≈ 3.4× CPU speedup** — effectively mandatory if we keep any neural model on the hot path.
  - Status in the shipped app: **SIMD is already on** — webpack copies only `ort-wasm-simd-threaded*`, and ort auto-detects SIMD. **Batching is done**: one `session.run` per scan over an `[N,3,32,32]` tensor instead of one run per teal icon (the graph declares a symbolic batch axis on both `input` and `logits`, and contains no BatchNormalization/Dropout, so batched scores are per-sample identical).
  - **Threads are still off, and not free.** `numThreads > 1` needs SharedArrayBuffer, which needs the page to be cross-origin isolated. Prerequisites for that experiment, all to be re-verified on a real Windows build: `app.security.headers` with COOP `same-origin` + COEP `credentialless` in `tauri.conf.json`; both cross-origin fetches still working under COEP (`/turn-credentials` in `src/core/config.ts`, `/compute-volumes` in `src/services/volume-client.ts`); and that WebView2 treats `http://tauri.localhost` as a secure context. Header changes are a security-posture change, not a perf tweak — they do not belong in a perf pass.
  - Measurement to take before any further work here: with Debug on, log N and `session.run` wall time for a real game. `run()` is synchronous on the calling thread (`ort.env.wasm.proxy = false`), and that thread also paints the overlay panel, so the number that matters is the single-block time, not just total CPU.
- But cheap SSIM/NCC matching against 10 templates "is far lighter than a 172-class per-frame CNN" and **may remove the neural model from the hot path entirely** — the single biggest realtime win. WebGL is maintenance-mode; WebGPU (Chrome/Edge 113+) is the forward GPU path if we keep a model.

## Prioritized plan (impact-per-effort)

### Phase A — stop the bleeding (small, ship in v0.3.1)
1. Revert/soften the v0.3 `nextClassifierEma` snap-up (it pins confidence to 1.0 on near-zero-raw wrong blobs → minion clinging) back toward a proper asymmetric EMA.
2. Loosen the over-strict v0.3 gates (`shouldAcceptLocked`, 3s coords-suppression) that gate on classifier confidence and so refuse to lock/broadcast for weak-classifier champs.
3. Keep the stuck-gain fix + MIC/VOL. Cut v0.3.1.

### Phase B — the real fix (the v0.4 CV overhaul)
4. **Per-game template matching.** At session start, fetch the 10 champions' real icons (Data Dragon `champion/<Name>.png` / Community Dragon), circular-crop + scale to the detected icon size. Replace `getClassifierScore(blob)` with an SSIM/NCC match against the local champion's icon (and optionally all 10 for disambiguation). Drop the 172-class ONNX model from the hot path.
5. **Blob pre-filter.** Reject minion/structure blobs by size + fill-ratio + shape before identity scoring (tighten what already exists; minions are smaller, structures are non-circular).
6. **Norfair-style MOT.** Track all detected icons with a lightweight Kalman+Hungarian layer; identity = best template match, smoothed over time. Replaces ad-hoc hold/extrapolation.

### Phase C — validation & robustness (ongoing)
7. **Harvest real crops** opt-in during real games (we know the roster + our confident positions) → build a real labeled test set. Re-measure everything on it (the 92% synthetic number is not to be trusted).
8. If template matching alone isn't robust enough, train a small **siamese embedding (NCCNet-style)** once and match in feature space.

## Sources
- LOL_Minimap_Tracker: https://github.com/Quinntana/LOL_Minimap_Tracker
- League-Minimap-Scanner: https://github.com/dcheng728/League-Minimap-Scanner
- YOLOv11 minimap (HF): https://huggingface.co/boboyes/leagueoflegends-minimap-detection
- NCCNet: https://arxiv.org/abs/1705.08593 · https://github.com/seung-lab/NCCNet
- Per-sample-prototype few-shot: https://arxiv.org/pdf/2109.07734
- Norfair: https://github.com/tryolabs/norfair
- KF-on-tiny-objects (does NOT apply): https://arxiv.org/html/2509.18451v1
- Synthetic-to-real gap: https://arxiv.org/abs/2509.15045 · https://ai.bu.edu/syn2real
- DeepLeague: https://github.com/farzaa/DeepLeague · https://maknee.github.io/blog/2021/League-ML-Minimap-Detection2/
- LeagueAI: https://github.com/Oleffa/LeagueAI · https://arxiv.org/abs/1905.13546
- ONNX Runtime Web: https://opensource.microsoft.com/blog/2021/09/02/onnx-runtime-web-running-your-machine-learning-model-in-browser/
