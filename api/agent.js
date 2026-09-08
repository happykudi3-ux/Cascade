// Cascade — manual entry point. Paste a JD + resumes in the browser, this
// runs the shared agent loop from lib/agentCore.js once, synchronously.
// For the automated Google Drive version, see api/scan-folder.js.

const { runCascadeAgent } = require("../lib/agentCore");
const { createRateLimiter, getClientIp } = require("../lib/rateLimit");

const rateLimited = createRateLimiter(10); // 10 runs / IP / hour

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const ip = getClientIp(req);
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

  try {
    const result = await runCascadeAgent({ job_description, candidates, apiKey });
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || "Agent run failed." });
  }
};
