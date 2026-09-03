<h1 align="center">Cap (Boca Pro fork)</h1>

<p align="center">
	Self-hosted screen recording and meeting notes for one company, running at
	<a href="https://cap.boca.pro">cap.boca.pro</a>.
</p>

This is `better-futures-studio/Cap`, a hard fork of
[`CapSoftware/Cap`](https://github.com/CapSoftware/Cap) (upstream, remote
`upstream` in this repo). Upstream Cap is an open source Loom alternative:
desktop apps for macOS and Windows that record screen, camera, and
microphone, a web dashboard for sharing and commenting on recordings,
transcription, and AI summaries. This fork keeps that base and adds meeting
recording: Recall.ai bots that join video calls, an in-call assistant,
Google Calendar scheduling, recap emails, and a few opinionated defaults for
running the whole thing as a single-tenant deployment — Google-only login,
one organization, no self-serve signup outside the company domain.

There is one deployment of this fork: https://cap.boca.pro, for Boca Pro.
It is not built for other companies to fork and reuse without changes; the
defaults below assume a single organization.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how a meeting goes
from a pasted link to a recap email.

## Features

### Meeting bots

- **Get a bot into a call.** Paste a meeting URL on the Meetings page, or
  connect Google Calendar (Recall Calendar V2) and opt a call in from the
  calendar view. A per-calendar auto-record switch, and per-series
  record/skip rules, cover recurring meetings. Nothing records until a user
  opts in — connecting a calendar does not record anything by itself.
- **One bot per meeting.** Each meeting maps to one `meeting_bots` row; the
  bot joins with a branded camera card showing as the recording indicator.

### After the call

- **Recording lands in Cap.** The bot's recording is copied into R2 and
  runs through the same processing pipeline as a normal Cap upload.
- **Transcription with speaker names.** Recall's own transcription (default
  provider) produces a VTT transcript with speaker labels. If Recall
  transcription fails, the video falls back to Cap's own AssemblyAI
  pipeline automatically.
- **AI summary and action items.** Cap's AI pipeline runs against the
  transcript and produces a summary plus a structured action item list.
- **Speaker analytics.** Per-speaker talk time and turn counts are computed
  from the transcript.
- **Chat and notes as timeline comments.** In-meeting chat messages, and
  any `/nt` notes or action items captured during the call, are imported as
  timeline comments on the recording after it processes.
- **Recap email.** Each user sets a recap preference — off, to themselves
  only, or to all attendees — and Cap emails a summary once the recording
  and transcript are ready.
- **Attendee-only visibility.** When a recap goes to attendees, the
  recording is shared with them through a private Space scoped to that
  meeting, instead of being made org-wide public.

### In-call assistant (off by default)

Set `RECALL_LIVE_AGENT=true` to enable it. While enabled, bots stream live
transcription to the app, and chat messages starting with `/nt` (or naming
the bot) are answered in the meeting chat by Cap's configured AI provider,
using the running transcript as context. General questions can use OpenAI
web search. "note:" and "action item:" messages are captured for the
post-meeting timeline instead of being answered. A live view of the
transcript and chat is available at `/dashboard/meetings/<id>` while the
meeting is in progress. Supported on Zoom, Google Meet, and Microsoft
Teams — Recall does not expose an in-call chat channel on Webex or Slack.

### Slack Huddles

Built and working, pending the one-time Recall dashboard setup (bot
subdomain, DNS records, workspace invite) described in
[`ARCHITECTURE.md`](ARCHITECTURE.md). Once a Slack workspace
invites the bot, `slack_team.invited` activates it and it auto-joins public
huddles under its configured name.

### Custom vocabulary and language

Org-level custom vocabulary terms (with optional spelling) improve
transcription accuracy for names and jargon. Setting
`RECALL_TRANSCRIPTION_PROVIDER=assemblyai` switches transcription to
AssemblyAI through Recall (instead of Recall's own engine) for both
post-meeting and live transcripts, and adds English/Arabic code-switching
support; it requires an AssemblyAI key configured on the Recall dashboard.

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full picture:
services, the meeting data flow from bot creation through webhooks and
workflows to the recap email, the database tables this fork adds, and where
the code lives in the tree.

## Setup for a new deployment

This section is for standing up another instance of this fork (a staging
environment, a fresh Railway project). It assumes familiarity with the
upstream [self-hosting guide](https://cap.so/docs/self-hosting) for the
parts unrelated to meetings (storage, general AI provider, database).

### Environment variables

**Recall.ai** (all read by `apps/web/lib/recall/config.ts`; see
`packages/env/server.ts` for the exact schema):

| Variable | Purpose |
| --- | --- |
| `RECALL_API_KEY` | Recall.ai REST API key. |
| `RECALL_REGION` | Recall region; the API base URL is `https://<region>.recall.ai`. This deployment uses `us-west-2`. |
| `RECALL_WEBHOOK_VERIFICATION_SECRET` | Workspace webhook verification secret (`whsec_...`). |
| `RECALL_BOT_NAME` | Display name the meeting bot joins calls as. |
| `RECALL_LIVE_AGENT` | Enable live transcripts and the in-call chat agent. Off by default. |
| `RECALL_AGENT_TRIGGER` | Chat command that invokes the live meeting agent. Defaults to `/nt`. |
| `RECALL_BOT_IMAGE_URL` | JPEG shown as the bot's camera while recording. Defaults to `<WEB_URL>/meeting-bot/recording.jpg`. |
| `RECALL_CALENDAR_GOOGLE_CLIENT_ID` | Google OAuth web client id for the Recall Calendar V2 flow. |
| `RECALL_CALENDAR_GOOGLE_CLIENT_SECRET` | Matching client secret. |
| `RECALL_CALENDAR_SETUP_CALLBACK_URI` | Recall regional callback URL the hosted calendar setup forwarder redirects to. Optional; derived from `RECALL_REGION` when unset. |
| `RECALL_TRANSCRIPTION_PROVIDER` | `recallai` (default) or `assemblyai`. See above. |

Everything else the app needs — storage, database, email, general AI
provider, AssemblyAI key for Cap's own transcription fallback, login
restrictions — is documented in `CLAUDE.md` and the upstream self-hosting
guide; this list only covers the Recall-specific variables.

### Recall workspace setup

1. Create a Recall.ai account and workspace, then generate an API key —
   this becomes `RECALL_API_KEY`. Note the workspace's region.
2. Get the workspace webhook verification secret from the Recall dashboard
   — this becomes `RECALL_WEBHOOK_VERIFICATION_SECRET`.
3. Add a dashboard webhook endpoint pointing at
   `https://<your-domain>/api/webhooks/recall`, subscribed to:
   - `bot.*`
   - `recording.done`, `recording.failed`
   - `transcript.done`, `transcript.failed`
   - `calendar.update`, `calendar.sync_events`
   - `slack_team.invited`, `slack_team.active`, `slack_team.access_revoked`
4. Set up Calendar V2 through Recall's hosted setup flow. This app exposes
   two routes involved in that flow:
   - `/api/integrations/recall-calendar/callback` — completes the app's own
     Google OAuth handshake.
   - `/api/integrations/recall-calendar/setup-callback` — forwards Recall's
     hosted-setup OAuth redirect on to the regional Recall endpoint.
   Both full URLs (`https://<your-domain>/api/integrations/recall-calendar/callback`
   and `https://<your-domain>/api/integrations/recall-calendar/setup-callback`)
   must be registered as authorized redirect URIs on the Google OAuth client.
5. To enable the in-call assistant, set `RECALL_LIVE_AGENT=true` and confirm
   `RECALL_AGENT_TRIGGER` if you want something other than `/nt`.
6. To use AssemblyAI instead of Recall's own transcription, configure the
   AssemblyAI key on the Recall dashboard's Transcription page first, then
   set `RECALL_TRANSCRIPTION_PROVIDER=assemblyai`.

### Google OAuth client

Use a dedicated Google OAuth **web** client for the Recall Calendar V2 flow
(separate from any OAuth client used for Cap login). Set its consent screen
audience to **Internal** if the Google Workspace is restricted to one
organization — this avoids Google's verification process, since only users
on that Workspace will ever authorize it.

### Railway notes

- Railway injects `PORT` at runtime; pin `PORT=3000` on Cap Web so the media
  server's internal webhook URL (`http://cap-web.railway.internal:3000`)
  keeps matching.
- Railway private networking is IPv6 — the web Dockerfile binds
  `HOSTNAME="::"`.
- Database migrations run automatically at boot
  (`apps/web/instrumentation.node.ts`), retrying with backoff; there is no
  separate migration step in the deploy.
- Add a `cron` service hitting `/api/cron/recover-failed-video-processing`,
  `/api/cron/finalize-stale-desktop-segments`, and `/api/cron/recall-reconcile`
  on a schedule (bearer `CRON_SECRET`).

### Running locally

From upstream, trimmed to what's relevant here:

```bash
pnpm install
pnpm env-setup
pnpm cap-setup
pnpm dev:web
```

Requires Node.js 20+, pnpm 10.5.2, and Docker for MySQL/MinIO. Set the
`RECALL_*` variables above to exercise the meeting features locally; without
them, Recall integration is simply disabled (`getRecallConfig()` returns
`null`) and the rest of Cap works as usual.

## Development notes

- Meeting-related unit tests live in `apps/web/__tests__/unit/recall-*.test.ts`
  (calendar OAuth, webhook verification and dispatch, the chat agent,
  recap email logic, visibility rules, speaker stats, vocabulary, Slack
  Huddles, and more).
- Before pushing, run:
  ```bash
  pnpm vitest run
  pnpm exec biome check .
  pnpm typecheck
  pnpm run build:web
  ```
  `build:web` matters even when the other checks pass: the workflow
  bundler used by `apps/web/workflows/*.ts` only fails at build time, not
  under vitest or tsc.

## Upstream and license

This fork tracks [`CapSoftware/Cap`](https://github.com/CapSoftware/Cap).
Screen recording, the desktop apps, the editor, sharing, comments,
transcription, and Cap AI are upstream's work; this fork adds the Recall.ai
meeting integration and the Boca Pro deployment configuration on top.

License terms are as upstream states them:

- Code in the `cap-camera*` and `scap-*` crate families is MIT licensed.
  See [licenses/LICENSE-MIT](https://github.com/CapSoftware/Cap/blob/main/licenses/LICENSE-MIT).
- Third-party components keep their original license.
- Everything else is AGPLv3, as defined in [LICENSE](https://github.com/CapSoftware/Cap/blob/main/LICENSE).
