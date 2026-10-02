# Deploy

The app is a Node server driving headless Chromium (whatsapp-web.js). The single
hard requirement is **CPU** — measured on the exact image:

| CPU / RAM        | Time to QR         | Peak RAM     |
|------------------|--------------------|--------------|
| 0.1 CPU / 512 MB | **never** (>312 s) | 282 / 512 MB |
| 0.5 CPU / 512 MB | 26 s               | 375 / 512 MB |
| 1.0 CPU / 512 MB | **10 s**           | 353 / 512 MB |

Memory is never the constraint. **Do not deploy on 0.1 CPU** — the QR may appear
by bursting, but pairing (auth + inject) needs sustained CPU and never completes.

---

## Recommended: Railway (free tier has 1 vCPU / 512 MB)

Railway's free ceiling matches the configuration measured at 10 s to QR.

1. https://railway.app → sign in with GitHub (`saiiii17`)
2. **New Project → Deploy from GitHub repo** → `surfboard-monitor`
3. Railway reads `railway.json` and builds the `Dockerfile`.
4. **Variables** → add:
   - `ANTHROPIC_API_KEY`
   - `GROQ_API_KEY`
   - `WWEBJS_PATH=/app/data/wwebjs_auth`   (so the login survives restarts)
5. **Settings → Volumes** → add a volume mounted at `/app/data`
   (without it the WhatsApp login is lost on every redeploy and the owner re-scans).
6. **Settings → Networking → Generate Domain** → that URL is the permanent link.

## Alternative: Render

`render.yaml` is included. **Free tier (0.1 CPU) will not pair** — use it only to
confirm the app boots. For a working deployment change `plan: free` to
`plan: starter` (0.5 CPU, ~$7/mo) and add a disk:

```yaml
    plan: starter
    disk:
      name: monitor-data
      mountPath: /app/data
      sizeGB: 1
```
plus env var `WWEBJS_PATH=/app/data/wwebjs_auth`.

Render `1c-2g` (~$25/mo) is the comfortable tier if it must run unattended.

## Local (free, but your Mac must stay awake)

```bash
npm run dashboard                       # http://localhost:4321
cloudflared tunnel --url http://localhost:4321   # public link
```

## Environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | C3 extraction + C5 summaries (Haiku) |
| `GROQ_API_KEY` | alternative extraction provider |
| `WWEBJS_PATH` | put the WhatsApp login on a persistent volume |
| `LAUNCH_TIMEOUT_MS` | browser launch / auth budget (default 240000) |
| `WA_DEBUG=1` | stream Chromium stdout/stderr for diagnosis |
| `WA_NO_SINGLE_PROCESS=1` | drop `--single-process` (A/B a Chromium issue) |
| `WA_PREWARM=0` | do not start Chromium at boot |

## Updating

`git push` → the platform redeploys automatically. Same URL. the owner just refreshes.
