// One-time setup route. Visiting this (with the correct key) redirects to
// Google's consent screen so YOU can authorize Cascade to act as your own
// Drive account. Candidates never see this — apply.html never touches
// Google auth at all, it just talks to our own backend.

const { google } = require("googleapis");

module.exports = async (req, res) => {
  const parsedUrl = new URL(req.url, `https://${req.headers.host}`);
  const key = parsedUrl.searchParams.get("key");
  const expected = process.env.OAUTH_SETUP_KEY;

  if (!expected) {
    res.status(500).send("OAUTH_SETUP_KEY is not set. Add it in Vercel env vars first (any random string you choose), then reload this link.");
    return;
  }
  if (key !== expected) {
    res.status(401).send("Unauthorized — missing or incorrect ?key= value.");
    return;
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).send("GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET not set.");
    return;
  }

  const redirectUri = `https://${req.headers.host}/api/oauth-callback`;
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline", // required to get a refresh_token back
    prompt: "consent", // forces a refresh_token even on repeat authorization
    scope: ["https://www.googleapis.com/auth/drive"],
  });

  res.writeHead(302, { Location: authUrl });
  res.end();
};
