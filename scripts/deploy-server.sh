#!/usr/bin/env bash
#
# Deploy the signaling server to a remote Docker host by syncing source +
# rebuilding the container. Does NOT touch the remote compose file, so
# production secrets (ENCRYPTION_KEY, TURN tokens) stay where they are.
#
# Why this exists: the remote deploy is a file-sync, NOT a `git pull` on the
# host. The v0.2.0 / v0.2.1 server upgrades silently never landed because the
# sync was done by hand and new files were missed — every v0.2.x client then
# talked to a v0.1 server and got empty proximity volumes. This script makes the
# sync exhaustive and verifies the new code is actually serving before it claims
# success.
#
# Three things about a real deployment that this script got wrong until it was
# run against one, and which the variables below now exist to express:
#
#   * The build context and the compose project are usually DIFFERENT
#     directories. Running `docker compose up` inside the source directory
#     starts a second, competing stack rather than updating the running one —
#     the source dir may still hold an old docker-compose.yml that looks
#     plausible and is not what is deployed.
#   * The source directory may be root-owned, so a plain scp into it fails.
#     Files are staged in /tmp and installed with sudo.
#   * The container usually does not publish its port to the host, because a
#     reverse proxy reaches it over a docker network. Verifying with
#     `curl localhost:3100` therefore fails on a perfectly healthy deploy;
#     verification runs inside the container instead.
#
# Usage (from the repo root):
#
#   PROXCHAT_DEPLOY_HOST=dant123@192.168.0.10 \
#   PROXCHAT_DEPLOY_PATH=/home/dant123/data/proxchat-server \
#   PROXCHAT_COMPOSE_DIR=/home/dant123/apps \
#   ./scripts/deploy-server.sh
#
# Requires: passwordless ssh to the host, passwordless sudo there if the source
# directory is root-owned, and `docker compose` on the host.

set -euo pipefail

HOST="${PROXCHAT_DEPLOY_HOST:?set PROXCHAT_DEPLOY_HOST, e.g. dant123@192.168.0.10}"
DEST="${PROXCHAT_DEPLOY_PATH:?set PROXCHAT_DEPLOY_PATH — the compose build context, e.g. /home/dant123/data/proxchat-server}"
COMPOSE_DIR="${PROXCHAT_COMPOSE_DIR:?set PROXCHAT_COMPOSE_DIR — the dir holding the compose project, e.g. /home/dant123/apps}"
SERVICE="${PROXCHAT_SERVICE:-proxchat}"
CONTAINER="${PROXCHAT_CONTAINER:-proxchat}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
STAGE="/tmp/proxchat-deploy.$$"

echo "==> [1/6] Build + test locally first (fail before touching prod)"
( cd "$SERVER_DIR" && npm ci --silent && npm run build && npm test )

echo "==> [2/6] Confirm the remote is the deployment we think it is"
ssh "$HOST" "
  set -e
  test -d '$DEST' || { echo '    !! build context $DEST does not exist'; exit 1; }
  test -f '$COMPOSE_DIR/compose.yaml' -o -f '$COMPOSE_DIR/docker-compose.yml' \
    || { echo '    !! no compose file in $COMPOSE_DIR'; exit 1; }
  docker inspect '$CONTAINER' >/dev/null 2>&1 \
    || { echo '    !! container $CONTAINER is not running'; exit 1; }
  ctx=\$(docker inspect '$CONTAINER' --format '{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}' 2>/dev/null || true)
  echo \"    container's compose project dir: \${ctx:-<unlabelled>}\"
  echo -n '    rooms in use right now: '
  docker exec '$CONTAINER' wget -qO- http://127.0.0.1:3100/health 2>/dev/null || echo '(health unavailable)'
"

echo "==> [3/6] Back up remote source for rollback"
ssh "$HOST" "
  set -e
  cd '$DEST'
  ts=\$(date +%s)
  sudo cp -r src \"src.bak.\$ts\"
  for f in package.json package-lock.json tsconfig.json; do
    [ -f \"\$f\" ] && sudo cp \"\$f\" \"\$f.bak.\$ts\"
  done
  echo \"\$ts\" | sudo tee .last-deploy-backup >/dev/null
  echo \"    backed up as *.bak.\$ts\"
"

echo "==> [4/6] Sync source (staged in /tmp, installed with sudo — the dest may be root-owned)"
ssh "$HOST" "rm -rf '$STAGE' && mkdir -p '$STAGE/src'"
scp -q "$SERVER_DIR"/src/*.ts "$HOST:$STAGE/src/"
scp -q "$SERVER_DIR"/tsconfig.json \
       "$SERVER_DIR"/package.json \
       "$SERVER_DIR"/package-lock.json \
       "$SERVER_DIR"/Dockerfile \
       "$SERVER_DIR"/.dockerignore \
       "$HOST:$STAGE/"
ssh "$HOST" "
  set -e
  cd '$DEST'
  # Replace src wholesale so a file deleted upstream does not linger and get
  # compiled into the image.
  sudo rm -rf src
  sudo cp -r '$STAGE/src' ./src
  sudo cp '$STAGE'/tsconfig.json '$STAGE'/package.json '$STAGE'/package-lock.json \
          '$STAGE'/Dockerfile '$STAGE'/.dockerignore ./
  sudo chown -R root:root src tsconfig.json package.json package-lock.json Dockerfile .dockerignore
  sudo chmod 644 src/*.ts tsconfig.json package.json package-lock.json Dockerfile .dockerignore
  rm -rf '$STAGE'
  echo '    synced:'; sudo ls src/ | sed 's/^/      /'
"

echo "==> [5/6] Rebuild + restart, through the compose project that owns the container"
ssh "$HOST" "cd '$COMPOSE_DIR' && docker compose up -d --build '$SERVICE' 2>&1 | tail -5"

echo "==> [6/6] Verify the new code is actually serving"
sleep 4
ssh "$HOST" "
  set -e
  echo -n '    health:      '
  docker exec '$CONTAINER' wget -qO- http://127.0.0.1:3100/health; echo
  echo -n '    tiered path: '
  # A v0.3+ server returns myBlob:\"\" for a room-shaped request. A stale v0.1
  # server would return a non-empty encrypted blob — the exact symptom that hid
  # the v0.2 deploy never landing.
  docker exec '$CONTAINER' wget -qO- --header='Content-Type: application/json' \
    --post-data='{\"myPosition\":{\"x\":0,\"y\":0},\"roomId\":\"deploycheck\",\"name\":\"x\"}' \
    http://127.0.0.1:3100/compute-volumes; echo
  echo '    startup log:'
  docker logs '$CONTAINER' --since 1m 2>&1 | head -5 | sed 's/^/      /'
"

echo "==> Done. health ok + myBlob empty == the tiered path is live."
echo "    The startup log line names the proxy-trust mode in effect; if this host"
echo "    sits behind a CDN as well as a local reverse proxy, set TRUSTED_PROXIES."
echo "    Rollback: ssh $HOST \"cd $DEST && ts=\\\$(cat .last-deploy-backup) && sudo rm -rf src && sudo cp -r src.bak.\\\$ts src && cd $COMPOSE_DIR && docker compose up -d --build $SERVICE\""
