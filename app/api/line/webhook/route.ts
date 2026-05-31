import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature, replyMessage } from "@/lib/line";
import { getMilinMemory } from "@/lib/vault";
import { routeMessage } from "@/lib/router";

// ---------------------------------------------------------------------------
// LINE webhook POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") || "";

  if (!verifyLineSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: {
    events: {
      type: string;
      replyToken: string;
      source: { userId: string };
      message: { type: string; text: string };
    }[];
  };

  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  for (const event of body.events) {
    if (event.type !== "message" || event.message.type !== "text") continue;

    const userId = event.source.userId;
    if (userId !== process.env.LINE_USER_ID) continue;

    const text = event.message.text;
    const replyToken = event.replyToken;

    try {
      const memory = await getMilinMemory();
      const reply = await routeMessage(text, replyToken, memory);
      // "" means the handler already replied directly (e.g. photo_request)
      if (reply) await replyMessage(replyToken, reply);
    } catch (err) {
      Sentry.captureException(err);
      console.error("Webhook handler error:", err);
      await replyMessage(replyToken, "มีบางอย่างผิดพลาดอ่ะ ลองใหม่นะ~");
    }
  }

  return NextResponse.json({ ok: true });
}
