# CLAUDE.md

Read `AGENTS.md` for repository instructions.

## Boca Pro self-hosted deployment (fork notes)

This is the `better-futures-studio/Cap` fork, deployed for one company at
https://cap.boca.pro. Upstream is `CapSoftware/Cap` (remote `upstream`).

### Where things run

- Railway project `cap` (id `1e969601-2fb9-4ade-b85b-34c48406ea3f`), env `production`.
  Services: `Cap Web` (Next.js, port 3000), `capsoftware/cap-media-server:latest`
  (FFmpeg mux, port 3456), `MySQL`, `cron` (recovery endpoints every 5 min),
  `db-backup` (nightly 03:00 UTC mysqldump to R2).
- Video storage: Cloudflare R2 bucket `cap-boca` on the Boca Pro account
  (id `e4415d983441474fb88e8325ca67506a`). Signed URLs; bucket stays private.
  Backups land under `backups/mysql/`.
- Email: Postmark HTTP API (`POSTMARK_SERVER_TOKEN`). Railway Hobby blocks
  outbound SMTP, so `SMTP_URL` does not work there.
- AI: OpenAI via the Responses API (`AI_PROVIDER=openai`, `AI_MODEL`),
  transcription requires `ASSEMBLY_API_KEY`.
- Login: Google only. `CAP_DISABLE_EMAIL_LOGIN=true`,
  `CAP_ALLOWED_SIGNUP_DOMAINS=boca.pro`, `CAP_DEFAULT_ORG_ID` = the Boca Pro org,
  `CAP_DISABLE_ORG_CREATION=true`.

### Deploying

Push to `main`. Both app services build from GitHub via the Railway app.
Cap Web builds in ~3 minutes (pnpm store cached via a Railway cache mount id).
Do not add `pnpm-lock.yaml` or `bun.lock` back to `.gitignore`; `railway up`
honours it and the build breaks.

### Checking and operating (Railway CLI, logged in as pro@boca.pro)

```bash
railway service list                          # status of every service
railway logs -s "Cap Web" --deployment --lines 200
railway logs -s "capsoftware/cap-media-server:latest" --deployment --lines 200
railway variables -s "Cap Web" --json         # never paste secret values into chat
railway logs -s db-backup --deployment --lines 40
```

Recovery endpoints (also hit by the `cron` service):
`/api/cron/recover-failed-video-processing` and
`/api/cron/finalize-stale-desktop-segments`, bearer `CRON_SECRET`.

Database: `DATABASE_URL` on Cap Web is the public proxy URL; a local `mysql`
client at `/Users/Shared/DBngin/mysql/8.0.27/bin/mysql` works for read queries.
Tables of interest: `videos`, `video_uploads`, `video_processing_jobs`,
`organizations`, `organization_invites`.

Browser checks as the logged-in owner: `agent-browser` with the real Chrome
`Default` profile (see the agent-browser skill note for the macOS launch flags).

### Things that bit us

- Railway injects `PORT`; Cap Web is pinned to `PORT=3000` so the media
  server's internal webhook URL (`http://cap-web.railway.internal:3000`) matches.
- Railway private networking is IPv6: the web Dockerfile binds `HOSTNAME="::"`.
- Railway's builder rejects `# syntax=` lines and unprefixed cache mount ids.
- Share-page dialogs must be mounted up front; the upstream click-latched lazy
  mount never rendered.
- Desktop recordings keep thumbnails at `source.thumbnailKey` under
  `.recording/outputs/`, not at `screenshot/screen-capture.jpg`.
- Serverless sleeping is on for Cap Web and the media server. First request
  after idle can be slow or 502 once.
