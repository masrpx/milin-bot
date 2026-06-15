/**
 * One-time Google OAuth2 setup script.
 * Run locally: npx ts-node scripts/google-auth.ts
 *
 * Prerequisites: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local
 * After running: copy GOOGLE_REFRESH_TOKEN to Vercel env vars
 */
import http from "http";
import { config } from "dotenv";

config({ path: ".env.local" });

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "❌ Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env.local"
  );
  process.exit(1);
}

const REDIRECT_URI = "http://localhost:3333/callback";
// Calendar (bot) + Gmail read-only (local statement fetch, scripts/finance-fetch-gmail.ts)
const SCOPE = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // force refresh_token even if previously authorized
  });

console.log("\n🔐 Open this URL in your browser:\n");
console.log(authUrl);
console.log("\n⏳ Waiting for authorization on http://localhost:3333...\n");

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/callback")) {
    res.end("Not found");
    return;
  }

  const url = new URL(req.url, "http://localhost:3333");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.end(`Authorization denied: ${error}`);
    console.error(`\n❌ Authorization error: ${error}\n`);
    server.close();
    return;
  }

  if (!code) {
    res.end("No authorization code received.");
    server.close();
    return;
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID!,
        client_secret: CLIENT_SECRET!,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    const tokens = (await tokenRes.json()) as {
      refresh_token?: string;
      access_token?: string;
      error?: string;
    };

    if (tokens.refresh_token) {
      res.end("✅ Authorization successful! You can close this tab.");
      console.log("\n✅ Success! Add this to Vercel env vars:\n");
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    } else {
      res.end("❌ No refresh_token received. Check console.");
      console.error("\n❌ Token response:", tokens, "\n");
    }
  } catch (err) {
    res.end("Error exchanging code for tokens. Check console.");
    console.error("\n❌ Token exchange error:", err, "\n");
  }

  server.close();
});

server.listen(3333);
