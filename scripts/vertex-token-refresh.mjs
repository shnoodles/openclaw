#!/usr/bin/env node

/**
 * Vertex AI OAuth2 Token Refresh Daemon
 *
 * Refreshes the Google Cloud access token every 45 minutes (tokens expire after 60 min).
 * Writes the token to a file and optionally updates an environment variable.
 *
 * Supports two auth modes:
 *   1. Service Account JSON key (GOOGLE_APPLICATION_CREDENTIALS env var)
 *   2. Workload Identity Federation (automatic in GKE/Cloud Run)
 *
 * Usage:
 *   node scripts/vertex-token-refresh.mjs
 *
 * Required env vars:
 *   GOOGLE_APPLICATION_CREDENTIALS  – Path to service account JSON key file
 *   VERTEX_PROJECT_ID               – Google Cloud project ID
 *   VERTEX_REGION                   – Endpoint region (e.g., us-central1)
 *   VERTEX_ENDPOINT_ID              – The dedicated endpoint ID
 *
 * Output:
 *   - Writes token to /tmp/vertex-access-token
 *   - Sets VERTEX_ACCESS_TOKEN in process env
 *   - Constructs and writes VERTEX_ENDPOINT_URL to /tmp/vertex-endpoint-url
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createSign } from "node:crypto";

const TOKEN_FILE = process.env.TOKEN_FILE || "/tmp/vertex-access-token";
const ENDPOINT_URL_FILE = "/tmp/vertex-endpoint-url";
const REFRESH_INTERVAL_MS = 45 * 60 * 1000; // 45 minutes
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function log(msg) {
  console.log(`[vertex-token-refresh] ${new Date().toISOString()} ${msg}`);
}

function buildEndpointUrl() {
  const projectId = process.env.VERTEX_PROJECT_ID;
  const region = process.env.VERTEX_REGION || "us-central1";
  const endpointId = process.env.VERTEX_ENDPOINT_ID;

  if (!projectId || !endpointId) {
    // If a full URL is already provided, use it directly
    if (process.env.VERTEX_ENDPOINT_URL) {
      log(`Using provided VERTEX_ENDPOINT_URL: ${process.env.VERTEX_ENDPOINT_URL}`);
      return process.env.VERTEX_ENDPOINT_URL;
    }
    throw new Error(
      "Missing VERTEX_PROJECT_ID or VERTEX_ENDPOINT_ID. " +
        "Either set both, or provide VERTEX_ENDPOINT_URL directly."
    );
  }

  // Vertex AI vLLM dedicated endpoint - OpenAI compatible format
  // Format: https://{REGION}-aiplatform.googleapis.com/v1beta1/projects/{PROJECT}/locations/{REGION}/endpoints/{ENDPOINT_ID}
  const baseUrl = `https://${region}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${region}/endpoints/${endpointId}`;
  log(`Constructed endpoint URL: ${baseUrl}`);
  return baseUrl;
}

function createJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  ).toString("base64url");

  const signInput = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signInput);
  const signature = sign.sign(serviceAccount.private_key, "base64url");

  return `${signInput}.${signature}`;
}

async function fetchAccessToken(serviceAccount) {
  const jwt = createJwt(serviceAccount);

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token fetch failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return data.access_token;
}

async function fetchMetadataToken() {
  // For GKE / Cloud Run / Compute Engine (Workload Identity)
  const resp = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!resp.ok) {
    throw new Error(`Metadata token fetch failed (${resp.status})`);
  }
  const data = await resp.json();
  return data.access_token;
}

async function refreshToken() {
  let token;
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (credPath && existsSync(credPath)) {
    log("Refreshing token via service account key...");
    const sa = JSON.parse(readFileSync(credPath, "utf-8"));
    token = await fetchAccessToken(sa);
  } else {
    log("Refreshing token via metadata server (Workload Identity)...");
    try {
      token = await fetchMetadataToken();
    } catch (err) {
      log(`Metadata server unavailable: ${err.message}`);
      log("Falling back to VERTEX_ACCESS_TOKEN env var...");
      token = process.env.VERTEX_ACCESS_TOKEN;
      if (!token) {
        throw new Error(
          "No auth method available. Set GOOGLE_APPLICATION_CREDENTIALS or VERTEX_ACCESS_TOKEN."
        );
      }
      return token;
    }
  }

  // Write token to file for OpenClaw to read
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  log(`Token written to ${TOKEN_FILE} (${token.substring(0, 20)}...)`);

  // Also write the endpoint URL
  const endpointUrl = buildEndpointUrl();
  writeFileSync(ENDPOINT_URL_FILE, endpointUrl, { mode: 0o644 });

  return token;
}

async function main() {
  log("Starting Vertex AI token refresh daemon");
  log(`Refresh interval: ${REFRESH_INTERVAL_MS / 1000 / 60} minutes`);

  // Build and log endpoint URL
  const endpointUrl = buildEndpointUrl();
  writeFileSync(ENDPOINT_URL_FILE, endpointUrl, { mode: 0o644 });

  // Initial token refresh
  try {
    await refreshToken();
    log("Initial token refresh successful");
  } catch (err) {
    log(`Initial token refresh failed: ${err.message}`);
    log("Will retry on next interval...");
  }

  // Schedule periodic refresh
  setInterval(async () => {
    try {
      await refreshToken();
    } catch (err) {
      log(`Token refresh failed: ${err.message}`);
    }
  }, REFRESH_INTERVAL_MS);
}

main().catch((err) => {
  console.error(`[vertex-token-refresh] Fatal: ${err.message}`);
  process.exit(1);
});
