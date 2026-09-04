<h1 align="center">Cap (meeting recorder fork)</h1>

<p align="center">
	Self-hosted screen recording and meeting notes, with Recall.ai meeting
	bots and team features added on top of upstream Cap.
</p>

This is `better-futures-studio/Cap`, a hard fork of
[`CapSoftware/Cap`](https://github.com/CapSoftware/Cap) (upstream, remote
`upstream` in this repo). Upstream Cap is an open source Loom alternative:
desktop apps for macOS and Windows that record screen, camera, and
microphone, a web dashboard for sharing and commenting on recordings,
transcription, and AI summaries. This fork keeps that base and adds meeting
recording: Recall.ai bots that join video calls, an in-call assistant,
Google Calendar scheduling, recap emails, and team-oriented defaults for
running the app for one organization — Google-only login, no self-serve
signup outside an allowed domain.

Any organization can deploy this fork. https://cap.boca.pro is an example
deployment by Boca Pro; its specifics live in `CLAUDE.md` as a worked
example, not as defaults baked into the app.

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

- **Recording lands in Cap.** The bot's recording is copied into object
  storage and runs through the same processing pipeline as a normal Cap
  upload.
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
  recording is shared with them directly (a `video_shares` row per person)
  instead of being made org-wide public. "Me + attendees" recap emails only
  go to attendees who are members of the organization.
- **Meeting visibility.** The Meetings page and the live meeting view only
  show meetings a user owns, attended, or was given access to. Org
  owners/admins still see every meeting.
- **Per-person sharing.** The share dialog lists the owner and everyone a
  recording is shared with, and lets the owner add org members or remove
  someone's access.
- **Recall media retention.** Bots are created with timed Recall retention
  (`RECALL_MEDIA_RETENTION_HOURS`, default 168 hours) and, once Cap has
  imported the recording and transcript, the Recall-stored media is deleted
  (`RECALL_DELETE_MEDIA_AFTER_IMPORT`, default on).
- **Meeting deletion.** A meeting's owner can delete it — the meeting row,
  its recording, transcript, and summary go away for everyone it was shared
  with, and any pending Recall bot is cancelled first.

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

Built and working, pending a one-time Recall dashboard setup (bot
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

## Deploy your own

This walks a new organization through standing up this fork from scratch.
It assumes familiarity with the upstream
[self-hosting guide](https://cap.so/docs/self-hosting) for parts that don't
touch meetings (general Cap AI provider, desktop app builds).

### Prerequisites

- A Recall.ai account with a workspace in one region.
- A Google Workspace, for Google login and for Recall Calendar V2.
- Object storage (S3-compatible — AWS S3, Cloudflare R2, MinIO, etc.).
- A MySQL database.
- An email provider (Resend, or SMTP such as Postmark's).
- An API key for at least one LLM provider (OpenAI, Anthropic, Groq, or an
  OpenAI-compatible endpoint) for AI summaries and the in-call assistant.
- Optionally, an AssemblyAI key — Cap's own transcription fallback, and (if
  you want it) an alternative live/post-meeting transcription provider.

### Hosting

Railway is the tested path — the current `Dockerfile`s and cron setup
assume it — but any Docker host works, since nothing here is Railway-specific
at the application level.

- **Services**: the web app (Next.js, listens on `PORT`, default 3000) and
  a media server (`capsoftware/cap-media-server`, mux/processing, port
  3456) as separate services, plus MySQL and object storage.
- **PORT pinning**: pin the web app's `PORT` to a fixed value so the media
  server's webhook callback URL to the web app matches. On Railway this
  matters because `PORT` is otherwise injected per-deploy.
- **IPv6 bind**: if your platform's private networking is IPv6-only (as
  Railway's is), bind the web server to `::` rather than `0.0.0.0` so
  internal service-to-service calls can reach it.
- **Migrations at boot**: database migrations run automatically at app
  startup (`apps/web/instrumentation.node.ts`), retrying with backoff —
  there's no separate migration step to run in the deploy.
- **Cron service loop**: run something that hits these endpoints on a
  schedule (every few minutes), authenticated with a bearer `CRON_SECRET`:
  - `/api/cron/recover-failed-video-processing`
  - `/api/cron/finalize-stale-desktop-segments`
  - `/api/cron/recall-reconcile`

### Configuration

All variables are read through `packages/env/server.ts`; this table covers
what a self-hoster running meeting features needs to look at, grouped by
concern. See that file (and the upstream self-hosting guide) for storage,
database, and general Cap AI provider variables not listed here.

**Login and organization**

| Variable | Required | Meaning |
| --- | --- | --- |
| `CAP_DISABLE_EMAIL_LOGIN` | optional | Set `true` to remove email/OTP login and force OAuth (e.g. Google). |
| `CAP_ALLOWED_SIGNUP_DOMAINS` | optional | Comma-separated list of email domains allowed to sign up. |
| `CAP_DEFAULT_ORG_ID` | optional | Single-tenant mode: new users join this organization instead of getting their own. |
| `CAP_DISABLE_ORG_CREATION` | optional | Set `true` to stop users creating additional organizations. |

**Recall.ai — bots, webhooks, live agent**

| Variable | Required | Meaning |
| --- | --- | --- |
| `RECALL_API_KEY` | required for meeting features | Recall.ai REST API key. |
| `RECALL_REGION` | required for meeting features | Recall region; the API base URL is `https://<region>.recall.ai`. |
| `RECALL_WEBHOOK_VERIFICATION_SECRET` | required for meeting features | Workspace webhook verification secret (`whsec_...`), used to verify inbound Recall webhooks. |
| `RECALL_BOT_NAME` | optional | Display name the meeting bot joins calls as. |
| `RECALL_BOT_IMAGE_URL` | optional | JPEG shown as the bot's camera while recording. Defaults to a card rendered from the organization's name and icon. |
| `RECALL_LIVE_AGENT` | optional | Enable live transcripts and the in-call chat agent. Off by default. |
| `RECALL_AGENT_TRIGGER` | optional | Chat command that invokes the live meeting agent. Defaults to `/nt`. |
| `RECALL_TRANSCRIPTION_PROVIDER` | optional | `recallai` (default) or `assemblyai`; see Features above. |
| `RECALL_MEDIA_RETENTION_HOURS` | optional | Hours Recall keeps bot media. Defaults to `168` (7 days). |
| `RECALL_DELETE_MEDIA_AFTER_IMPORT` | optional | After Cap imports the recording and transcript, delete Recall-stored media. Defaults to `true`. |

**Recall Calendar V2 (Google Calendar scheduling)**

| Variable | Required | Meaning |
| --- | --- | --- |
| `RECALL_CALENDAR_GOOGLE_CLIENT_ID` | required for calendar sync | Google OAuth web client id, dedicated to the Recall Calendar V2 flow. |
| `RECALL_CALENDAR_GOOGLE_CLIENT_SECRET` | required for calendar sync | Matching client secret. |
| `RECALL_CALENDAR_SETUP_CALLBACK_URI` | optional | Recall regional callback URL the hosted calendar setup forwarder redirects to. Derived from `RECALL_REGION` when unset. |

**Monitoring (optional)**

| Variable | Required | Meaning |
| --- | --- | --- |
| `SENTRY_DSN` | optional | Enables server and edge Sentry. Leave unset to keep monitoring off. |
| `NEXT_PUBLIC_SENTRY_DSN` | optional | Enables browser Sentry. Must be present at build time so the client bundle can include it. |
| `SENTRY_ENVIRONMENT` | optional | Sentry environment tag. Defaults to `production`. |
| `SENTRY_TRACES_SAMPLE_RATE` | optional | Trace sample rate from 0 to 1. Defaults to `0.1`. |
| `SENTRY_AUTH_TOKEN` | optional | Auth token for uploading source maps during `next build`. Upload is skipped when unset. |
| `SENTRY_ORG` | optional | Sentry org slug, used with the auth token for source map upload. |
| `SENTRY_PROJECT` | optional | Sentry project slug, used with the auth token for source map upload. |

Everything else meeting-related — Cap's own transcription fallback
(`ASSEMBLY_API_KEY`), general AI provider selection (`AI_PROVIDER`,
`AI_MODEL`, and related keys) — is documented in `packages/env/server.ts`
and the upstream self-hosting guide.

### Recall workspace setup

1. Create a Recall.ai account and workspace, then generate an API key —
   this becomes `RECALL_API_KEY`. Note the workspace's region — this
   becomes `RECALL_REGION`.
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
5. If using AssemblyAI as the transcription provider, configure the
   AssemblyAI key on the Recall dashboard's Transcription page first, then
   set `RECALL_TRANSCRIPTION_PROVIDER=assemblyai`.
6. If Recall has enabled Slack Huddles for your account, register the bot's
   subdomain with Recall so it can join Huddles under your workspace.

### Google Cloud setup

Use a dedicated Google OAuth **web** client for the Recall Calendar V2 flow
(separate from any OAuth client used for Cap login). Set its consent screen
audience to **Internal** if the Google Workspace is restricted to one
organization — this avoids Google's verification process, since only users
on that Workspace can ever authorize it. Request the Calendar scopes Recall's
hosted setup flow asks for during the OAuth consent screen.

### First run

1. Sign in as the first user (Google, or email if enabled).
2. Connect Google Calendar from the Meetings page and confirm events show
   up.
3. Send a test bot to a call by pasting a meeting URL, and confirm it joins
   and the recording lands in Cap afterward.
4. Send a test webhook event from the Recall dashboard and confirm your
   `/api/webhooks/recall` endpoint returns success.

### Using the desktop and mobile apps with your instance

The dashboard has a "Get the apps" page (linked from the user menu) with the
same instructions.

**Desktop (macOS/Windows)**: the public download at https://cap.so/download
works with a self-hosted instance — it isn't tied to cap.so. After
installing, open Settings → General, and in the Self-host section set the
Cap Server URL to your instance's URL. Confirming the change signs you out;
sign in again with Google.

**Mobile (iOS)**: not supported. The App Store build only talks to cap.so
and offers no way to change the server URL. If an organization needs it,
it can build its own app with EAS (set `EXPO_PUBLIC_CAP_WEB_URL` in the EAS
production environment, see `apps/mobile/README.md`) and distribute it
internally through TestFlight.

**Browser extension**: the extension's options page has a "Cap URL" field
under Connection — set it to your instance's URL and sign in with Google.

### Branding

The bot's display name comes from `RECALL_BOT_NAME`. Its camera card — the
image shown in the call while it records — is rendered by default from the
organization's name and icon; override it with `RECALL_BOT_IMAGE_URL`, a
1280x720 JPEG under 1.3 MB.

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
meeting integration and the deployment configuration for running it as a
single-tenant app.

License terms are as upstream states them:

- Code in the `cap-camera*` and `scap-*` crate families is MIT licensed.
  See [licenses/LICENSE-MIT](https://github.com/CapSoftware/Cap/blob/main/licenses/LICENSE-MIT).
- Third-party components keep their original license.
- Everything else is AGPLv3, as defined in [LICENSE](https://github.com/CapSoftware/Cap/blob/main/LICENSE).
