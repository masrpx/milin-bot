import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { runNightlyResearch } from "@/lib/research";

export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const items = await runNightlyResearch();
    return NextResponse.json({ ok: true, itemCount: items.length });
  } catch (err) {
    Sentry.captureException(err);
    console.error("Research cron error:", err);
    return NextResponse.json({ error: "Research failed" }, { status: 500 });
  }
}
