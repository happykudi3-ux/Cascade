// Public endpoint — candidates hit this via apply.html, no login required.
// Saves the uploaded file directly into the matching role's Inbox folder
// using appProperties to record the name/email they typed, so scan-folder.js
// doesn't have to guess those back out of a filename later.

const fs = require("fs/promises");
const { formidable } = require("formidable");
const drive = require("../lib/drive");
const { createRateLimiter, getClientIp } = require("../lib/rateLimit");

const rateLimited = createRateLimiter(20);
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB
const ALLOWED_EXTENSIONS = /\.(pdf|docx?)$/i;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }
  const ip = getClientIp(req);
  if (rateLimited(ip)) {
    res.status(429).json({ error: "Too many submissions from this connection. Try again later." });
    return;
  }

  const rootId = process.env.DRIVE_FOLDER_ID;
  if (!rootId) {
    res.status(500).json({ error: "Server misconfigured: DRIVE_FOLDER_ID not set." });
    return;
  }

  let fields = {};
  let files = {};
  try {
    const form = formidable({ maxFileSize: MAX_FILE_BYTES, keepExtensions: true });
    [fields, files] = await form.parse(req);
  } catch (err) {
    res.status(400).json({ error: "Could not read the submitted form — check the file is under 8MB and try again." });
    return;
  }

  const name = (fields.name?.[0] || "").trim();
  const email = (fields.email?.[0] || "").trim();
  const role = (fields.role?.[0] || "").trim();
  const uploaded = files.resume?.[0];

  if (!name || !role || !uploaded) {
    res.status(400).json({ error: "Name, role, and a resume file are all required." });
    return;
  }
  if (!ALLOWED_EXTENSIONS.test(uploaded.originalFilename || "")) {
    res.status(400).json({ error: "Please upload a PDF or Word (.docx) file." });
    return;
  }

  try {
    const client = drive.getDriveClient();

    // Re-verify the role is genuinely open server-side rather than trusting
    // whatever the client sent — the dropdown could be stale if a role
    // closed between page load and submission.
    const roleFolders = await drive.listSubfolders(client, rootId);
    const matchedFolder = roleFolders.find((f) => f.name.toLowerCase() === role.toLowerCase());
    const jobDescription = matchedFolder ? await drive.readJobDescription(client, matchedFolder.id) : null;
    if (!matchedFolder || !jobDescription) {
      res.status(400).json({ error: "That role is no longer open. Please refresh the page and try again." });
      return;
    }

    const inboxId = await drive.ensureChildFolder(client, matchedFolder.id, "Inbox");

    const buffer = await fs.readFile(uploaded.filepath);
    const safeName = name.replace(/[\\/:*?"<>|]/g, "").trim() || "candidate";
    const ext = (uploaded.originalFilename.match(/\.(pdf|docx?)$/i) || ["", ".pdf"])[0] || ".pdf";
    const filename = `${safeName}${ext}`;

    await drive.uploadFile(
      client,
      inboxId,
      filename,
      buffer,
      uploaded.mimetype || "application/octet-stream",
      { candidate_name: name, candidate_email: email }
    );

    res.status(200).json({ message: "Application received." });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not submit application." });
  } finally {
    if (uploaded?.filepath) {
      await fs.unlink(uploaded.filepath).catch(() => {});
    }
  }
};
