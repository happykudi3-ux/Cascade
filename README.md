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
- `api/agent.js` — the Vercel serverless function running the agent loop
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
