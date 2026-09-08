// Flattens every role's every run into one combined report, tagged by
// role, so a company running 2-3 openings at once still gets one clean
// spreadsheet rather than one per role.

const drive = require("../lib/drive");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Use GET" });
    return;
  }

  const rootId = process.env.DRIVE_FOLDER_ID;
  if (!rootId) {
    res.status(200).json({ configured: false, candidates: [] });
    return;
  }

  try {
    const client = drive.getDriveClient();
    const roleFolders = await drive.listSubfolders(client, rootId);

    const rows = [];
    for (const folder of roleFolders) {
      const log = await drive.readJsonLog(client, folder.id, "cascade-log.json");
      for (const run of log) {
        for (const c of run.candidates || []) {
          rows.push({
            "Role": folder.name,
            "Run time": run.timestamp || "",
            "Candidate name": c.name,
            "Score": c.score ?? "",
            "Stage": c.stage ?? "",
            "Matched requirements": (c.matched || []).join(", "),
            "Missing requirements": (c.missing || []).join(", "),
            "Drafted email subject": c.email_subject || "",
          });
        }
      }
    }

    res.status(200).json({ configured: true, candidates: rows });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not build report." });
  }
};
