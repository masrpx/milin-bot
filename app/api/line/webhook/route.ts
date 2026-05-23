import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature, replyMessage } from "@/lib/line";
import { getMilinMemory } from "@/lib/vault";
import { handleCapture } from "@/lib/handlers/capture";
import { handleArticle } from "@/lib/handlers/article";
import { handleConversation } from "@/lib/handlers/conversation";
import { handleApprove, isApproveCommand } from "@/lib/handlers/approve";

async function routeMessage(
  text: string,
  memory: Awaited<ReturnType<typeof getMilinMemory>>
): Promise<string> {
  const isUrl = /https?:\/\/[^\s]+/.test(text);
  const isLongText = text.length > 500;
  const isCapture = /^จด:/i.test(text.trim());

  if (isApproveCommand(text)) return handleApprove(text);
  if (isUrl || isLongText) return handleArticle(text, isUrl);
  if (isCapture) return handleCapture(text.replace(/^จด:\s*/i, "").trim());
  return handleConversation(text, memory);
}

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
      const reply = await routeMessage(text, memory);
      await replyMessage(replyToken, reply);
    } catch (err) {
      console.error("Webhook handler error:", err);
      await replyMessage(replyToken, "มีบางอย่างผิดพลาดอ่ะ ลองใหม่นะ~");
    }
  }

  return NextResponse.json({ ok: true });
}
