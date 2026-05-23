import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature, replyMessage } from "@/lib/line";
import { getMilinMemory } from "@/lib/vault";
import { handleCapture } from "@/lib/handlers/capture";
import { handleArticle } from "@/lib/handlers/article";
import { handleConversation } from "@/lib/handlers/conversation";
import { handleApprove, isApproveCommand } from "@/lib/handlers/approve";
import {
  handleCalendar,
  handleCalendarConfirm,
  isCalendarMessage,
  isPendingCalendarConfirm,
} from "@/lib/handlers/calendar";
import { updateMilinMemory } from "@/lib/vault";

async function routeMessage(
  text: string,
  memory: Awaited<ReturnType<typeof getMilinMemory>>
): Promise<string> {
  const isUrl = /https?:\/\/[^\s]+/.test(text);
  const isLongText = text.length > 500;
  const isCapture = /^จด:/i.test(text.trim());

  // Priority 1: approve commands ("ok 1,2", "skip", "ok ทั้งหมด")
  if (isApproveCommand(text)) return handleApprove(text);

  // Priority 2: calendar confirm — "ยืนยัน" with valid pending action
  if (isPendingCalendarConfirm(text, memory)) {
    const reply = await handleCalendarConfirm(memory);
    // If pendingAction expired mid-check, fall through to conversation
    if (reply) return reply;
  }

  // Clear stale expired pendingAction if one exists but is expired
  if (
    memory.pendingAction &&
    new Date() > new Date(memory.pendingAction.expiresAt)
  ) {
    updateMilinMemory({ pendingAction: undefined }).catch(() => {});
  }

  // Priority 3: calendar keywords
  if (isCalendarMessage(text)) return handleCalendar(text, memory);

  // Priority 4: explicit capture ("จด:" prefix) — must be before long-text check
  if (isCapture) return handleCapture(text.replace(/^จด:\s*/i, "").trim());

  // Priority 5: URL or long text → article handler
  if (isUrl || isLongText) return handleArticle(text, isUrl);

  // Priority 6: everything else → Milin conversation
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
