#!/usr/bin/env bash
# Bash twin of build-image.ps1 (same options) for Linux hosts.
#   ./build-image.sh [--tag T] [--gstack-ref SHA] [--no-cache] [--smoke-test] [--deploy] [--config-dir DIR] [--registry R --push]
set -euo pipefail
NAME=gstack-browser-mcp
ROOT=$(cd "$(dirname "$0")" && pwd)
TAG=""; GSTACK_REF=""; NOCACHE=""; SMOKE=0; DEPLOY=0; PUSH=0; REGISTRY=""
CONFIG_DIR=${CONFIG_DIR:-/srv/gstack-browser-mcp}; LAN_TARGET=${LAN_TARGET:-http://192.168.1.6:8654}; KEEP=3
while [ $# -gt 0 ]; do case "$1" in
  --tag) TAG=$2; shift 2;; --gstack-ref) GSTACK_REF=$2; shift 2;; --no-cache) NOCACHE=--no-cache; shift;;
  --smoke-test) SMOKE=1; shift;; --deploy) DEPLOY=1; shift;; --config-dir) CONFIG_DIR=$2; shift 2;;
  --registry) REGISTRY=$2; shift 2;; --push) PUSH=1; shift;; --lan-target) LAN_TARGET=$2; shift 2;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done
step() { printf '\033[36m==> %s\033[0m\n' "$*"; }

docker version --format '{{.Server.Os}}' | grep -qx linux || { echo "Docker must run Linux containers" >&2; exit 1; }
GSTACK_REF=${GSTACK_REF:-$(tr -d '[:space:]' < "$ROOT/.gstack-ref")}
VERSION=$(node -p "require('$ROOT/package.json').version" 2>/dev/null || grep -m1 '"version"' "$ROOT/package.json" | cut -d'"' -f4)
BUILD=1
if [ -z "$TAG" ]; then
  SHA=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)
  [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ] && SHA="$SHA-dirty"
  TAG="$VERSION-$SHA"
elif [ "$DEPLOY" = 1 ] && [ "$SMOKE" = 0 ] && [ "$PUSH" = 0 ]; then BUILD=0; fi
IMAGE="$NAME:$TAG"

if [ "$BUILD" = 1 ]; then
  step "Building $IMAGE (gstack ${GSTACK_REF:0:10})"
  docker buildx build -f "$ROOT/docker/Dockerfile" --platform linux/amd64 $NOCACHE \
    --build-arg GSTACK_REF="$GSTACK_REF" --build-arg APP_VERSION="$TAG" -t "$IMAGE" -t "$NAME:latest" --load "$ROOT"
fi

if [ "$SMOKE" = 1 ]; then
  P=gstack-smoke-$(head -c3 /dev/urandom | od -An -tx1 | tr -d ' \n')
  TMP=$(mktemp -d)
  key() { echo "gsk_$(head -c32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"; }
  hash() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
  K1=$(key); K2=$(key); ET=$(key); PK=$(key)
  printf '{"keys":{"%s":{"user":"smoke-a","role":"admin"},"%s":{"user":"smoke-b","role":"user"}}}' "$(hash "$K1")" "$(hash "$K2")" > "$TMP/keys.json"
  cleanup() { docker rm -f "$P-app" "$P-egress" "$P-tester" >/dev/null 2>&1 || true; docker network rm "$P-int" "$P-out" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
  trap cleanup EXIT
  step "Smoke test: isolated networks $P-int (internal) / $P-out"
  docker network create --internal "$P-int" >/dev/null; docker network create "$P-out" >/dev/null
  docker run -d --name "$P-egress" --network "$P-int" --network-alias egress-proxy -e EGRESS_TOKEN="$ET" --cap-drop ALL --user 65534:65534 "$IMAGE" bun src/egress/egressProxy.ts >/dev/null
  docker network connect "$P-out" "$P-egress"
  docker run -d --name "$P-app" --network "$P-int" --network-alias gstack-browser-mcp --init --shm-size 1g \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --cap-add KILL \
    --security-opt no-new-privileges:true -e EGRESS_TOKEN="$ET" -e AUTH_PROFILE_KEY="$PK" -e MAX_SESSIONS=4 \
    -v "$TMP/keys.json:/config/keys.json:ro" "$IMAGE" >/dev/null
  for _ in $(seq 60); do docker exec "$P-app" curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1 && break; sleep 1; done
  step "Running tests/smoke/smoke.sh in a tester container"
  if ! docker run --rm --name "$P-tester" --network "$P-int" -e GSTACK_REMOTE_URL=http://gstack-browser-mcp:8080/gstack \
      -e GSTACK_REMOTE_KEY="$K1" -e KEY2="$K2" -e LAN_TARGET="$LAN_TARGET" \
      -v "$ROOT/client:/client:ro" -v "$ROOT/tests:/tests:ro" "$IMAGE" bash /tests/smoke/smoke.sh; then
    docker logs --tail 60 "$P-app"; docker logs --tail 30 "$P-egress"; echo "Smoke test FAILED" >&2; exit 1
  fi
  step "Smoke test passed"
fi

if [ "$DEPLOY" = 1 ]; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image $IMAGE not found" >&2; exit 1; }
  ENVF="$CONFIG_DIR/.env"; [ -f "$ENVF" ] || { echo "$ENVF not found" >&2; exit 1; }
  step "Deploying $IMAGE"
  { grep -v '^IMAGE_TAG=' "$ENVF" || true; echo "IMAGE_TAG=$TAG"; } > "$ENVF.tmp" && mv "$ENVF.tmp" "$ENVF"
  docker compose --env-file "$ENVF" -f "$ROOT/deploy/docker-compose.yml" up -d --remove-orphans
  for _ in $(seq 90); do [ "$(docker inspect -f '{{.State.Health.Status}}' gstack-browser-mcp 2>/dev/null)" = healthy ] && break; sleep 2; done
  [ "$(docker inspect -f '{{.State.Health.Status}}' gstack-browser-mcp)" = healthy ] || { echo "not healthy; roll back with --deploy --tag <previous>" >&2; exit 1; }
  docker images "$NAME" --format '{{.CreatedAt}}\t{{.Tag}}' | grep -v -P '\t(latest|<none>)$' | sort -r | cut -f2 | tail -n +$((KEEP+1)) \
    | grep -vx "$TAG" | xargs -r -I{} docker rmi "$NAME:{}" >/dev/null
  step "Deployed $IMAGE"
fi

if [ "$PUSH" = 1 ]; then
  [ -n "$REGISTRY" ] || { echo "--push needs --registry" >&2; exit 1; }
  for t in "$TAG" latest; do docker tag "$NAME:$t" "$REGISTRY/$NAME:$t"; docker push "$REGISTRY/$NAME:$t"; done
fi
step "Done: $IMAGE"
