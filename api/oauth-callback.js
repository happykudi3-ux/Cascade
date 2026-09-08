// Google redirects here after you approve access. This exchanges the
// one-time code for a refresh token and displays it ONCE for you to copy
// into Vercel's env vars — it is not stored anywhere by this app.

const { google } = require("googleapis");

module.exports = async (req, res) => {
  const parsedUrl = new URL(req.url, `https://${req.headers.host}`);
  const code = parsedUrl.searchParams.get("code");
  const error = parsedUrl.searchParams.get("error");

  if (error) {
    res.status(400).send(`Google returned an error: ${error}`);
    return;
  }
  if (!code) {
    res.status(400).send("No authorization code received.");
    return;
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = `https://${req.headers.host}/api/oauth-callback`;

  try {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      res.status(200).send(`
        <div style="font-family: sans-serif; padding: 24px; max-width: 600px;">
          <p>Google didn't return a refresh token this time — it only sends one the
          <em>first</em> time an app is authorized, or when access is explicitly re-requested.</p>
          <p>Fix: go to <a href="https://myaccount.google.com/permissions" target="_blank">
          Google Account &rarr; Security &rarr; Third-party access</a>, remove this app's
          access, then click your connect link again.</p>
        </div>
      `);
      return;
    }

    res.status(200).send(`
      <div style="font-family: sans-serif; padding: 24px; max-width: 640px;">
        <p>Copy this value into <b>GOOGLE_OAUTH_REFRESH_TOKEN</b> in Vercel &rarr;
        Settings &rarr; Environment Variables, then redeploy:</p>
        <pre style="font-family: monospace; white-space: pre-wrap; word-break: break-all;
          background: #111; color: #0f0; padding: 16px; border-radius: 6px;">${tokens.refresh_token}</pre>
        <p>This page never saves this value anywhere — if you navigate away without
        copying it, just visit your connect link again to get a new one.</p>
      </div>
    `);
  } catch (err) {
    res.status(500).send(`Token exchange failed: ${err.message}`);
  }
};
