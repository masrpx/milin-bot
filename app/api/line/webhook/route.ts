import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { verifyLineSignature, replyMessage } from "@/lib/line";
import { getMilinMemory, updateMilinMemory } from "@/lib/vault";
import { handleCapture } from "@/lib/handlers/capture";
import { handleArticle } from "@/lib/handlers/article";
import { handleConversation } from "@/lib/handlers/conversation";
import { handleApprove, isApproveCommand } from "@/lib/handlers/approve";
import {
  handleCalendar,
  handleCalendarConfirm,
  handleColorReply,
  hasPendingColorReply,
  isPendingCalendarConfirm,
} from "@/lib/handlers/calendar";

const anthropic = new Anthropic();

// ---------------------------------------------------------------------------
// Haiku pre-classifier — replaces keyword-based calendar detection.
// Runs on every message that isn't already caught by a fast-path rule.
// Returns "calendar" or "chat". Falls back to "chat" on any error.
// ---------------------------------------------------------------------------

async function classifyMessage(text: string): Promise<"calendar" | "chat"> {
  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: `Classify this Thai message as "calendar" (scheduling, appointments, events, meetings, free time, dates, timetable) or "chat" (everything else).

Message: "${text}"

Reply with ONLY: calendar OR chat`,
        },
      ],
    });
    const result = res.content[0].type === "text" ? res.content[0].text.trim().toLowerCase() : "chat";
    return result.includes("calendar") ? "calendar" : "chat";
  } catch {
    // Safe default — conversation handler gracefully covers missed calendar messages
    return "chat";
  }
}

// ---------------------------------------------------------------------------
// Message router — priority order matters
// ---------------------------------------------------------------------------

async function routeMessage(
  text: string,
  memory: Awaited<ReturnType<typeof getMilinMemory>>
): Promise<string> {
  const isUrl = /https?:\/\/[^\s]+/.test(text);
  const isLongText = text.length > 500;
  const isCapture = /^จด:/i.test(text.trim());

  // Priority 1: approve commands — "ok 1,2", "skip", "ok ทั้งหมด" (keyword, instant)
  if (isApproveCommand(text)) return handleApprove(text);

  // Priority 2: user is replying with a color for a pending "create" action.
  // Must run BEFORE the pre-classifier — a one-word color reply like "แดง" would
  // otherwise be classified as "chat" and lose the pending context.
  if (hasPendingColorReply(memory)) {
    const reply = await handleColorReply(text, memory);
    // Empty return means the pending expired mid-check — fall through normally
    if (reply) return reply;
  }

  // Priority 3: "ยืนยัน" confirming a pending delete or update
  if (isPendingCalendarConfirm(text, memory)) {
    const reply = await handleCalendarConfirm(memory);
    // Empty return means expired — fall through to conversation
    if (reply) return reply;
  }

  // Clear any stale expired pendingAction (fire-and-forget)
  if (memory.pendingAction && new Date() > new Date(memory.pendingAction.expiresAt)) {
    updateMilinMemory({ pendingAction: undefined }).catch(() => {});
  }

  // Priority 4: explicit capture prefix — must be before long-text check so
  // long "จด:" notes don't fall into the article handler
  if (isCapture) return handleCapture(text.replace(/^จด:\s*/i, "").trim());

  // Priority 5: URL or long text → article handler (no LLM needed to detect)
  if (isUrl || isLongText) return handleArticle(text, isUrl);

  // Priority 6: Haiku pre-classifier decides calendar vs chat.
  // Covers natural language that doesn't match any fixed keyword.
  const category = await classifyMessage(text);
  if (category === "calendar") return handleCalendar(text, memory);
  return handleConversation(text, memory);
}

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
      const reply = await routeMessage(text, memory);
      await replyMessage(replyToken, reply);
    } catch (err) {
      console.error("Webhook handler error:", err);
      await replyMessage(replyToken, "มีบางอย่างผิดพลาดอ่ะ ลองใหม่นะ~");
    }
  }

  return NextResponse.json({ ok: true });
}
