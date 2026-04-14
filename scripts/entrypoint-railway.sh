#!/bin/bash
# Do NOT use set -e — we want the gateway to start even if optional setup fails

echo "[entrypoint] Starting OpenClaw with Vertex AI GLM-5.1-FP8"

# --- Vertex AI Token Refresh ---
if [ -n "$GOOGLE_SA_KEY_BASE64" ]; then
  echo "[entrypoint] Decoding service account key..."
  mkdir -p /tmp/gcloud
  if echo "$GOOGLE_SA_KEY_BASE64" | base64 -d > /tmp/gcloud/sa-key.json 2>/dev/null && [ -s /tmp/gcloud/sa-key.json ]; then
    if node -e "JSON.parse(require('fs').readFileSync('/tmp/gcloud/sa-key.json','utf8'))" 2>/dev/null; then
      export GOOGLE_APPLICATION_CREDENTIALS="/tmp/gcloud/sa-key.json"
      echo "[entrypoint] Service account key decoded successfully"
    else
      echo "[entrypoint] WARNING: Decoded key is not valid JSON. Trying as raw JSON..."
      echo "$GOOGLE_SA_KEY_BASE64" > /tmp/gcloud/sa-key.json
      if node -e "JSON.parse(require('fs').readFileSync('/tmp/gcloud/sa-key.json','utf8'))" 2>/dev/null; then
        export GOOGLE_APPLICATION_CREDENTIALS="/tmp/gcloud/sa-key.json"
        echo "[entrypoint] Raw JSON key accepted"
      else
        echo "[entrypoint] WARNING: GOOGLE_SA_KEY_BASE64 is neither valid base64 nor valid JSON. Skipping."
        rm -f /tmp/gcloud/sa-key.json
      fi
    fi
  else
    echo "[entrypoint] WARNING: base64 decode failed. Trying as raw JSON..."
    echo "$GOOGLE_SA_KEY_BASE64" > /tmp/gcloud/sa-key.json
    if node -e "JSON.parse(require('fs').readFileSync('/tmp/gcloud/sa-key.json','utf8'))" 2>/dev/null; then
      export GOOGLE_APPLICATION_CREDENTIALS="/tmp/gcloud/sa-key.json"
      echo "[entrypoint] Raw JSON key accepted"
    else
      echo "[entrypoint] WARNING: GOOGLE_SA_KEY_BASE64 is invalid. Skipping Vertex AI auth."
      rm -f /tmp/gcloud/sa-key.json
    fi
  fi
fi

# Build the endpoint URL if components are provided
if [ -n "$VERTEX_PROJECT_ID" ] && [ -n "$VERTEX_ENDPOINT_ID" ]; then
  VERTEX_REGION="${VERTEX_REGION:-us-west1}"
  export VERTEX_ENDPOINT_URL="https://${VERTEX_REGION}-aiplatform.googleapis.com/v1beta1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_REGION}/endpoints/${VERTEX_ENDPOINT_ID}"
  echo "[entrypoint] Vertex endpoint: $VERTEX_ENDPOINT_URL"
fi

# Start the token refresh daemon in background (non-blocking)
if [ -n "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
  echo "[entrypoint] Starting token refresh daemon..."
  node /app/scripts/vertex-token-refresh.mjs &

  for i in 1 2 3 4 5; do
    if [ -f /tmp/vertex-access-token ]; then
      export VERTEX_ACCESS_TOKEN="$(cat /tmp/vertex-access-token)"
      echo "[entrypoint] Initial token acquired"
      break
    fi
    sleep 1
  done
elif [ -z "$VERTEX_ACCESS_TOKEN" ]; then
  echo "[entrypoint] WARNING: No Vertex AI credentials configured."
  echo "[entrypoint] Gateway will start in unconfigured mode."
fi

# --- OpenClaw Config ---
# Try /data first (Railway volume), fall back to /home/node/.openclaw, then /tmp/openclaw
STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  STATE_DIR="/home/node/.openclaw"
  if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
    STATE_DIR="/tmp/openclaw-state"
    mkdir -p "$STATE_DIR"
  fi
  export OPENCLAW_STATE_DIR="$STATE_DIR"
  echo "[entrypoint] /data not writable, using state dir: $STATE_DIR"
fi

WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$STATE_DIR/workspace}"
if ! mkdir -p "$WORKSPACE_DIR" 2>/dev/null; then
  WORKSPACE_DIR="/tmp/openclaw-workspace"
  mkdir -p "$WORKSPACE_DIR"
  export OPENCLAW_WORKSPACE_DIR="$WORKSPACE_DIR"
  echo "[entrypoint] Using workspace dir: $WORKSPACE_DIR"
fi

# Always copy our config (overwrite to pick up changes)
echo "[entrypoint] Installing openclaw.json config..."
cp /app/config/openclaw.json "$STATE_DIR/openclaw.json" 2>/dev/null || {
  echo "[entrypoint] WARNING: Could not copy config to $STATE_DIR"
}
export OPENCLAW_CONFIG_PATH="$STATE_DIR/openclaw.json"

echo "[entrypoint] Config: $OPENCLAW_CONFIG_PATH"
echo "[entrypoint] State: $STATE_DIR"
echo "[entrypoint] Workspace: $WORKSPACE_DIR"
echo "[entrypoint] Starting OpenClaw gateway on port ${OPENCLAW_GATEWAY_PORT:-8080}..."

exec node /app/openclaw.mjs gateway \
  --allow-unconfigured \
  --bind lan \
  --port "${OPENCLAW_GATEWAY_PORT:-8080}"
