#!/bin/bash
set -e

echo "[entrypoint] Starting OpenClaw with Vertex AI GLM-5.1-FP8"

# --- Vertex AI Token Refresh ---
# If a service account key is provided (as base64 env var), decode it
if [ -n "$GOOGLE_SA_KEY_BASE64" ]; then
  echo "[entrypoint] Decoding service account key..."
  mkdir -p /tmp/gcloud
  echo "$GOOGLE_SA_KEY_BASE64" | base64 -d > /tmp/gcloud/sa-key.json
  export GOOGLE_APPLICATION_CREDENTIALS="/tmp/gcloud/sa-key.json"
fi

# Build the endpoint URL if components are provided
if [ -n "$VERTEX_PROJECT_ID" ] && [ -n "$VERTEX_ENDPOINT_ID" ]; then
  VERTEX_REGION="${VERTEX_REGION:-us-central1}"
  export VERTEX_ENDPOINT_URL="https://${VERTEX_REGION}-aiplatform.googleapis.com/v1beta1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_REGION}/endpoints/${VERTEX_ENDPOINT_ID}"
  echo "[entrypoint] Vertex endpoint: $VERTEX_ENDPOINT_URL"
fi

# Start the token refresh daemon in background
if [ -n "$GOOGLE_APPLICATION_CREDENTIALS" ] || [ -z "$VERTEX_ACCESS_TOKEN" ]; then
  echo "[entrypoint] Starting token refresh daemon..."
  node /app/scripts/vertex-token-refresh.mjs &
  TOKEN_REFRESH_PID=$!

  # Wait for first token
  for i in $(seq 1 30); do
    if [ -f /tmp/vertex-access-token ]; then
      export VERTEX_ACCESS_TOKEN="$(cat /tmp/vertex-access-token)"
      echo "[entrypoint] Initial token acquired"
      break
    fi
    sleep 1
  done

  if [ -z "$VERTEX_ACCESS_TOKEN" ]; then
    echo "[entrypoint] WARNING: Could not get initial token, continuing anyway..."
  fi
fi

# --- OpenClaw Config ---
# Copy config to state dir if it doesn't exist
STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
mkdir -p "$STATE_DIR"

if [ ! -f "$STATE_DIR/openclaw.json" ]; then
  echo "[entrypoint] Copying initial config..."
  cp /app/config/openclaw.json "$STATE_DIR/openclaw.json"
fi

# Ensure workspace dir exists
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
mkdir -p "$WORKSPACE_DIR"

# --- Token Refresh Loop (background) ---
# Periodically re-export the token from file (in case the daemon refreshed it)
(
  while true; do
    sleep 2700  # 45 minutes
    if [ -f /tmp/vertex-access-token ]; then
      NEW_TOKEN="$(cat /tmp/vertex-access-token)"
      if [ -n "$NEW_TOKEN" ]; then
        export VERTEX_ACCESS_TOKEN="$NEW_TOKEN"
      fi
    fi
  done
) &

echo "[entrypoint] Starting OpenClaw gateway..."
exec node /app/openclaw.mjs gateway \
  --allow-unconfigured \
  --bind lan \
  --port "${OPENCLAW_GATEWAY_PORT:-8080}"
