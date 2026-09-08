// Cascade — automated Google Drive intake, now supporting multiple
// simultaneous openings. Triggered either by:
//  (a) Vercel Cron (sends an Authorization: Bearer <CRON_SECRET> header
//      automatically once CRON_SECRET is set as an env var), or
//  (b) an external scheduler / the "Scan now" button in the UI, which must
//      supply the same secret if one is configured.
//
// Folder layout expected inside DRIVE_FOLDER_ID (the "root"):
//   📁 Senior Backend Engineer/
//      job_description.txt, Inbox/, Advanced/, Flagged/, Rejected/
//   📁 Product Designer/
//      job_description.txt, Inbox/, Advanced/, Flagged/, Rejected/
//   ... one subfolder per open role. A role folder with no job description
//   file is treated as closed/not-yet-ready and skipped.
//
// A single run-lock (.cascade-lock in the root) guarantees a resume is
// never scanned twice, even if two scans overlap (e.g. a slow scheduled
// run still going when someone clicks "Scan now").

const { runCascadeAgent } = require("../lib/agentCore");
const { createRateLimiter, getClientIp } = require("../lib/rateLimit");
const { allocateBudget } = require("../lib/allocate");
const drive = require("../lib/drive");

const rateLimited = createRateLimiter(30); // generous: automated callers hit this a lot
const TOTAL_BUDGET_PER_RUN = 12; // shared across ALL open roles this run, matches agentCore's MAX_STEPS budget

function checkAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured: allow (documented tradeoff in README)
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

  const rootId = process.env.DRIVE_FOLDER_ID;
  const apiKey = process.env.GROQ_API_KEY;
  if (!rootId) return res.status(500).json({ error: "DRIVE_FOLDER_ID not set." });
  if (!apiKey) return res.status(500).json({ error: "GROQ_API_KEY not set." });

  const client = drive.getDriveClient();

  const gotLock = await drive.acquireLock(client, rootId);
  if (!gotLock) {
    res.status(409).json({ error: "A scan is already in progress. Try again in a minute." });
    return;
  }

  try {
    const roleFolders = await drive.listSubfolders(client, rootId);

    // A role folder only counts as "open" once it has a job description.
    const openRoles = [];
    for (const folder of roleFolders) {
      const jobDescription = await drive.readJobDescription(client, folder.id);
      if (jobDescription) openRoles.push({ id: folder.id, name: folder.name, jobDescription });
    }

    if (openRoles.length === 0) {
      res.status(400).json({
        error: "No open role folders found. Each role needs its own subfolder under the root with a job_description.txt inside it.",
      });
      return;
    }

    // Figure out how many resumes are waiting per role, then split this
    // run's budget fairly across whichever roles actually have people waiting.
    const roleInbox = {};
    const queues = [];
    for (const role of openRoles) {
      const inboxId = await drive.ensureChildFolder(client, role.id, "Inbox");
      roleInbox[role.name] = inboxId;
      const files = await drive.listFiles(client, inboxId);
      queues.push({ role: role.name, waiting: files.length, files });
    }
    const allocation = allocateBudget(
      queues.map((q) => ({ role: q.role, waiting: q.waiting })),
      TOTAL_BUDGET_PER_RUN
    );

    const perRoleResults = [];

    for (const role of openRoles) {
      const take = allocation[role.name] || 0;
      const queue = queues.find((q) => q.role === role.name);
      const waiting = queue?.files || [];

      if (waiting.length === 0) {
        perRoleResults.push({ role: role.name, processed: 0, deferred: 0, message: "No new resumes." });
        continue;
      }
      if (take === 0) {
        perRoleResults.push({ role: role.name, processed: 0, deferred: waiting.length, message: "Deferred to next run (budget used by other roles)." });
        continue;
      }

      const [advancedId, flaggedId, rejectedId] = await Promise.all([
        drive.ensureChildFolder(client, role.id, "Advanced"),
        drive.ensureChildFolder(client, role.id, "Flagged"),
        drive.ensureChildFolder(client, role.id, "Rejected"),
      ]);
      const inboxId = roleInbox[role.name];

      const filesToProcess = waiting.slice(0, take);
      const deferred = waiting.length - filesToProcess.length;

      const candidates = [];
      for (const file of filesToProcess) {
        const text = await drive.extractText(client, file);
        candidates.push({
          name: file.appProperties?.candidate_name || file.name.replace(/\.(pdf|docx?|txt)$/i, ""),
          email: file.appProperties?.candidate_email || null,
          resume_text: text,
          _fileId: file.id,
        });
      }

      const { candidates: results, summary } = await runCascadeAgent({
        job_description: role.jobDescription,
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

      await drive.appendJsonLog(client, role.id, "cascade-log.json", {
        timestamp: new Date().toISOString(),
        processed: results.length,
        deferred,
        summary,
        candidates: results.map((r) => ({
          name: r.name,
          score: r.score,
          stage: r.stage,
          matched: r.matched,
          missing: r.missing,
          email_subject: r.email?.subject || "",
        })),
      });

      perRoleResults.push({ role: role.name, processed: results.length, deferred, summary });
    }

    res.status(200).json({ roles: perRoleResults });
  } catch (err) {
    res.status(500).json({ error: err.message || "Scan failed." });
  } finally {
    await drive.releaseLock(client, rootId);
  }
};
