# GitOpsPilot — Phase 1 & 2

A self-hosted CI/CD pipeline engine: GitHub push → build → test → deploy, with
automatic health-based rollback when a deployment goes bad.

- **Phase 1:** webhook-triggered pipeline, every stage logged to Postgres.
- **Phase 2:** after a successful deploy, the app is health-checked on a
  schedule; if it fails one of three pluggable policies, GitOpsPilot
  automatically redeploys the last known-good image and records why.

---

## 1. Prerequisites

- Node.js 18+
- A Neon project (free tier is fine) — this is your Postgres database
- Docker Desktop running locally (the default `pipeline.config.json` uses
  `docker build` / `docker run` — see the note at the bottom if you'd rather
  test without Docker on a low-RAM machine)
- `ngrok` (only needed if you want a *real* GitHub webhook to reach your
  laptop — not needed for the curl-based local test below)

---

## 2. Install

```bash
cd gitopspilot
npm install
```

---

## 3. Set up the database

1. Create a free project at [neon.tech](https://neon.tech) if you haven't
   already (Neon's free tier gives you generous project limits, separate from
   Supabase's — this project doesn't need anything beyond the default branch
   and database Neon creates for you).
2. In the Neon Console, open your project's **SQL Editor** (left sidebar).
3. Paste the contents of `src/db/schema.sql` and run it. This creates
   `pipeline_runs`, `pipeline_stages`, and `deployments` in the default
   database.
4. Go to your project's **Dashboard** tab and copy the **Connection string**
   (make sure the toggle is set to show the *pooled* connection — it has
   `-pooler` in the hostname). You'll need it for `DATABASE_URL` in the next
   step. It already includes `?sslmode=require`, which this app expects.

---

## 4. Configure environment variables

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Neon pooled connection string from step 3 |
| `GITHUB_WEBHOOK_SECRET` | Make up any long random string — you'll reuse it in GitHub's webhook settings |
| `HEALTH_CHECK_URL` | Leave as `http://localhost:4000/health` for local testing |
| `ROLLBACK_POLICY` | `consecutive_failures` (default), `error_rate`, or `latency_spike` |

The other `HEALTH_CHECK_*` / `ROLLBACK_*` vars have sane defaults in
`.env.example` — tweak thresholds later once the happy path works.

---

## 5. Run the server

```bash
npm start
```

You should see:

```
GitOpsPilot backend listening on port 4000
```

Sanity check: `curl http://localhost:4000/health` → `{"ok":true,...}`

---

## 6. Test Phase 1 — simulate a GitHub push webhook (no ngrok needed)

GitHub signs every webhook payload with HMAC-SHA256 over the **raw** request
body, using the secret you configured. To simulate this locally:

```bash
PAYLOAD='{"ref":"refs/heads/main","pusher":{"name":"ayushi"},"sender":{"login":"ayushi"}}'
SECRET="change_this_to_a_long_random_string"   # must match GITHUB_WEBHOOK_SECRET in .env

SIGNATURE="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

curl -X POST http://localhost:4000/webhook/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: $SIGNATURE" \
  -d "$PAYLOAD"
```

Expected response: `202 {"message":"Push received, pipeline started",...}`

Watch the server logs — you'll see each stage (`install`, `test`, `build`,
`deploy`) run in order. Then check Neon:

```sql
select * from pipeline_runs order by started_at desc limit 1;
select * from pipeline_stages order by started_at desc limit 10;
```

You should see one `pipeline_runs` row and four `pipeline_stages` rows, each
with `status = 'success'` (assuming `npm test` and Docker succeed in your
project directory) and captured `output`.

> **No Docker / low RAM?** Swap the `build`/`deploy` commands in
> `pipeline.config.json` for something lightweight, e.g.:
> ```json
> { "name": "build", "command": "echo build step ok" },
> { "name": "deploy", "command": "echo sample-app:v1 deployed" }
> ```
> Just make sure the deploy command's last token still looks like
> `something:tag` — that's what GitOpsPilot parses out as the image tag for
> deployment tracking in Phase 2.

---

## 7. Test Phase 2 — health checks and auto-rollback

After the pipeline above finishes successfully, GitOpsPilot automatically:
1. Records the deployment as `live` in the `deployments` table.
2. Starts polling `HEALTH_CHECK_URL` every `HEALTH_CHECK_INTERVAL_SECONDS`.

**To trigger a rollback on purpose**, point `HEALTH_CHECK_URL` at something
that always fails. Quickest way — run a second, throwaway server that always
500s:

```bash
node -e "
require('http').createServer((req, res) => {
  res.writeHead(500); res.end('down');
}).listen(4999, () => console.log('fake broken app on :4999'));
"
```

Update `.env`:
```
HEALTH_CHECK_URL=http://localhost:4999
HEALTH_CHECK_INTERVAL_SECONDS=3
HEALTH_CHECK_FAILURE_THRESHOLD=3
ROLLBACK_POLICY=consecutive_failures
```

Restart `npm start`, re-run the webhook curl from step 6 to trigger a fresh
deploy, and watch the logs. After 3 consecutive failed checks (~9 seconds)
you'll see:

```
[health-check] Rollback trigger fired for deployment <id>: 3 consecutive checks failed — exceeds consecutive_failures threshold of 3
[rollback] Triggered for deployment <id>
[rollback] Reason: 3 consecutive checks failed — exceeds consecutive_failures threshold of 3
[rollback] Rolling back to last known-good image: sample-app:latest
[rollback] Successfully rolled back to sample-app:latest (new deployment <id>)
```

Confirm in Neon:

```sql
select id, image_tag, status, rollback_reason, deployed_at
from deployments
order by deployed_at desc
limit 5;
```

You should see the failed deployment marked `status = 'failed'` with a
`rollback_reason`, and a new row with `status = 'live'` for the restored
image tag.

> To try the other two policies, set `ROLLBACK_POLICY=error_rate` (fires when
> more than `ROLLBACK_ERROR_RATE_THRESHOLD`% of checks in the window fail) or
> `ROLLBACK_POLICY=latency_spike` (fires when average response time in the
> window exceeds `ROLLBACK_LATENCY_THRESHOLD_MS`). For a latency test, make
> your fake server `setTimeout` before responding instead of returning 500.

---

## 8. (Optional) Wire up a real GitHub webhook with ngrok

Only needed once you want an actual `git push` to trigger this, instead of
the curl simulation above.

```bash
ngrok http 4000
```

Copy the `https://xxxx.ngrok-free.app` URL it prints, then in your GitHub
repo:

1. **Settings → Webhooks → Add webhook**
2. Payload URL: `https://xxxx.ngrok-free.app/webhook/github`
3. Content type: `application/json`
4. Secret: same value as `GITHUB_WEBHOOK_SECRET` in your `.env`
5. Events: just the `push` event
6. Save, then push a commit — you'll see it land in your server logs and get
   the same `pipeline_runs` / `pipeline_stages` / `deployments` rows as the
   curl test.

---

## Project structure

```
gitopspilot/
├── pipeline.config.json        # stage name → shell command
├── .env.example
├── package.json
├── src/
│   ├── server.js                # Express app entrypoint
│   ├── config/db.js             # pg Pool (Neon)
│   ├── db/schema.sql            # run once in Neon's SQL editor
│   ├── middleware/verifyWebhook.js
│   ├── routes/webhook.js        # POST /webhook/github
│   └── services/
│       ├── pipelineRunner.js    # Phase 1: executes stages, logs to DB
│       ├── deploymentService.js # Phase 2: deployments table CRUD
│       ├── healthCheckService.js# Phase 2: polling + 3 rollback policies
│       └── rollbackService.js   # Phase 2: redeploy last known-good image
```

## What's next

Phase 3 (Resend email notifications), Phase 4 (stack auto-detection + env-var
pre-flight validation — the differentiator feature), Phase 5 (CLI), and
Phase 6 (React dashboard) build on top of this without changing anything
here — just ask when you're ready for the next one.
