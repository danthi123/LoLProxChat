# Self-Hosting the Signaling Server

This guide is for operators who want to run their own signaling server instead of using the default at `proxchat.dant123.com`. Pointing the client at a different server is a build-time decision — see [`CONTRIBUTING.md`](../CONTRIBUTING.md) § "Common commands" for the build flow and the `PROXCHAT_SERVER` env var.

For client-side usage, see the [user guide](user-guide.md).

**License note (AGPLv3).** If you run a *modified* version of the server as a network service, the AGPLv3 requires you to offer its users the corresponding source. Running it unmodified — or modifying it privately without offering it as a network service — carries no such obligation.

## What you'll set up

Four pieces — the first three are server-side, and the last one you build once:

1. **The signaling server** — one small Node container via Docker Compose. Handles room presence, relays the WebRTC handshake, and does the distance→volume math.
2. **A TURN relay** — so players behind strict NATs can still connect to each other. Easiest is **Cloudflare Realtime TURN** (nothing to run, generous free tier); or self-host **coturn** if you'd rather not use Cloudflare.
3. **A reverse proxy for HTTPS** — Caddy or nginx in front of the server to terminate TLS and forward WebSockets. You almost certainly already run one.
4. **The client, rebuilt to point at your server** — a one-time `tauri build` with your server URL baked in, which you then hand to your players.

**The fast path is Steps 1–4 below** — Cloudflare TURN + Docker + Caddy — and that's all most people need. The coturn section near the end is only if you'd rather run your own relay.

## Architecture in one paragraph

The server is a ~500-LOC Node process: WebSocket signaling (room presence + offer/answer/ICE relay + per-client XY coords store), per-pair distance → volume math against that store, and TURN credential issuance (Cloudflare Realtime TURN by default; coturn HMAC as a fallback). Single container deployed via Docker Compose. Stateless modulo the in-memory rooms table (which now also holds the latest coords per client) — restarts drop active rooms, clients reconnect automatically. See [`architecture.md`](architecture.md) for the full picture.

## Prerequisites

- A Linux host with Docker (or Node 18+ for the no-Docker path).
- A domain name, with a DNS record pointing at your host, plus a wildcard or specific TLS cert (Caddy or another auto-cert reverse proxy makes the cert painless).
- A Cloudflare account if you're going the recommended TURN route. The free tier covers 1 TB egress/month — sufficient for thousands of voice-hours.
- Only for the final "rebuild the client" step: the **Rust + Tauri build toolchain** on whatever machine you build on (see [`CONTRIBUTING.md`](../CONTRIBUTING.md)). It's a heavier install than the server — nothing else here needs it.

## Step 1 — Get TURN credentials (Cloudflare Realtime TURN, recommended)

For users behind symmetric NAT (mobile networks, some corporate setups), peers need a TURN relay to connect. The default deployment uses Cloudflare Realtime TURN — 1 TB/month egress free, no infrastructure to maintain, $0.05/GB after.

1. Sign in to the [Cloudflare Dashboard](https://dash.cloudflare.com).
2. **Realtime** → **TURN** → **Create TURN Key**. Name it something memorable (e.g. `lolproxchat-prod`).
3. Copy both values that appear:
   - **TURN Key ID** — UUID-like identifier
   - **API Token** — secret bearer token, **shown only once at creation**

If you'd rather self-host coturn instead, skip to § "Optional: self-host coturn" below.

**To avoid surprise bills:** don't add a payment method to your Cloudflare account. The free tier becomes a hard cap — service degrades at quota instead of charging.

## Step 2 — Write `.env`

Next to the compose file:

```ini
TURN_KEY_ID=<UUID from Cloudflare>
TURN_KEY_API_TOKEN=<token from Cloudflare>
```

The compose file is at [`docker-compose.proxchat.yml`](../docker-compose.proxchat.yml) in the repo root. `.env` is already in `.gitignore`.

Those two lines are the whole file for a Cloudflare-TURN deployment — unless a CDN sits in front of your reverse proxy, in which case add `TRUST_PROXY=2` and read § "Client IP and rate limits" under Operational notes first, because the server-side half alone isn't enough. (You'll spot an `ENCRYPTION_KEY` in the compose — it's a leftover from the old pre-v0.3 position-encryption path that the current server ignores. Leave it unset.)

## Step 3 — Deploy via Docker

```bash
docker compose -f docker-compose.proxchat.yml up -d
```

The server listens on `:3100`. Front it with a TLS-terminating reverse proxy that supports WebSocket upgrades. Example Caddy block:

```caddy
proxchat.your-domain.com {
  reverse_proxy localhost:3100
}
```

Caddy upgrades WebSockets automatically, and it strips incoming `X-Forwarded-*` headers unless you set `trusted_proxies`, so the value the server sees is the one Caddy observed. Nothing else to configure — unless a CDN sits in front, in which case read § "Client IP and rate limits" below before you add `trusted_proxies`.

For nginx, ensure **all five** of these:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

The two address headers are not optional. nginx sends neither unless you tell it to, so without them every one of your users is rate-limited as if they were a single client at the proxy's address: the 20-connection WebSocket cap becomes a *global* 20-connection cap and your server goes quietly dead at user 21. Set both rather than one — the server cross-checks them, and a mismatch (which is what a client supplying its own `X-Forwarded-For` produces) makes it discard both and fall back to the proxy's address.

### Or deploy directly (no Docker)

```bash
cd server
npm install
npm run build
PORT=3100 TURN_KEY_ID=<id> TURN_KEY_API_TOKEN=<token> npm start
```

Put a reverse proxy in front of this too. If you deliberately run it without one — a LAN-only deployment, say — add `TRUST_PROXY=off` so the rate limits key on the real connection rather than on a header the client can choose.

## Step 4 — Verify

```bash
# Health (server up, accepting requests)
curl https://proxchat.your-domain.com/health
# {"status":"ok","rooms":0}

# TURN credentials (Cloudflare proxy working)
curl https://proxchat.your-domain.com/turn-credentials
# {"iceServers":[{...,"urls":["turn:turn.cloudflare.com:..."]}]}

# WebSocket handshake (should return 101 Switching Protocols)
curl -i -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGVzdA==" \
     https://proxchat.your-domain.com/ws
```

If all three return what you expect, you can point a client at this server (rebuild with `PROXCHAT_SERVER=https://proxchat.your-domain.com`) and start using it.

## Optional: self-host coturn instead of Cloudflare

If you'd rather run your own TURN relay (e.g. you don't want a Cloudflare account, or you want full data-path control), the signaling server still supports coturn HMAC credentials as a fallback. It's used automatically when `TURN_KEY_ID` is unset and `TURN_SERVER` + `TURN_SECRET` are present.

### Server-side env vars

```ini
TURN_SERVER=turn.your-domain.com
TURN_SECRET=<coturn-shared-secret>
```

If both Cloudflare and coturn vars are set, the server prefers Cloudflare.

### Uncomment the coturn service block

The `docker-compose.proxchat.yml` ships with a coturn block commented out. Uncomment it and configure the bits below.

### Minimal `turnserver.conf`

```ini
listening-port=3478
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=<same value as TURN_SECRET env var>
realm=your-domain.com
server-name=turn.your-domain.com
external-ip=<your-public-ip>
min-port=49152
max-port=49252
no-multicast-peers
no-cli
```

### Router-side

Forward to the coturn host:

- UDP 3478 (TURN/STUN)
- UDP 49152–49252 (relay range, must match `min-port` / `max-port`)
- TCP 5349 if you add TURNS (next section)

The signaling server's `/turn-credentials` endpoint issues short-lived HMAC credentials so the static auth secret never leaves your infrastructure.

### TURNS (TLS) — recommended

TURNS protects credentials in transit, looks like generic HTTPS to firewalls, and helps users on restrictive corporate networks connect. If you already run Caddy / nginx-proxy-manager / Traefik with a wildcard cert for your domain, you can mount the cert dir into coturn:

1. Set `TLS_CERT_DIR=/path/to/dir/containing/wildcard.crt-and-.key` in `.env` next to the compose. The compose references `${TLS_CERT_DIR}` and the `.env` is not committed.
2. Append to `turnserver.conf`:
   ```ini
   tls-listening-port=5349
   cert=/certs/wildcard_.your-domain.com.crt
   pkey=/certs/wildcard_.your-domain.com.key
   ```
   Filenames must match what's in `${TLS_CERT_DIR}`.
3. Forward TCP 5349 on your router.
4. **Cert renewal.** Reverse proxies auto-renew but coturn caches the cert at startup. Schedule a nightly restart so renewed certs get picked up:
   ```cron
   17 4 * * * /usr/bin/docker restart proxchat-coturn >/dev/null 2>&1
   ```
   A few seconds of TURNS downtime each night; users mid-call won't notice.

### Verifying TURNS works

```bash
echo "" | openssl s_client -connect turn.your-domain.com:5349 \
  -servername turn.your-domain.com 2>&1 | grep -E "subject=|issuer=|Verification"
# Expect:
#   subject=CN=*.your-domain.com
#   issuer=...Let's Encrypt...
#   Verification: OK
```

## Updating an existing deployment

If your remote is a hand-synced directory of `server/` files (rather than a `git` checkout on the host), **updates are a file-sync, not a `git pull`** — and a partial sync silently runs stale code: clients talk to an old server and proximity quietly breaks with no error. (This has bitten the project in production.)

Use [`scripts/deploy-server.sh`](../scripts/deploy-server.sh) to do it safely. It builds + tests locally first, backs up the remote source, syncs **all** of `server/src/` plus the build files, rebuilds the container, and then verifies the new code is actually serving before declaring success. It never touches the remote `docker-compose.yml`, so your secrets stay put.

```bash
PROXCHAT_DEPLOY_HOST=root@your-host \
PROXCHAT_DEPLOY_PATH=/path/to/proxchat-server \
./scripts/deploy-server.sh
```

## Operational notes

- **The server is stateless modulo rooms.** Restarts drop active rooms; clients reconnect. No DB to migrate, no persistence to back up.
- **Health checks.** Docker Compose includes a built-in healthcheck that hits `/health` every 30 s. The README's status badge also pulls from this endpoint via Shields.io.
- **TLS termination is your responsibility.** Caddy is the recommended default since it handles cert renewal end-to-end. nginx + certbot also works but renewal is a separate concern.
- **WebSocket upgrades.** Any reverse proxy you use must support and forward the WebSocket upgrade headers, or `/ws` will fail even if `/health` returns 200.
- **Rate limiting.** The server ships with rate limits, a body-size cap, and WebSocket connection/message limits built in (`server/src/rate-limit.ts::LIMITS`). Defaults: `/turn-credentials` 60/min per IP; `/compute-volumes` keyed per player (IP + name) and sized for the max scan rate, plus a generous per-IP backstop and a 256 KB body cap; WebSocket 20 connections per IP + 64 KB per message. Legitimate clients never trigger them. If you serve an unusual environment (e.g. a CG-NAT'd ISP where many subscribers share one public IP), the constants in `LIMITS` are the single place to adjust + rebuild. The limits themselves have no env-var knobs by design — that keeps the server config trivially auditable. `TRUST_PROXY` (below) is the one exception, and it isn't limit tuning: it describes your deployment's topology, which the build can't know.

- **Client IP and rate limits.** Every per-IP limit keys off the address the server resolves for the request, so getting that address right is the difference between working limits and either a bypass or a dead server.

  - **A CDN in front is the case to get right.** With Cloudflare (or any CDN) → your proxy → the server, the address your proxy appends is the *CDN edge*, not the player. Left alone, every user on the planet collapses into one bucket and the 20-connection WebSocket cap becomes a global one. Fix it with both halves of a single instruction: set `TRUST_PROXY=2` on the server **and**, in the same change, configure your proxy to trust the CDN (Caddy: `trusted_proxies` covering Cloudflare's published ranges inside the `reverse_proxy` block; nginx: `set_real_ip_from` + `real_ip_header CF-Connecting-IP`). `TRUST_PROXY=2` without the proxy-side half is worse than doing nothing — your proxy discards the CDN's header, the server counts a hop that isn't in the list, and you land right back in the one-bucket failure.
  - **`TRUST_PROXY` values.** Unset (or `1`) means one reverse proxy of yours in front — the setup in Step 3, and what you want. A number means that many of your own proxies append to `X-Forwarded-For`. `off` ignores forwarding headers entirely and keys on the TCP peer.
  - **Forwarding headers are only read from a private peer.** `X-Forwarded-For` / `X-Real-IP` are honoured only when the connection arrives from loopback, a private range, or link-local — i.e. from a reverse proxy on your own host or Docker network. A client that reaches the server directly arrives with a public address and its headers are ignored, so publishing `:3100` doesn't hand it a way to pick its own bucket. Header values that aren't IP addresses are discarded the same way.
  - **Publishing the port bypasses your proxy.** `docker-compose.proxchat.yml` publishes `3100:3100` on all interfaces so a containerised Caddy can reach it. If your proxy runs on the host, change it to `127.0.0.1:3100:3100` and nothing outside can reach the server except through TLS.
  - **Rootless Docker, Podman and Docker Desktop break the peer gate.** Their port forwarding rewrites the source address to the bridge gateway, so *every* inbound connection looks private and forwarding headers are trusted from anyone. On those runtimes, either bind the published port to `127.0.0.1` as above or set `TRUST_PROXY=off`. Rootful Docker (the normal Linux install, including Unraid) preserves the real source address and is unaffected.
  - **No proxy at all — LAN or plain `http://` on a port.** Every client then connects from a private address, which the gate treats as trusted, so any of them could supply its own `X-Forwarded-For`. Set `TRUST_PROXY=off` for that deployment; the limits then key on the real TCP peer.
  - **Confirm what the process resolved.** The server prints `proxchat-server trust-proxy: …` next to its listen line at startup, so `docker logs proxchat-server | head` settles it without guessing. When requests are being rejected it also logs one aggregate line a minute — counts by reason plus how many distinct buckets each limiter holds, with no addresses or player names in it. Bucket counts stuck at ~1 while `/health` reports many rooms is the signature of everyone collapsing into a single bucket.
  - **Setting it on an existing deployment.** [`scripts/deploy-server.sh`](../scripts/deploy-server.sh) deliberately never touches the remote `docker-compose.yml`, so adding `TRUST_PROXY` to the compose file in this repo does **not** reach a running host. Add the line to the compose file on the box (or its `.env`) and `docker compose up -d` there.

## Pointing the client at your server

A built client bakes in its `PROXCHAT_SERVER` URL at compile time, so each operator builds their own. To point at your deployment:

1. Clone the repo, `cp .env.example .env`.
2. Edit `.env`: `PROXCHAT_SERVER=https://proxchat.your-domain.com`.
3. `npx tauri build` — this is the one step that needs the Rust + Tauri toolchain rather than just Docker (see [`CONTRIBUTING.md`](../CONTRIBUTING.md)).
4. Distribute the resulting `lolproxchat.exe` to your users (or run it yourself).

The WebSocket URL is derived from `PROXCHAT_SERVER` (`https://` → `wss://`).

## When to graduate off self-hosting

You probably don't need to. The default deployment at `proxchat.dant123.com` is what 99% of users use, and a private deployment makes sense in only two cases:

- **Trust.** You don't want a third party (me) to be able to see your room's positions. The server holds them in process memory, so whoever runs it can read them. See [`threat-model.md`](threat-model.md) § "Server operator can read all positions".
- **Capacity.** You're running a player base large enough to justify operational cost. (For perspective: 1000 concurrent users at full Opus 128 kbps would be ~16 MB/s of voice, well within any small-VPS budget.)

If neither applies, save yourself the ops work.
