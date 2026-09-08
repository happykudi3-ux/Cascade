// Cascade — Recruiting Pipeline Agent
// This is a real agent loop, not a single-shot completion: the model decides
// which tool to call next, we execute it server-side, feed the result back,
// and repeat until the model has nothing left to do. Compare this file to
// the other portfolio apps' api/generate.js (one call in, one call out) to
// see the difference.

const MODEL = "openai/gpt-oss-120b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_STEPS = 14; // hard ceiling so a confused model can't loop forever

// ---------- cost-protection: in-memory rate limit (10 req / IP / hour) ----------
// Same pattern as the other apps. NOTE for whoever maintains the portfolio:
// this resets on every cold start and won't hold up across multiple Vercel
// instances once traffic grows — move to Upstash Redis or Vercel KV then.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const record = hits.get(ip) || [];
  const recent = record.filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 10;
}

// ---------- tool implementations ----------
// These run as real JS, not another LLM call. Scoring and stage decisions
// are deterministic on purpose — same reasoning as Seal's policy logic:
// reliability and repeatability matter more than letting the model
// free-associate a number.

function scoreCandidate({ requirements, resume_text }) {
  const text = (resume_text || "").toLowerCase();
  const reqs = requirements || [];
  const matched = [];
  const missing = [];
  for (const req of reqs) {
    const needle = String(req).toLowerCase().trim();
    if (!needle) continue;
    if (text.includes(needle)) matched.push(req);
    else missing.push(req);
  }
  const total = matched.length + missing.length;
  const score = total === 0 ? 0 : Math.round((matched.length / total) * 100);
  return { score, matched, missing, total_requirements: total };
}

function decideStage({ score, advance_threshold = 75, review_threshold = 50 }) {
  let stage;
  if (score >= advance_threshold) stage = "advanced";
  else if (score >= review_threshold) stage = "flagged";
  else stage = "rejected";
  return { stage, score, advance_threshold, review_threshold };
}

function rankCandidates({ candidates }) {
  const ranked = [...(candidates || [])]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .map((c, i) => ({ ...c, rank: i + 1 }));
  return { ranked };
}

const TOOL_IMPL = {
  score_candidate: scoreCandidate,
  decide_stage: decideStage,
  rank_candidates: rankCandidates,
  // draft_response and flag_summary don't compute anything — they're how
  // the model hands back structured output instead of loose prose, so the
  // UI can render it without scraping free text.
  draft_response: (args) => args,
  save_summary: (args) => args,
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "score_candidate",
      description:
        "Score one candidate's resume against a list of extracted job requirements. Returns a 0-100 match score plus matched/missing requirement lists. Call this once per candidate after you've read the job description and extracted its key requirements.",
      parameters: {
        type: "object",
        properties: {
          candidate_name: { type: "string" },
          requirements: {
            type: "array",
            items: { type: "string" },
            description: "Short skill/requirement phrases extracted from the job description, e.g. '5+ years React', 'SOC 2 experience'.",
          },
          resume_text: { type: "string" },
        },
        required: ["candidate_name", "requirements", "resume_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "decide_stage",
      description:
        "Given a candidate's score, decide whether they advance, get flagged for human review, or are rejected. Always call this right after score_candidate for that candidate.",
      parameters: {
        type: "object",
        properties: {
          candidate_name: { type: "string" },
          score: { type: "number" },
          advance_threshold: { type: "number", description: "Default 75 unless the job description implies otherwise." },
          review_threshold: { type: "number", description: "Default 50 unless the job description implies otherwise." },
        },
        required: ["candidate_name", "score"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rank_candidates",
      description:
        "Once every candidate has a score, call this exactly once with the full list to produce a final ranked order.",
      parameters: {
        type: "object",
        properties: {
          candidates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                candidate_name: { type: "string" },
                score: { type: "number" },
              },
            },
          },
        },
        required: ["candidates"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_response",
      description:
        "Draft the candidate-facing email for one candidate's outcome. For 'advanced', invite them to the next interview stage. For 'flagged', write a short internal note for the recruiter, not a candidate email. For 'rejected', write a brief, respectful decline. Call once per candidate after decide_stage.",
      parameters: {
        type: "object",
        properties: {
          candidate_name: { type: "string" },
          stage: { type: "string", enum: ["advanced", "flagged", "rejected"] },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["candidate_name", "stage", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_summary",
      description:
        "Call this exactly once, last, after every candidate has been scored, staged, and drafted. Give a short recruiter-facing summary of the pipeline run.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          advanced_count: { type: "number" },
          flagged_count: { type: "number" },
          rejected_count: { type: "number" },
        },
        required: ["summary"],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are Cascade, an autonomous recruiting pipeline agent.

You are given a job description and a set of candidate resumes. Work through
this pipeline yourself, one tool call at a time:
1. Read the job description and mentally extract 5-10 concrete requirements.
2. For EACH candidate: call score_candidate, then decide_stage, then draft_response.
3. Once all candidates are processed, call rank_candidates with every candidate's score.
4. Finish by calling save_summary exactly once.

Do not ask the user anything — decide and proceed. Do not skip a candidate.
Do not call the same tool twice for the same candidate except as this
sequence requires. When you have called save_summary, stop; do not produce
any further text or tool calls.`;

async function callGroq(messages, apiKey) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error ${res.status}: ${errText}`);
  }
  return res.json();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ error: "Rate limit reached (10 runs/hour). Try again later." });
    return;
  }

  const { job_description, candidates } = req.body || {};
  if (!job_description || !Array.isArray(candidates) || candidates.length === 0) {
    res.status(400).json({ error: "Provide job_description and a non-empty candidates array." });
    return;
  }
  if (candidates.length > 12) {
    res.status(400).json({ error: "Cascade handles up to 12 candidates per run in this demo." });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server misconfigured: GROQ_API_KEY not set." });
    return;
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        job_description,
        candidates: candidates.map((c) => ({
          candidate_name: c.name,
          resume_text: c.resume_text,
        })),
      }),
    },
  ];

  // The trace is what makes the agent's reasoning visible in the UI —
  // every tool call and result, in order, like a console log of decisions.
  const trace = [];
  const candidateData = {}; // keyed by candidate_name, built up across steps
  let rankedList = null;
  let summary = null;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const completion = await callGroq(messages, apiKey);
      const choice = completion.choices?.[0];
      const message = choice?.message;
      if (!message) throw new Error("No response from model.");

      messages.push(message);

      const toolCalls = message.tool_calls || [];
      if (toolCalls.length === 0) {
        // Model produced plain text instead of a final tool call — treat as done.
        break;
      }

      for (const call of toolCalls) {
        const name = call.function?.name;
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || "{}");
        } catch {
          args = {};
        }

        const impl = TOOL_IMPL[name];
        const result = impl ? impl(args) : { error: `Unknown tool ${name}` };

        trace.push({ step: step + 1, tool: name, args, result });

        // fold results into per-candidate state for the frontend
        const key = args.candidate_name;
        if (key) {
          candidateData[key] = candidateData[key] || { name: key };
          if (name === "score_candidate") {
            Object.assign(candidateData[key], {
              score: result.score,
              matched: result.matched,
              missing: result.missing,
            });
          } else if (name === "decide_stage") {
            candidateData[key].stage = result.stage;
          } else if (name === "draft_response") {
            candidateData[key].email = { subject: args.subject, body: args.body };
          }
        }
        if (name === "rank_candidates") rankedList = result.ranked;
        if (name === "save_summary") summary = args;

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }

      if (summary) break; // agent signaled completion
    }

    // apply final rank order if we got one, else fall back to score sort
    let candidatesOut = Object.values(candidateData);
    if (rankedList) {
      const rankByName = new Map(rankedList.map((r) => [r.candidate_name, r.rank]));
      candidatesOut = candidatesOut
        .map((c) => ({ ...c, rank: rankByName.get(c.name) || null }))
        .sort((a, b) => (a.rank || 99) - (b.rank || 99));
    } else {
      candidatesOut = candidatesOut.sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    res.status(200).json({
      candidates: candidatesOut,
      summary,
      trace,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Agent run failed." });
  }
};
