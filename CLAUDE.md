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
- Serverless sleeping is on for Cap Web and the media server; the first
  request after idle wakes the container.

### Recall.ai meeting bots

Meeting recording is done by Recall.ai bots (workspace "Boca Pro",
`a000034f-036a-4251-bc0c-4d502d358851`, region us-west-2, API v1.11).
Everything lives under `apps/web/lib/recall/`, `apps/web/workflows/recall-*.ts`,
`/api/webhooks/recall`, `/api/integrations/recall-calendar/*`,
`/api/cron/recall-reconcile`, and the `/dashboard/meetings` page. Tables:
`meeting_bots`, `meeting_calendars`, `slack_huddle_teams`, `recall_webhook_events`.

- Two ways in: paste a meeting URL on the Meetings page, or connect Google
  Calendar (Recall Calendar V2) and opt in per event or via the per-calendar
  auto-record switch. Nothing records until the user opts in.
- Flow: `recording.done` webhook → copy `video_mixed` MP4 into R2 as
  `raw-upload.mp4` → normal media-server processing → Recall async
  transcription (`recallai_async`) written to `transcription.vtt` with speaker
  names → AI summary. If Recall transcription fails, the video falls back to
  Cap's AssemblyAI pipeline (`videos.transcriptionStatus` is reset to NULL).
- Env on Cap Web: `RECALL_API_KEY`, `RECALL_REGION`,
  `RECALL_WEBHOOK_VERIFICATION_SECRET`, `RECALL_BOT_NAME`,
  `RECALL_CALENDAR_GOOGLE_CLIENT_ID/SECRET` (dedicated Google OAuth web client
  "Recall.ai Boca Pro Calendar App" in GCP project `cap-boca-pro`).
- Dashboard webhook endpoint: `https://cap.boca.pro/api/webhooks/recall`
  subscribed to `bot.*`, `recording.done|failed`, `transcript.done|failed`,
  `calendar.update`, `calendar.sync_events`,
  `slack_team.invited|active|access_revoked`. Verified with the workspace
  verification secret; duplicate `webhook-id`s are ignored.
- In-call agent (off by default): set `RECALL_LIVE_AGENT=true` to create bots
  with real-time transcription streamed to `/api/webhooks/recall/realtime/`
  (same verification secret). Chat messages starting with
  `RECALL_AGENT_TRIGGER` (default `@notetaker`) or naming the bot are answered
  in the meeting chat via Cap's AI provider; "note:" / "action item:" messages
  become timeline comments after the call. Live view:
  `/dashboard/meetings/<id>`. Zoom, Meet, Teams only (no chat on Webex/Slack).
- Recall MCP server (`recall-ai`, https://us-west-2.recall.ai/mcp) is
  registered at user scope; use it for bot logs and webhook deliveries.
- Add `recall-reconcile` to the `cron` service loop in Railway when changing
  its start command.
- Slack Huddles:
  - Add the bot subdomain in the Recall dashboard under the Slack bot setup.
  - Add the generated MX/TXT records.
  - Invite the bot email to the Slack workspace as a full member.
  - Wait ~15 min for the bot to come online; it then auto-joins public huddles
    (and can be invited to private ones). `slack_team.invited` activates the
    team so the bot joins as `RECALL_BOT_NAME` instead of "None".
