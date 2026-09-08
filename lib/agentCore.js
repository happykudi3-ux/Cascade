// Cascade's core agent loop — the tool definitions, the deterministic tool
// implementations, and the loop that lets the model decide what to call
// next. Both api/agent.js (manual paste-in flow) and api/scan-folder.js
// (automated Drive-folder flow) call runCascadeAgent() from here, so
// there's exactly one place this logic lives.

const MODEL = "openai/gpt-oss-120b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_STEPS = 14; // hard ceiling so a confused model can't loop forever
const MAX_RESUME_CHARS = 4000; // ~800-1000 tokens; a real resume's content fits easily

// ---------- token-usage control ----------
// PDF/DOCX extraction often produces resumes bloated with repeated blank
// lines, stray spacing, and table/layout artifacts. None of that helps
// scoring, and it all costs tokens on every single loop step (the full
// candidate list gets re-sent to the model each turn). Cleaning once here
// keeps every subsequent call smaller.
function cleanResumeText(text, maxChars = MAX_RESUME_CHARS) {
  if (!text) return "";
  let cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length > maxChars) {
    cleaned = cleaned.slice(0, maxChars) + "\n[...trimmed for length...]";
  }
  return cleaned;
}

// ---------- tool implementations ----------
// Scoring and stage decisions are deterministic on purpose (same reasoning
// as Seal's policy logic in the earlier portfolio): reliability matters
// more than letting the model free-associate a number.
//
// scoreCandidate looks the resume up server-side by candidate_name instead
// of accepting resume_text as a tool argument. Earlier versions required
// the model to re-type the entire resume into every score_candidate call —
// that's pure waste: it costs generation tokens, and then that full copy
// sits in the conversation and gets re-sent on every remaining loop step.
// Looking it up from what the server already has removes an entire
// duplicate copy of every resume from the growing context.

function scoreCandidate({ candidate_name, requirements }, resumeByName) {
  const text = (resumeByName[candidate_name] || "").toLowerCase();
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

const TOOLS = [
  {
    type: "function",
    function: {
      name: "score_candidate",
      description:
        "Score one candidate against a list of extracted job requirements. The server already has this candidate's resume on file — you only need to name the candidate and the requirements to check for, not the resume text itself. Returns a 0-100 match score plus matched/missing requirement lists. Call this once per candidate after you've read the job description and extracted its key requirements.",
      parameters: {
        type: "object",
        properties: {
          candidate_name: { type: "string" },
          requirements: {
            type: "array",
            items: { type: "string" },
            description: "Short skill/requirement phrases extracted from the job description, e.g. '5+ years React', 'SOC 2 experience'.",
          },
        },
        required: ["candidate_name", "requirements"],
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

/**
 * Runs the full agent loop for a batch of candidates against one job
 * description. Returns { candidates, summary, trace }.
 */
async function runCascadeAgent({ job_description, candidates, apiKey }) {
  // Clean once, up front — both what the model reads initially and what
  // scoreCandidate looks up later use this same cleaned copy.
  const cleanedCandidates = candidates.map((c) => ({
    ...c,
    resume_text: cleanResumeText(c.resume_text),
  }));
  const resumeByName = Object.fromEntries(
    cleanedCandidates.map((c) => [c.name, c.resume_text])
  );

  const toolImpl = {
    score_candidate: (args) => scoreCandidate(args, resumeByName),
    decide_stage: decideStage,
    rank_candidates: rankCandidates,
    draft_response: (args) => args,
    save_summary: (args) => args,
  };

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        job_description,
        candidates: cleanedCandidates.map((c) => ({
          candidate_name: c.name,
          resume_text: c.resume_text,
        })),
      }),
    },
  ];

  const trace = [];
  const candidateData = {};
  let rankedList = null;
  let summary = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const completion = await callGroq(messages, apiKey);
    const choice = completion.choices?.[0];
    const message = choice?.message;
    if (!message) throw new Error("No response from model.");

    messages.push(message);

    const toolCalls = message.tool_calls || [];
    if (toolCalls.length === 0) break;

    for (const call of toolCalls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        args = {};
      }

      const impl = toolImpl[name];
      const result = impl ? impl(args) : { error: `Unknown tool ${name}` };

      trace.push({ step: step + 1, tool: name, args, result });

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

    if (summary) break;
  }

  let candidatesOut = Object.values(candidateData);
  if (rankedList) {
    const rankByName = new Map(rankedList.map((r) => [r.candidate_name, r.rank]));
    candidatesOut = candidatesOut
      .map((c) => ({ ...c, rank: rankByName.get(c.name) || null }))
      .sort((a, b) => (a.rank || 99) - (b.rank || 99));
  } else {
    candidatesOut = candidatesOut.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  return { candidates: candidatesOut, summary, trace };
}

module.exports = { runCascadeAgent, MODEL, cleanResumeText };
