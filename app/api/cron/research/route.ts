import { NextRequest, NextResponse } from "next/server";
import { runNightlyResearch } from "@/lib/research";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = req.nextUrl.searchParams.get("secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const items = await runNightlyResearch();
    return NextResponse.json({ ok: true, itemCount: items.length });
  } catch (err) {
    console.error("Research cron error:", err);
    return NextResponse.json({ error: "Research failed" }, { status: 500 });
  }
}
