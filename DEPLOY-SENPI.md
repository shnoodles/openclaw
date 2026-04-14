# OpenClaw + GLM-5.1-FP8 (Vertex AI) — Senpi Autonomous Trading

Deploy OpenClaw on Railway using your dedicated GLM-5.1-FP8 endpoint on Google Vertex AI, with Senpi MCP tools for fully autonomous Hyperliquid trading.

## Architecture

```
┌─────────────┐     HTTPS/WSS      ┌───────────────────────┐
│   You /      │ ──────────────────▶│   Railway (OpenClaw)  │
│   Claude     │                    │                       │
└─────────────┘                    │  ┌─────────────────┐  │
                                   │  │ Gateway (Node)   │  │
                                   │  │ Port 8080        │  │
                                   │  └────────┬────────┘  │
                                   │           │           │
                           ┌───────┼───────────┼───────────┼────────┐
                           │       │           │           │        │
                           ▼       │           ▼           │        ▼
                    ┌──────────┐   │    ┌──────────┐      │  ┌──────────┐
                    │ Vertex AI│   │    │ Senpi MCP│      │  │ Token    │
                    │ GLM-5.1  │   │    │ Server   │      │  │ Refresh  │
                    │ FP8      │   │    │          │      │  │ Daemon   │
                    └──────────┘   │    └──────────┘      │  └──────────┘
                                   └───────────────────────┘
```

## Prerequisites

1. **Google Cloud account** with Vertex AI enabled
2. **GLM-5.1-FP8 deployed** as a dedicated endpoint in Model Garden
3. **Railway account** (free tier works, but Hobby recommended)
4. **Senpi account** with MCP API access

## Step 1: Set Up Vertex AI Credentials

### Create a Service Account

```bash
# Create service account
gcloud iam service-accounts create openclaw-vertex \
  --display-name="OpenClaw Vertex AI"

# Grant Vertex AI User role
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:openclaw-vertex@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

# Create and download key
gcloud iam service-accounts keys create sa-key.json \
  --iam-account=openclaw-vertex@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

### Base64 Encode the Key (for Railway)

```bash
cat sa-key.json | base64 -w0
# Copy this output — you'll paste it as GOOGLE_SA_KEY_BASE64 in Railway
```

### Find Your Endpoint ID

In the Google Cloud Console:
1. Go to **Vertex AI → Model Garden**
2. Find your deployed GLM-5.1-FP8 endpoint
3. Copy the **Endpoint ID** from the endpoint details page
4. Note the **Region** (e.g., `us-central1`)

## Step 2: Deploy on Railway

### Option A: Deploy from GitHub Fork

1. Go to [Railway](https://railway.com) and create a new project
2. Select **Deploy from GitHub repo**
3. Connect to `shnoodles/openclaw`
4. Railway will detect `railway.toml` and use `Dockerfile.railway`

### Option B: Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Init project in the repo
cd openclaw
railway init

# Link to your project
railway link
```

### Configure Environment Variables

In Railway dashboard → your service → **Variables**, set:

| Variable | Value | Required |
|----------|-------|----------|
| `OPENCLAW_GATEWAY_PORT` | `8080` | Yes |
| `OPENCLAW_GATEWAY_TOKEN` | (generate with `openssl rand -hex 32`) | Yes |
| `OPENCLAW_STATE_DIR` | `/data/.openclaw` | Yes |
| `OPENCLAW_WORKSPACE_DIR` | `/data/workspace` | Yes |
| `VERTEX_PROJECT_ID` | Your GCP project ID | Yes |
| `VERTEX_REGION` | `us-central1` (or your region) | Yes |
| `VERTEX_ENDPOINT_ID` | Your endpoint ID | Yes |
| `GOOGLE_SA_KEY_BASE64` | Base64-encoded service account key | Yes |
| `SENPI_MCP_URL` | `https://mcp.senpi.ai` | Yes |
| `SENPI_API_TOKEN` | Your Senpi API token | Yes |

### Add a Volume

1. Go to your service → **Settings**
2. Click **+ New Volume**
3. Mount path: `/data`
4. Size: 1 GB (minimum)

### Enable Networking

1. Service → **Settings → Networking**
2. Enable **Public Networking**
3. Port: `8080`
4. Note the generated domain (e.g., `openclaw-production-xxxx.up.railway.app`)

## Step 3: Connect and Use

### Via HTTP (Direct API)

```bash
# Set your gateway URL and token
GATEWAY_URL="https://your-railway-domain.up.railway.app"
GATEWAY_TOKEN="your-gateway-token"

# Send a message
curl -X POST "$GATEWAY_URL/openai/v1/chat/completions" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "vertex-glm/glm-5_1-fp8",
    "messages": [
      {"role": "user", "content": "Show me top traders on Hyperliquid"}
    ]
  }'
```

### Via WebSocket (Streaming)

```javascript
const ws = new WebSocket("wss://your-railway-domain.up.railway.app", {
  headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` }
});

ws.on("open", () => {
  ws.send(JSON.stringify({
    method: "call",
    params: {
      message: "Create a $100 strategy going long BTC at 5x leverage"
    }
  }));
});
```

### Via Control UI

Open `https://your-railway-domain.up.railway.app/openclaw` in your browser and enter your gateway token.

## Step 4: Verify MCP Tools

Once connected, test that Senpi tools are available:

```
/status
```

Then try a trading query:

```
Show me the top 5 traders on Hyperliquid by ROE
```

```
What's my current portfolio and account balance?
```

```
Create a custom strategy with $200 budget, go long ETH at 10x leverage with 50% SL and 100% TP
```

## Token Refresh

The entrypoint script automatically:
1. Decodes your `GOOGLE_SA_KEY_BASE64` into a service account key
2. Starts a background daemon that refreshes the OAuth2 token every 45 minutes
3. Writes the token to `/tmp/vertex-access-token`
4. OpenClaw reads the token via the `${VERTEX_ACCESS_TOKEN}` env reference

If you prefer manual token management, set `VERTEX_ACCESS_TOKEN` directly and skip `GOOGLE_SA_KEY_BASE64`. Note that manually-set tokens expire after 1 hour.

## Troubleshooting

### "Token fetch failed"
- Verify your service account key is correctly base64-encoded
- Check the service account has `roles/aiplatform.user`
- Ensure the Vertex AI API is enabled in your project

### "Model not found"
- Confirm `VERTEX_ENDPOINT_ID` matches your deployed endpoint
- Check the endpoint is in the correct `VERTEX_REGION`
- Verify the endpoint is in `DEPLOYED` state in Model Garden

### "MCP connection failed"
- Verify `SENPI_MCP_URL` and `SENPI_API_TOKEN` are correct
- Check Senpi MCP server status

### View logs
```bash
railway logs
```

## File Reference

| File | Purpose |
|------|---------|
| `Dockerfile.railway` | Multi-stage Docker build for Railway |
| `railway.toml` | Railway build configuration |
| `config/openclaw.json` | OpenClaw config with Vertex GLM + Senpi MCP |
| `scripts/vertex-token-refresh.mjs` | OAuth2 token refresh daemon |
| `scripts/entrypoint-railway.sh` | Container entrypoint with token bootstrap |
| `.env.railway.example` | Template for Railway environment variables |
