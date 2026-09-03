# Architecture

This describes the Boca Pro fork's meeting recording layer on top of
upstream Cap, and how the pieces run in production at cap.boca.pro. For
general Cap concepts (Instant/Studio recording, the editor, sharing), see
upstream's docs at [cap.so/docs](https://cap.so/docs).

## Services

- **Cap Web** — the Next.js app (`apps/web`), on Railway, port 3000 (pinned;
  see `CLAUDE.md`). Serves the dashboard, API routes, webhooks, and the
  effect-based HTTP API.
- **Media server** — `capsoftware/cap-media-server`, port 3456. Muxes and
  processes uploaded video, including recordings copied in from Recall.
- **MySQL** — primary database, schema managed by Drizzle
  (`packages/database`).
- **cron** — hits the recovery and reconciliation endpoints
  (`/api/cron/recover-failed-video-processing`,
  `/api/cron/finalize-stale-desktop-segments`,
  `/api/cron/recall-reconcile`) every few minutes.
- **db-backup** — nightly mysqldump to R2.
- **Cloudflare R2** — video storage, private bucket, signed URLs.
- **Postmark** — transactional email (recap emails, invites), HTTP API only.
- **OpenAI** — AI summaries, action items, and in-call assistant answers
  (Responses API).
- **AssemblyAI** — Cap's own transcription fallback, and (optionally)
  Recall's transcription provider when `RECALL_TRANSCRIPTION_PROVIDER=assemblyai`.
- **Recall.ai** (`us-west-2`) — runs the meeting bots: joins calls, records,
  transcribes, streams live chat/transcript, and syncs calendars.

## Meeting data flow

```mermaid
sequenceDiagram
    participant User
    participant CapWeb as Cap Web
    participant Recall as Recall.ai
    participant R2 as R2 storage
    participant Media as Media server

    User->>CapWeb: Paste meeting URL / opt in via calendar
    CapWeb->>Recall: create bot (recall-meeting workflow)
    Recall->>CapWeb: bot.* webhooks (joining, in_call, done)
    Recall-->>CapWeb: live transcript + chat (if RECALL_LIVE_AGENT)
    Recall->>CapWeb: recording.done webhook
    CapWeb->>Recall: fetch video_mixed MP4
    CapWeb->>R2: store as raw-upload.mp4
    CapWeb->>Media: normal video processing pipeline
    Recall->>CapWeb: transcript.done webhook (VTT, speaker names)
    CapWeb->>CapWeb: AI summary + action items + speaker stats
    CapWeb->>User: recap email (per user preference)
```

Bot creation and calendar sync run through `workflow`-based durable
workflows so retries survive process restarts:

- `apps/web/workflows/recall-meeting.ts` — creates the bot, and after
  `recording.done`/`transcript.done`, imports the video into Cap, kicks off
  processing, computes speaker stats, imports chat/notes as timeline
  comments, and applies the recap/visibility rules.
- `apps/web/workflows/recall-calendar-sync.ts` — keeps `meeting_calendars`
  and per-series record/skip rules in sync with `calendar.sync_events`.

If Recall's own transcription fails (`transcript.failed`), the video's
`transcriptionStatus` is reset and it's queued through Cap's normal
AssemblyAI pipeline instead — the meeting isn't left untranscribed.

Every inbound webhook is verified (`apps/web/lib/recall/verify.ts`) and
deduplicated by `webhook-id` against `recall_webhook_events` before
`apps/web/lib/recall/webhooks.ts` dispatches it.

## Database tables

Added in `packages/database/schema.ts`, alongside upstream's `videos`,
`video_uploads`, `video_processing_jobs`, `organizations`:

| Table | Purpose |
| --- | --- |
| `meeting_bots` | One row per meeting: source, URL, schedule, Recall bot/recording/transcript ids, status, and the resulting `videoId`. |
| `meeting_calendars` | A user's connected Recall calendar (Google), with the auto-record switch. |
| `meeting_preferences` | Per-user recap mode (`off` / `self` / `attendees`). |
| `meeting_vocabulary` | Org-level custom transcription vocabulary terms. |
| `meeting_calendar_series_rules` | Per-recurring-series record/skip decisions. |
| `recall_webhook_events` | Dedup log of processed webhook deliveries, keyed by `webhook-id`. |
| `slack_huddle_teams` | Slack workspaces that have invited the Huddles bot, and its activation status. |

## Realtime endpoint

`/api/webhooks/recall/realtime` receives streamed transcript and chat
events for bots created with the live agent enabled, verified with the same
workspace secret as the main webhook. `apps/web/lib/recall/chat-agent.ts`
answers `/nt`-triggered chat messages using the live transcript as context,
optionally with OpenAI web search; `apps/web/lib/recall/live-transcript.ts`
persists the running transcript/chat that both the agent and the live
`/dashboard/meetings/<id>` view read from.

## Where things live

```
apps/web/lib/recall/            Recall API client, config, webhooks, transcript/vtt
                                 conversion, chat agent, recap email, visibility,
                                 speaker stats, vocabulary, calendar OAuth
apps/web/workflows/recall-*.ts  Durable workflows: bot lifecycle, calendar sync
apps/web/app/api/webhooks/recall/            Dashboard webhook + realtime endpoint
apps/web/app/api/integrations/recall-calendar/  Google Calendar V2 connect/callback
apps/web/app/api/cron/recall-reconcile/      Periodic reconciliation with Recall
apps/web/app/(org)/dashboard/meetings/       Meetings list + live/detail page
packages/database/schema.ts                  meeting_* and recall_* tables
packages/env/server.ts                       RECALL_* environment schema
```

## Deployment specifics

See the "Boca Pro self-hosted deployment" and "Recall.ai meeting bots"
sections of `CLAUDE.md` for the current production configuration: Railway
service ids, R2 bucket, the exact webhook event subscription, and the
Slack Huddles one-time setup steps. That file is the source of truth for
anything environment-specific; this document only covers what the code
does.
