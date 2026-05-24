import { NextRequest, NextResponse } from "next/server";

/** Temporary diagnostic endpoint — delete after debugging */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  const present = {
    GOOGLE_CLIENT_ID: !!clientId && clientId.length > 0,
    GOOGLE_CLIENT_SECRET: !!clientSecret && clientSecret.length > 0,
    GOOGLE_REFRESH_TOKEN: !!refreshToken && refreshToken.length > 0,
  };

  if (!clientId || !clientSecret || !refreshToken) {
    return NextResponse.json({ ok: false, stage: "env_missing", present });
  }

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      return NextResponse.json({
        ok: false,
        stage: "token_refresh_failed",
        http_status: res.status,
        google_error: data.error,
        google_error_description: data.error_description,
        present,
      });
    }

    return NextResponse.json({
      ok: true,
      stage: "token_ok",
      has_access_token: !!(data as { access_token?: string }).access_token,
      present,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      stage: "fetch_failed",
      error: String(err),
      present,
    });
  }
}
