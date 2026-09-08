const drive = require("../lib/drive");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Use GET" });
    return;
  }

  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    res.status(200).json({ configured: false, runs: [] });
    return;
  }

  try {
    const client = drive.getDriveClient();
    const log = await drive.readJsonLog(client, folderId, "cascade-log.json");
    res.status(200).json({ configured: true, runs: log.slice(-15).reverse() });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not read run history." });
  }
};
