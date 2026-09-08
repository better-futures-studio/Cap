# Standing up a new company instance on Railway

This is the repeatable path for running this fork for a company other than
Boca Pro. It uses Railway's IaC (`railway.ts`) to define the same services
Boca Pro runs, in that company's own Railway workspace. HeyJet.ai
(`clips.heyjet.ai`) is the second instance, following this path.

## 1. Railway workspace

Create a Railway workspace for the company, billed to them, not to Boca Pro.
There are two ways to operate that workspace's project from this machine:

- **Member invite**: get invited as a member of the workspace, then use the
  normal `railway login` flow. `railway link`, `railway whoami`, and
  `railway list` all work as usual.
- **Workspace token**: the company issues a workspace API token, exported as
  `RAILWAY_API_TOKEN`. With a workspace token, `railway link`, `whoami`, and
  `list` do not work (they need a user session). Instead, write the project
  link straight into `~/.railway/config.json`, under
  `projects["<absolute path to this deploy/railway dir>"]`, with `project`,
  `environment`, `environmentName`, `name`, and `projectPath` fields. If the
  project does not exist yet, create it first with the GraphQL
  `projectCreate` mutation against `https://backboard.railway.com/graphql/v2`,
  `Authorization: Bearer <token>` — this returns the project and environment
  ids to put in that config entry. HeyJet.ai's instance is operated this way,
  with a HeyJet workspace token.

## 2. GitHub connection

In the Railway dashboard, the Railway user (or workspace) must connect GitHub
under Account Settings → Integrations, then install the Railway GitHub app on
the `better-futures-studio` org with access to the `Cap` repo. Without this,
the services in `railway.ts` (which build from `github("better-futures-studio/Cap", ...)`)
cannot pull source.

Custom domains cannot be created from IaC — add them in the dashboard on the
Cap Web service after the first apply (see step 4).

## 3. Fill in the template and apply

Copy `.railway/railway.ts` from this directory unless it is already the one
you are using, and fill in every placeholder:

- `<openssl rand -hex 32>` (two of these, for `MEDIA_SERVER_WEBHOOK_SECRET`
  and `CRON_SECRET`) and `<openssl rand -hex 24>` / `<openssl rand -hex 16>`
  (`NEXTAUTH_SECRET`, `DATABASE_ENCRYPTION_KEY`) — generate each with
  `openssl rand -hex <N>`, do not reuse Boca Pro's.
- `<your-domain>` — the company's domain, used for `WEB_URL`,
  `NEXTAUTH_URL`, `CAP_ALLOWED_SIGNUP_DOMAINS`, and `RESEND_FROM_DOMAIN`.
- `<Company>` — the company name, used in `RECALL_BOT_NAME`.
- `<bucket>` — the R2 (or S3-compatible) bucket name for `CAP_AWS_BUCKET`.

Then:

```bash
cd deploy/railway
npm install
railway link          # or the ~/.railway/config.json entry from step 1
railway config plan   # review what will be created/changed
railway config apply --yes
```

## 4. After the first apply

- Add the custom domain to the Cap Web service in the dashboard, then add
  the matching DNS CNAME at the company's DNS host.
- Add these third-party variables on Cap Web (not in the template — they
  hold real credentials):

| Variable | Needed for |
| --- | --- |
| `CAP_AWS_ACCESS_KEY`, `CAP_AWS_SECRET_KEY`, `CAP_AWS_ENDPOINT`, `CAP_AWS_BUCKET_URL`, `S3_INTERNAL_ENDPOINT`, `S3_PUBLIC_ENDPOINT` | R2 bucket access. Create a private R2 bucket (`CAP_AWS_BUCKET` from step 3 must match) and an R2 API token scoped to it. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Login with Google. Create a Google OAuth web client with authorized redirect `https://<domain>/api/auth/callback/google`. |
| `OPENAI_API_KEY` | AI summaries, chapters, Ask, live agent replies. |
| `ASSEMBLY_API_KEY` | Cap's own transcription fallback. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini video understanding for silent screen recordings. |
| `POSTMARK_SERVER_TOKEN` | Outbound email (Railway blocks SMTP, so this has to be the Postmark HTTP API). |
| `RECALL_API_KEY`, `RECALL_WEBHOOK_VERIFICATION_SECRET` | Meeting bots. Create a Recall.ai workspace for the company, then a webhook endpoint at `https://<domain>/api/webhooks/recall` subscribed to the events listed in the root `CLAUDE.md` (`bot.*`, `recording.done`/`failed`, `transcript.done`/`failed`, `calendar.update`, `calendar.sync_events`, `slack_team.invited`/`active`/`access_revoked`); the webhook secret comes from that workspace. |
| `RECALL_CALENDAR_GOOGLE_CLIENT_ID`, `RECALL_CALENDAR_GOOGLE_CLIENT_SECRET` | Recall Calendar V2 (Google Calendar auto-record). A separate, dedicated Google OAuth web client from the login one above. |

If `RECALL_TRANSCRIPTION_PROVIDER` stays `assemblyai` (the template's
default), also add an AssemblyAI key on the Recall dashboard's
Transcription page for that workspace — Recall calls out to it, Cap Web
does not need the key directly for this path.

## 5. First login and org setup

The template ships with `CAP_DISABLE_ORG_CREATION: "true"`, which blocks
anyone from creating an organization — including the first user. Either:

- do the first login before setting that flag (drop it from `railway.ts`,
  apply, log in, then add it back and re-apply), or
- if it is already set, unset it, apply, log in, then set it again.

Sign in with a Google account on the allowed domain (`CAP_ALLOWED_SIGNUP_DOMAINS`).
That first sign-in creates the user and, since no `CAP_DEFAULT_ORG_ID` is
set yet, its own organization. Read that organization's id from the
`organizations` table (a MySQL client against the `MYSQL_URL`/`DATABASE_URL`
Railway gives you), set `CAP_DEFAULT_ORG_ID` to it on Cap Web, and redeploy.
From then on every new user in the allowed domain joins that one org.

In the dashboard, under Settings → Organization, set the org's summary
language and logo.

## 6. Backups

Boca Pro runs a `db-backup` service: an Alpine image on a cron schedule that
runs `mysqldump` nightly (03:00 UTC) into the R2 bucket under
`backups/mysql/`. It is not part of `railway.ts` in this directory — copy its
service definition from the Boca Pro project when a company needs backups,
pointing it at the new project's MySQL and bucket.

## 7. Verify

- `railway service list` — every service should be running (or asleep, for
  the ones with `sleepApplication: true`).
- Open the custom domain and confirm the app loads.
- Record a clip end to end.
- Join a test meeting with the notetaker bot and confirm it joins, records,
  and produces a transcript and summary.
