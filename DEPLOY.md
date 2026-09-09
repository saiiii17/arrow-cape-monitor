# Deploy — permanent link (Render)

The app runs in Render's cloud, so the link is permanent and unaffected by your
Mac sleeping or being off.

## One-time deploy (free)

1. Go to **https://render.com** → sign up (use the GitHub account `saiiii17`).
2. **New → Blueprint**.
3. Connect the repo **arrow-cape-monitor** → Render reads `render.yaml`.
4. It creates a Docker web service named **arrow-cape-monitor**.
5. Under **Environment**, set the two secrets (they are not in the repo):
   - `ANTHROPIC_API_KEY` — your Anthropic key
   - `GROQ_API_KEY` — your Groq key
6. **Apply / Deploy.** First build takes ~5–8 min (it installs Chromium).
7. You get a permanent URL: **https://arrow-cape-monitor.onrender.com**
   (exact name may vary if taken — Render shows it).

Send that URL to the owner. He opens it → WhatsApp tab → scans → types his C5/C3
group names → Save groups & pull history → Live.

## Free vs paid

`render.yaml` is set to **free**:
- URL is permanent and cloud-hosted (Mac irrelevant).
- Sleeps after ~15 min idle; next visit cold-starts in ~1 min.
- No persistent disk on free, so a cold start resets the WhatsApp login —
  the owner re-scans when he returns. Fine for occasional testing.
- 512 MB RAM: pulling very large history (tens of thousands of messages) may be
  tight. Normal use is fine.

## Production (paid, always-on) — you said you don't mind paying

In `render.yaml`, change `plan: free` to `plan: starter` (~$7/mo) and add a disk
so the WhatsApp session and data survive restarts:

```yaml
    plan: starter
    disk:
      name: monitor-data
      mountPath: /app/data
      sizeGB: 1
```

Then set the env var `WWEBJS_PATH=/app/data/wwebjs_auth` (already wired) so the
WhatsApp login lives on that disk and survives deploys — no re-scan. Commit, push, Render auto-redeploys. Result: always-on, no
re-scan, permanent professional URL.

## Updating the app later

Any code fix: `git commit` + `git push` → Render auto-redeploys in a few minutes.
Same URL. the owner just refreshes.
