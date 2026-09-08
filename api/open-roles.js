// Public endpoint — no auth, since candidates need to load this to see
// which roles they can apply for. Returns only role names, nothing
// sensitive (not folder IDs, not job description content).

const drive = require("../lib/drive");
const { createRateLimiter, getClientIp } = require("../lib/rateLimit");

const rateLimited = createRateLimiter(60); // generous: every visit to the apply page calls this

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Use GET" });
    return;
  }
  const ip = getClientIp(req);
  if (rateLimited(ip)) {
    res.status(429).json({ error: "Too many requests. Try again shortly." });
    return;
  }

  const rootId = process.env.DRIVE_FOLDER_ID;
  if (!rootId) {
    res.status(200).json({ roles: [] });
    return;
  }

  try {
    const client = drive.getDriveClient();
    const folders = await drive.listSubfolders(client, rootId);

    const openRoles = [];
    for (const folder of folders) {
      const jd = await drive.readJobDescription(client, folder.id);
      if (jd) openRoles.push(folder.name);
    }

    res.status(200).json({ roles: openRoles });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not load open roles." });
  }
};
