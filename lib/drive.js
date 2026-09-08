// Drive helpers for Cascade's automated intake. Auth is via a Service
// Account (not user OAuth) — you share the target Drive folder with the
// service account's email like you'd share it with a colleague, and that's
// the entire "login" step. No consent screen, no refresh tokens to manage.

const { google } = require("googleapis");
const { Readable } = require("stream");

const FOLDER_MIME = "application/vnd.google-apps.folder";
const GDOC_MIME = "application/vnd.google-apps.document";

function getDriveClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY not set.");
  }
  // Vercel env vars can't store real newlines cleanly, so the key is stored
  // with literal \n sequences and unescaped here.
  const key = rawKey.replace(/\\n/g, "\n");
  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

async function findChild(drive, parentId, name, mimeType) {
  const mimeClause = mimeType ? ` and mimeType = '${mimeType}'` : "";
  const safeName = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${safeName}' and trashed = false${mimeClause}`,
    fields: "files(id, name, mimeType)",
    pageSize: 5,
  });
  return res.data.files?.[0] || null;
}

async function ensureChildFolder(drive, parentId, name) {
  const existing = await findChild(drive, parentId, name, FOLDER_MIME);
  if (existing) return existing.id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
    fields: "id",
  });
  return created.data.id;
}

async function listFiles(drive, folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`,
    fields: "files(id, name, mimeType, modifiedTime)",
    pageSize: 100,
    orderBy: "createdTime",
  });
  return res.data.files || [];
}

async function downloadBuffer(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

async function exportAsText(drive, fileId) {
  const res = await drive.files.export(
    { fileId, mimeType: "text/plain" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data).toString("utf-8");
}

/** Extracts plain text from a Drive file regardless of its underlying format. */
async function extractText(drive, file) {
  if (file.mimeType === GDOC_MIME) {
    return exportAsText(drive, file.id);
  }
  const buffer = await downloadBuffer(drive, file.id);

  if (file.mimeType === "application/pdf" || /\.pdf$/i.test(file.name)) {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buffer);
    return data.text;
  }
  if (
    file.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.docx$/i.test(file.name)
  ) {
    const mammoth = require("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  // fall back to treating it as plain text
  return buffer.toString("utf-8");
}

/** Reads job_description.txt / .docx / a Google Doc named "job_description" from a folder. */
async function readJobDescription(drive, folderId) {
  const candidates = ["job_description.txt", "job_description.docx", "job_description"];
  for (const name of candidates) {
    const file = await findChild(drive, folderId, name);
    if (file) return extractText(drive, file);
  }
  return null;
}

async function moveFile(drive, fileId, fromFolderId, toFolderId) {
  await drive.files.update({
    fileId,
    addParents: toFolderId,
    removeParents: fromFolderId,
    fields: "id, parents",
  });
}

/** Appends one entry to a JSON-array log file in the folder, creating it if needed. */
async function appendJsonLog(drive, folderId, filename, entry, maxEntries = 100) {
  const existing = await findChild(drive, folderId, filename);
  let log = [];
  if (existing) {
    try {
      const text = await downloadBuffer(drive, existing.id);
      log = JSON.parse(text.toString("utf-8"));
      if (!Array.isArray(log)) log = [];
    } catch {
      log = [];
    }
  }
  log.push(entry);
  if (log.length > maxEntries) log = log.slice(log.length - maxEntries);

  const body = bufferToStream(Buffer.from(JSON.stringify(log, null, 2)));
  if (existing) {
    await drive.files.update({ fileId: existing.id, media: { mimeType: "application/json", body } });
  } else {
    await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType: "application/json", body },
      fields: "id",
    });
  }
  return log;
}

async function readJsonLog(drive, folderId, filename) {
  const existing = await findChild(drive, folderId, filename);
  if (!existing) return [];
  try {
    const buf = await downloadBuffer(drive, existing.id);
    const parsed = JSON.parse(buf.toString("utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

module.exports = {
  getDriveClient,
  ensureChildFolder,
  listFiles,
  extractText,
  readJobDescription,
  moveFile,
  appendJsonLog,
  readJsonLog,
};
