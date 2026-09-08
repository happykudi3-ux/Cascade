// Aggregates recent runs across every open role folder into one
// chronological feed for the "Recent automated runs" panel.

const drive = require("../lib/drive");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Use GET" });
    return;
  }

  const rootId = process.env.DRIVE_FOLDER_ID;
  if (!rootId) {
    res.status(200).json({ configured: false, runs: [] });
    return;
  }

  try {
    const client = drive.getDriveClient();
    const roleFolders = await drive.listSubfolders(client, rootId);

    const allRuns = [];
    for (const folder of roleFolders) {
      const log = await drive.readJsonLog(client, folder.id, "cascade-log.json");
      for (const entry of log) {
        allRuns.push({ ...entry, role: folder.name });
      }
    }

    allRuns.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.status(200).json({ configured: true, runs: allRuns.slice(0, 20) });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not read run history." });
  }
};
