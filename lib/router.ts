import Anthropic from "@anthropic-ai/sdk";
import { updateMilinMemory, type MilinMemory } from "./vault";
import { handleCapture } from "./handlers/capture";
import { handleArticle } from "./handlers/article";
import { handleConversation } from "./handlers/conversation";
import { handleApprove, isApproveCommand } from "./handlers/approve";
import {
  handleCalendar,
  handleCalendarConfirm,
  handleColorReply,
  hasPendingColorReply,
  isPendingCalendarConfirm,
} from "./handlers/calendar";
import { handlePhotoRequest } from "./handlers/photo-request";

const anthropic = new Anthropic();

// ---------------------------------------------------------------------------
// Haiku pre-classifier — replaces keyword-based calendar detection.
// Runs on every message that isn't already caught by a fast-path rule.
// Returns "calendar", "photo_request", or "chat". Falls back to "chat" on error.
// ---------------------------------------------------------------------------

export async function classifyMessage(
  text: string
): Promise<"calendar" | "photo_request" | "chat"> {
  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: `Classify this Thai message into one category:
- "calendar": scheduling, appointments, events, meetings, checking free time, dates, timetable
- "photo_request": asking Milin to send a photo, show what she's doing, or share a picture
- "chat": everything else

Message: "${text}"

Reply with ONLY: calendar OR photo_request OR chat`,
        },
      ],
    });
    const result =
      res.content[0].type === "text"
        ? res.content[0].text.trim().toLowerCase()
        : "chat";
    if (result.includes("calendar")) return "calendar";
    if (result.includes("photo_request") || result.includes("photo"))
      return "photo_request";
    return "chat";
  } catch {
    return "chat";
  }
}

// ---------------------------------------------------------------------------
// Message router — priority order matters.
// Returns the reply string, or "" if the handler already sent the reply directly
// (e.g. photo_request uses replyImageMessage internally).
// ---------------------------------------------------------------------------

export async function routeMessage(
  text: string,
  replyToken: string,
  memory: MilinMemory,
  // Injectable for testing — defaults to the real Haiku classifier in production
  classifier: (
    text: string
  ) => Promise<"calendar" | "photo_request" | "chat"> = classifyMessage
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
  if (
    memory.pendingAction &&
    new Date() > new Date(memory.pendingAction.expiresAt)
  ) {
    updateMilinMemory({ pendingAction: undefined }).catch(() => {});
  }

  // Priority 4: explicit capture prefix — must be before long-text check so
  // long "จด:" notes don't fall into the article handler
  if (isCapture) return handleCapture(text.replace(/^จด:\s*/i, "").trim());

  // Priority 5: URL or long text → article handler (no LLM needed to detect)
  if (isUrl || isLongText) return handleArticle(text, isUrl);

  // Priority 6: Haiku pre-classifier decides calendar / photo_request / chat.
  // Covers natural language that doesn't match any fixed keyword.
  const category = await classifier(text);
  if (category === "calendar") return handleCalendar(text, memory);

  // Priority 7: photo request — handler sends image+text directly via replyToken,
  // returns "" so the caller knows not to send another reply.
  if (category === "photo_request") {
    await handlePhotoRequest(replyToken, memory);
    return "";
  }

  return handleConversation(text, memory);
}
