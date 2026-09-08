// Cascade — automated Google Drive intake. Triggered either by:
//  (a) Vercel Cron (sends an Authorization: Bearer <CRON_SECRET> header
//      automatically once CRON_SECRET is set as an env var), or
//  (b) an external scheduler / the "Scan now" button in the UI, which must
//      supply the same secret if one is configured.
//
// Folder layout expected inside DRIVE_FOLDER_ID:
//   job_description.txt (or .docx, or a Google Doc named "job_description")
//   Inbox/       <- drop new resumes here
//   Advanced/ Flagged/ Rejected/  <- Cascade creates these and files land here

const { runCascadeAgent } = require("../lib/agentCore");
const { createRateLimiter, getClientIp } = require("../lib/rateLimit");
const drive = require("../lib/drive");

const rateLimited = createRateLimiter(30); // generous: automated callers hit this a lot
const MAX_PER_RUN = 12; // matches agentCore's MAX_STEPS budget

function checkAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured: allow (document this tradeoff in README)
  return req.headers.authorization === `Bearer ${secret}`;
}

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Use GET or POST" });
    return;
  }

  if (!checkAuth(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const ip = getClientIp(req);
  if (rateLimited(ip)) {
    res.status(429).json({ error: "Rate limit reached. Try again shortly." });
    return;
  }

  const folderId = process.env.DRIVE_FOLDER_ID;
  const apiKey = process.env.GROQ_API_KEY;
  if (!folderId) return res.status(500).json({ error: "DRIVE_FOLDER_ID not set." });
  if (!apiKey) return res.status(500).json({ error: "GROQ_API_KEY not set." });

  try {
    const client = drive.getDriveClient();

    const [inboxId, advancedId, flaggedId, rejectedId] = await Promise.all([
      drive.ensureChildFolder(client, folderId, "Inbox"),
      drive.ensureChildFolder(client, folderId, "Advanced"),
      drive.ensureChildFolder(client, folderId, "Flagged"),
      drive.ensureChildFolder(client, folderId, "Rejected"),
    ]);

    const jobDescription = await drive.readJobDescription(client, folderId);
    if (!jobDescription) {
      res.status(400).json({
        error: "No job_description.txt (or .docx, or a Google Doc named 'job_description') found in the watched folder's root.",
      });
      return;
    }

    let files = await drive.listFiles(client, inboxId);
    if (files.length === 0) {
      res.status(200).json({ message: "No new resumes in Inbox.", processed: 0 });
      return;
    }

    const deferred = files.length > MAX_PER_RUN ? files.slice(MAX_PER_RUN) : [];
    files = files.slice(0, MAX_PER_RUN);

    const candidates = [];
    for (const file of files) {
      const text = await drive.extractText(client, file);
      candidates.push({
        name: file.name.replace(/\.(pdf|docx?|txt)$/i, ""),
        resume_text: text,
        _fileId: file.id,
      });
    }

    const { candidates: results, summary, trace } = await runCascadeAgent({
      job_description: jobDescription,
      candidates,
      apiKey,
    });

    const stageFolder = { advanced: advancedId, flagged: flaggedId, rejected: rejectedId };
    for (const result of results) {
      const original = candidates.find((c) => c.name === result.name);
      const destination = stageFolder[result.stage];
      if (original && destination) {
        await drive.moveFile(client, original._fileId, inboxId, destination);
      }
    }

    await drive.appendJsonLog(client, folderId, "cascade-log.json", {
      timestamp: new Date().toISOString(),
      processed: results.length,
      deferred: deferred.length,
      summary,
    });

    res.status(200).json({
      processed: results.length,
      deferred_to_next_run: deferred.length,
      candidates: results,
      summary,
      trace,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Scan failed." });
  }
};
