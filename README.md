# Cascade — Recruiting Pipeline Agent

Reads a job description and a set of resumes, then autonomously scores each
candidate, decides who advances, and drafts the outcome email — without you
telling it each step. This is the first app in the agent portfolio (as
opposed to the earlier six single-shot tools like Attrition Risk Flagger or
Prism).

## What makes this an agent, not a chatbot
Look at `api/agent.js`. There's a loop: the model is given a set of tools
(`score_candidate`, `decide_stage`, `rank_candidates`, `draft_response`,
`save_summary`), and on each turn it decides which one to call next. We run
the real JS function server-side, hand the result back to the model, and let
it decide the next move — up to 14 steps, until it calls `save_summary` and
stops. The `trace` array returned to the frontend is that decision log,
which the UI shows as "Show agent trace".

Compare this to the six earlier apps' `api/generate.js`: one prompt in, one
completion out, done. That's the dividing line between "AI-powered tool"
and "agent" — not a marketing label.

## Why scoring is deterministic JS, not another LLM call
Same reasoning as Seal's policy logic in the earlier portfolio: asking an
LLM to output a consistent 0-100 score is unreliable — ask twice, get two
numbers. Instead the model's job is the part it's actually good at
(reading the job description, extracting requirements, deciding stage
thresholds, writing the emails), and the counting is offloaded to plain
JS (`scoreCandidate` in `api/agent.js`) so the same inputs always produce
the same score.

## Files
- `index.html` / `style.css` / `app.js` — plain frontend, no framework
- `api/agent.js` — manual entry point (paste JD + resumes, run once)
- `api/scan-folder.js` — automated Drive-folder entry point (see below)
- `api/recent-runs.js` — feeds the automated-run history in the UI
- `lib/agentCore.js` — the shared agent loop both entry points call
- `lib/drive.js` — Google Drive API helpers
- `lib/rateLimit.js` — shared rate-limit helper
- `libs/xlsx.full.min.js` — self-hosted (not loaded from a CDN, so it can't
  break if a CDN changes or deprecates a version)

## Deploy on Vercel
1. Push this folder to a GitHub repo.
2. Import it in Vercel (no framework preset needed — it's static + one
   serverless function).
3. Settings → Environment Variables → add `GROQ_API_KEY` (same key as your
   other apps, or a new one).
4. Deploy.

## If it stops working later
- **"model does not exist" error**: Groq retired `openai/gpt-oss-120b`.
  Check https://console.groq.com/docs/deprecations and update the `MODEL`
  constant at the top of `api/agent.js`.
- **Agent seems to loop/stall**: `MAX_STEPS` in `api/agent.js` caps it at
  14 tool calls total. If you're testing with more than ~6 candidates you
  may need to raise this.
- **Rate limit hit during testing**: the in-memory limiter (10 runs/IP/hour)
  resets on cold start. This is fine for a demo; if this gets real traffic,
  move it to Upstash Redis or Vercel KV — same upgrade path already flagged
  for Hazel's rate limiter.

## Automated intake (Google Drive) — v1.1

Cascade can now watch a Google Drive folder and process new resumes on its
own, with no copy-pasting. This section covers what changed and how to set
it up.

### What's new
- `lib/agentCore.js` — the agent loop, pulled out of `api/agent.js` so both
  the manual flow and the automated flow share one implementation.
- `lib/drive.js` — Drive API helpers (auth, list, download, extract text,
  move files, read/write the run log).
- `api/scan-folder.js` — the automated endpoint. Scans `Inbox/`, runs the
  agent, sorts resumes into `Advanced/` / `Flagged/` / `Rejected/`.
- `api/recent-runs.js` — feeds the "Recent automated runs" list in the UI.
- New dependencies: `googleapis`, `pdf-parse`, `mammoth` — added to
  `package.json`, Vercel installs them automatically on deploy.

### Why a Service Account instead of "Sign in with Google"
A user OAuth flow (the "Sign in with Google" button you're used to) is
built for multi-user apps and needs a consent screen, refresh token
storage, and token refresh logic. Cascade only ever reads *your* Drive
folder, so a Service Account is simpler: it's a robot account with its own
email address, and you grant it access the exact same way you'd share a
folder with a colleague — no login flow, no expiring tokens.

### One-time setup
1. **Google Cloud Console** (console.cloud.google.com) → create a project
   (or reuse one) → **APIs & Services → Library** → enable the
   **Google Drive API**.
2. **APIs & Services → Credentials → Create Credentials → Service Account**.
   Give it any name (e.g. "cascade-agent"). No roles needed — Drive access
   comes from folder sharing, not IAM roles.
3. Open the new service account → **Keys → Add Key → Create new key → JSON**.
   This downloads a `.json` file — keep it private, it's a credential.
4. In Google Drive, create a folder for this job requisition, e.g.
   `Cascade — Senior Backend Engineer`. Inside it, create:
   - `Inbox/` (empty — this is where you drop new resumes)
   - a file named **`job_description.txt`** with the JD text (a Google Doc
     named exactly `job_description` also works)
   - `Advanced/`, `Flagged/`, `Rejected/` — optional, Cascade creates these
     automatically on first run if they're missing
5. **Share that top-level folder** with the service account's email — it's
   the `client_email` field in the JSON key, looks like
   `cascade-agent@your-project.iam.gserviceaccount.com`. Give it **Editor**
   access (it needs to move files between subfolders).
6. Copy the folder's ID from its URL:
   `https://drive.google.com/drive/folders/`**`THIS_PART`**.
7. In Vercel → Settings → Environment Variables, add:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL` — the `client_email` from the JSON key
   - `GOOGLE_PRIVATE_KEY` — the `private_key` field from the JSON key,
     pasted as-is (it contains literal `\n` sequences — the code un-escapes
     them, so don't try to convert them to real line breaks yourself)
   - `DRIVE_FOLDER_ID` — the folder ID from step 6
   - `CRON_SECRET` — optional but recommended: a random 16+ character
     string. If you set this, the "Scan now" button needs the same value
     typed into the "Admin key" field to work.
8. Redeploy.

### Triggering scans: the Hobby-plan catch
Vercel's built-in Cron Jobs are capped at **once per day** on the Hobby
plan (any more frequent schedule fails at deploy time) — this project's
`vercel.json` is set to `0 3 * * *` (3am UTC) so it deploys cleanly on
Hobby. That's fine for a daily sweep, but not "checks every 15 minutes."

Two ways to get more frequent checks without upgrading to Pro ($20/mo):
- **Use the "Scan now" button** whenever you've just dropped resumes in —
  fully manual, but instant and free.
- **Point a free external scheduler at `/api/scan-folder`** (e.g.
  cron-job.org, or similar services) set to hit it every 15–30 minutes,
  with header `Authorization: Bearer <your CRON_SECRET>`. Vercel's
  frequency cap only applies to *its own* scheduler — your API route is a
  normal HTTP endpoint and will respond to any caller on any schedule.

If you later upgrade to Vercel Pro, just tighten the schedule in
`vercel.json` (e.g. `*/15 * * * *`) and redeploy — no code changes needed.

### Things that can go wrong
- **"GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY not set"** — check
  both env vars are set and the private key wasn't accidentally trimmed.
- **403 from Drive** — the folder isn't shared with the service account
  email, or it was shared as Viewer instead of Editor.
- **"No job_description.txt found"** — the file must be named exactly
  `job_description.txt` (or `.docx`, or a Google Doc titled exactly
  `job_description`) and live in the folder root, not inside `Inbox/`.
- **Resumes not moving out of Inbox** — check the Vercel function logs for
  the run; a Drive API error there (usually a permissions issue) will
  leave files in place rather than silently losing them.

## Portfolio conventions carried into this app (reuse these for the next 5 agents)
- **Design tokens**: all colors/fonts are CSS custom properties at the top
  of `style.css` (`--bg`, `--panel`, `--accent`, `--mono`, `--sans`, etc.).
  Copy this block into the next agent and just change `--accent` to keep
  each app visually distinct while feeling like one family.
- **Trace pattern**: any future agent should return a `trace` array from
  its serverless function in the same `{step, tool, args, result}` shape,
  so the "Show agent trace" UI piece can be copied over as-is.
- **Rate limiting**: copy the `hits` Map + `rateLimited()` block from
  `api/agent.js` into each new agent's serverless function.
- **Self-hosted libs**: keep pulling `xlsx`/`docx` bundles into a local
  `libs/` folder per app rather than a CDN `<script>` tag.
