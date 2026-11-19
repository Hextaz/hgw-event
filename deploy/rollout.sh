#!/usr/bin/env bash
# Rollout atomique Docker Compose pour hgw-event : pull de l'image cible, verification du digest
# en cours d'execution, check de readiness (GET /api/state) et rollback auto en cas d'echec.
# Aucun secret requis ici : le .env reste sur la VM (gitignore), l'image vient de GHCR (public).
# Usage :
#   HGW_IMAGE=ghcr.io/hextaz/hgw-event:prod ./deploy/rollout.sh
set -euo pipefail

PROJECT="${COMPOSE_PROJECT_NAME:-hgw-event}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
SERVICE="app"
READY_URL="${READY_URL:-http://127.0.0.1:${HGW_HOST_PORT:-3000}/api/state}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-90}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-2}"
SKIP_IF_UNCHANGED="${SKIP_IF_UNCHANGED:-0}"
FORCE_ROLLOUT="${FORCE_ROLLOUT:-0}"
REJECTED_STATE_FILE="${REJECTED_STATE_FILE:-/var/tmp/${PROJECT}-rejected-target.state}"

if [[ -z "${HGW_IMAGE:-}" ]]; then
  echo "[ROLLOUT] Error: HGW_IMAGE must be set (e.g. ghcr.io/hextaz/hgw-event:prod)" >&2
  exit 1
fi

COMPOSE_ARGS=(-p "$PROJECT" -f "$COMPOSE_FILE")

get_running_image_id() {
  local cid
  cid="$(docker compose "${COMPOSE_ARGS[@]}" ps -q "$SERVICE" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$cid" ]]; then
    docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true
  fi
}

check_ready() {
  curl --silent --show-error --fail --max-time 5 "$READY_URL" >/dev/null 2>&1
}

wait_for_readiness() {
  local elapsed=0
  while (( elapsed < READY_TIMEOUT_SECONDS )); do
    if check_ready; then
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
    elapsed=$(( elapsed + POLL_INTERVAL_SECONDS ))
  done
  return 1
}

PREV_IMAGE_ID="$(get_running_image_id)"

echo "[ROLLOUT] Pulling target image $HGW_IMAGE for project '$PROJECT'..."
docker compose "${COMPOSE_ARGS[@]}" pull "$SERVICE"

TARGET_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$HGW_IMAGE")"
TARGET_KEY="$TARGET_IMAGE_ID"

if [[ "$SKIP_IF_UNCHANGED" == "1" && "$FORCE_ROLLOUT" != "1" && -f "$REJECTED_STATE_FILE" ]]; then
  if [[ "$(cat "$REJECTED_STATE_FILE" 2>/dev/null || true)" == "$TARGET_KEY" ]]; then
    echo "[ROLLOUT] Target digest ($TARGET_KEY) was previously rejected and rolled back; skipping until a new image is published or FORCE_ROLLOUT=1."
    exit 0
  fi
fi

if [[ "$SKIP_IF_UNCHANGED" == "1" && -n "$PREV_IMAGE_ID" && "$PREV_IMAGE_ID" == "$TARGET_IMAGE_ID" ]]; then
  if check_ready; then
    echo "[ROLLOUT] Running container already matches target digest ($TARGET_IMAGE_ID) and is healthy; nothing to do."
    exit 0
  fi
fi

echo "[ROLLOUT] Applying update (target digest: $TARGET_IMAGE_ID)..."
ROLLOUT_OK=0
if ! docker compose "${COMPOSE_ARGS[@]}" up -d --no-build "$SERVICE"; then
  echo "[ROLLOUT] Error: docker compose up failed for target update." >&2
elif [[ "$(get_running_image_id)" != "$TARGET_IMAGE_ID" ]]; then
  echo "[ROLLOUT] Error: post-start image digest verification failed." >&2
elif wait_for_readiness; then
  ROLLOUT_OK=1
else
  echo "[ROLLOUT] Error: readiness check timed out after ${READY_TIMEOUT_SECONDS}s." >&2
fi

if [[ "$ROLLOUT_OK" == "1" ]]; then
  rm -f "$REJECTED_STATE_FILE"
  echo "[ROLLOUT] Success: container is ready and verified on digest $TARGET_IMAGE_ID."
  exit 0
fi

mkdir -p "$(dirname "$REJECTED_STATE_FILE")"
printf '%s' "$TARGET_KEY" > "$REJECTED_STATE_FILE"
echo "[ROLLOUT] Update failed! Recorded rejected target ($TARGET_KEY) in $REJECTED_STATE_FILE and initiating automatic rollback..." >&2
if [[ -n "$PREV_IMAGE_ID" ]]; then
  export HGW_IMAGE="$PREV_IMAGE_ID"
  if docker compose "${COMPOSE_ARGS[@]}" up -d --no-build "$SERVICE" \
    && [[ "$(get_running_image_id)" == "$PREV_IMAGE_ID" ]] \
    && wait_for_readiness; then
    echo "[ROLLOUT] Rolled back and verified ready on previous image digest ($PREV_IMAGE_ID)." >&2
  else
    echo "[ROLLOUT] CRITICAL: rollback to previous image digest ($PREV_IMAGE_ID) failed or did not become ready!" >&2
  fi
else
  echo "[ROLLOUT] No previous running image recorded; stopping failed container." >&2
  docker compose "${COMPOSE_ARGS[@]}" stop "$SERVICE" || true
fi
exit 1
