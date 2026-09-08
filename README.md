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
JS (`scoreCandidate` in `lib/agentCore.js`) so the same inputs always
produce the same score.

## Keeping token usage down (v1.2)
Two related fixes went into `lib/agentCore.js` after hitting Groq's
free-tier rate limit (8,000 tokens/minute) with just two resumes:

1. **`cleanResumeText()`** — PDF/DOCX extraction often leaves resumes full
   of repeated blank lines and stray spacing that add nothing useful.
   Every resume gets whitespace-normalized and hard-capped at ~4,000
   characters (roughly 800-1,000 tokens — plenty for actual resume
   content) before it ever reaches the model.
2. **`score_candidate` no longer asks the model to retype the resume.**
   The original tool schema required the model to pass `resume_text` back
   as an argument every time it called `score_candidate` — meaning each
   resume got duplicated into the conversation, and because the message
   history grows every loop step, that duplicate got re-sent on every
   subsequent call too. Now the server looks the resume up itself by
   `candidate_name` (it already has it from the original request), so the
   model only needs to name the candidate and list requirements. This also
   makes the "Show agent trace" panel more readable — no giant resume
   dumps inside tool-call entries.

Together these cut per-run token usage substantially. If you're still
hitting rate limits with larger batches, either lower `MAX_RESUME_CHARS`
in `lib/agentCore.js`, process fewer candidates per run, or move to Groq's
paid Dev Tier for a higher tokens-per-minute ceiling.

## Processing large batches (v1.3) — why not "scan all 100 at once"
Each candidate needs several sequential round-trips to the model (score →
decide → draft email). At scale, one request processing 100 candidates
means 300+ sequential API calls before the function can respond — that's
several minutes, and Vercel kills serverless functions that run past a
time limit regardless of plan. A single mega-run would just get cut off
partway through with a partial, silently-incomplete result.

Instead, `MAX_PER_RUN` in `api/scan-folder.js` stays at 12 per invocation
on purpose, and the design leans on repetition instead of a bigger batch:
- Already-processed resumes move out of `Inbox` into their outcome folder,
  so nothing gets reprocessed or double-counted between runs.
- Whatever's left over (`deferred_to_next_run` in the response) just waits
  for the next scan — scheduled or manual — to pick it up.
- Clicking Scan now repeatedly (every ~10-15 seconds once one finishes)
  works through a large Inbox in a few passes. Nothing is lost between
  passes; it just takes a few clicks for a big backlog.

### Full report across all runs
Because results previously only lived in the response of a single scan,
there was no way to get one consolidated view after processing a big
Inbox over several runs. `api/scan-folder.js` now saves each run's full
per-candidate results (not just counts) into `cascade-log.json`, and a new
endpoint, `api/export-report.js`, flattens every run's results into one
list. The "Download full report (Excel)" button in the Automated intake
panel pulls this and builds one spreadsheet — Candidate name, Score,
Stage, Matched/Missing requirements, drafted email subject — with one row
per candidate across every run, so it doesn't matter whether it took 1
scan or 9 to get through everyone.

## Files
- `index.html` / `style.css` / `app.js` — admin dashboard, no framework
- `apply.html` — public candidate application page (no login required)
- `api/agent.js` — manual entry point (paste JD + resumes, run once)
- `api/scan-folder.js` — automated multi-role Drive-folder entry point
- `api/apply.js` — receives candidate applications from `apply.html`
- `api/open-roles.js` — lists currently-open roles for the apply form
- `api/export-report.js` — flattens every role's every run into one Excel-ready list
- `api/recent-runs.js` — feeds the automated-run history in the UI
- `lib/agentCore.js` — the shared agent loop both entry points call
- `lib/drive.js` — Google Drive API helpers, including locking
- `lib/allocate.js` — fair per-run budget split across open roles
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

## Automated intake (Google Drive) — v1.1, extended in v2.0

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
4. In Google Drive, create one **root folder** (e.g. `Cascade Hiring`).
   Inside it, create **one subfolder per open role** (e.g.
   `Senior Backend Engineer`, `Product Designer`). Inside each role
   subfolder:
   - a file named **`job_description.txt`** with that role's JD text (a
     Google Doc named exactly `job_description` also works) — this is what
     marks the role as "open"; a subfolder without one is ignored
   - `Inbox/` (empty — new resumes land here, whether dropped in manually
     or submitted through `apply.html`)
   - `Advanced/`, `Flagged/`, `Rejected/` — optional, Cascade creates these
     automatically on first run if they're missing
5. **Share only the root folder** with the service account's email — it's
   the `client_email` field in the JSON key, looks like
   `cascade-agent@your-project.iam.gserviceaccount.com`. Give it **Editor**
   access. Sharing the root is enough; access flows down to every role
   subfolder inside it automatically, so opening a new role later is just
   "create a subfolder," not "share it again."
6. Copy the **root folder's** ID from its URL:
   `https://drive.google.com/drive/folders/`**`THIS_PART`**.
7. In Vercel → Settings → Environment Variables, add:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL` — the `client_email` from the JSON key
   - `GOOGLE_PRIVATE_KEY` — the `private_key` field from the JSON key,
     pasted as-is (it contains literal `\n` sequences — the code un-escapes
     them, so don't try to convert them to real line breaks yourself)
   - `DRIVE_FOLDER_ID` — the **root** folder's ID from step 6 (not a role
     subfolder's ID)
   - `CRON_SECRET` — optional but recommended: a random 16+ character
     string. If you set this, the "Scan now" button needs the same value
     typed into the "Admin key" field to work.
8. Redeploy.

> **Upgrading from a single-role v1.x setup?** Your existing job folder
> (with `job_description.txt`, `Inbox/`, etc. directly inside it) becomes
> one role subfolder. Create a new empty root folder, move your existing
> job folder inside it as the first role subfolder, share the new root
> with the service account (the old direct share still works but is now
> redundant), and update `DRIVE_FOLDER_ID` in Vercel to the new root's ID.


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

## Multiple simultaneous openings (v2.0)
The folder layout above already supports this — every role subfolder
under the root is scanned independently, and a subfolder without a
`job_description.txt` is simply skipped (treat that as "not open yet").
Opening a new role later is just: create a new subfolder, add its JD,
done — no code changes, no re-sharing.

Each scan splits its per-run candidate budget (12) fairly across whichever
roles actually have resumes waiting (`lib/allocate.js`), so one role with
a huge backlog can't starve the others every run — see "Processing large
batches" above for why the budget is capped at all. The "Recent automated
runs" list and the downloadable report both show which role each entry
belongs to.

## Candidate self-service applications (v2.0)
`apply.html` is a public page (no login required) where candidates pick
an open role from a dropdown, enter their name and email, and upload
their resume — it lands directly in that role's `Inbox` via
`api/apply.js`, using the same service account, no Google sign-in
required from the candidate.

- **Share the link** — the admin dashboard's "Automated intake" panel
  shows the full URL (`your-app.vercel.app/apply.html`) with a copy
  button.
- **The dropdown is always live** — `api/open-roles.js` lists whichever
  role subfolders currently have a `job_description.txt`, so closing a
  role (rename or remove its JD file) removes it from the form
  automatically, no page edits needed.
- **Name/email are stored as Drive `appProperties`** on the uploaded file
  — small private metadata Drive attaches to the file — rather than
  parsed back out of a filename later. `scan-folder.js` prefers this over
  guessing from the filename, so candidate names display correctly even
  if the original file was named something like `resume_final_v2.pdf`.
- **8MB file size cap, PDF/DOCX only** — adjust `MAX_FILE_BYTES` /
  `ALLOWED_EXTENSIONS` in `api/apply.js` if you need different limits.

## Guaranteed single-scan processing (v2.0)
Every scan starts by creating a small lock file (`.cascade-lock`) in the
root folder and refuses to run if one already exists and is fresh (under
5 minutes old) — see `acquireLock`/`releaseLock` in `lib/drive.js`. This
is what makes "each resume gets scanned exactly once" a guarantee rather
than just the common case: even if a scheduled scan is still running when
you click "Scan now," the second one is turned away with a 409 rather
than racing the first for the same files. If a run ever crashes without
releasing the lock, it auto-expires after 5 minutes rather than jamming
scanning shut permanently.

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
