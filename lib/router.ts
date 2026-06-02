import Anthropic from "@anthropic-ai/sdk";
import { updateMilinMemory, appendRecentMessages, appendChatHistory, type MilinMemory, type RecentMessage } from "./vault";
import { handleCapture } from "./handlers/capture";
import { handleArticle } from "./handlers/article";
import { handleConversation } from "./handlers/conversation";
import {
  handleCalendar,
  handleCalendarConfirm,
  handleColorReply,
  hasPendingColorReply,
  isPendingCalendarConfirm,
} from "./handlers/calendar";
import { handlePhotoRequest } from "./handlers/photo-request";
import { handleTodoCapture } from "./handlers/todo-capture";
import {
  handleNDN,
  isPendingRescheduleConfirm,
  confirmReschedule,
} from "./handlers/ndn";
import { handleNVDN, isPendingNVDNMore } from "./handlers/nvdn";
import {
  handleTodoClassify,
  handleInboxQuery,
  isPendingTodoClassify,
} from "./handlers/todo-classify";

const anthropic = new Anthropic({ maxRetries: 4 });

// ---------------------------------------------------------------------------
// Haiku pre-classifier — replaces keyword-based calendar detection.
// Runs on every message that isn't already caught by a fast-path rule.
// Returns "calendar", "photo_request", or "chat". Falls back to "chat" on error.
// ---------------------------------------------------------------------------

function formatClassifierContext(msgs: RecentMessage[], count = 4): string {
  return msgs
    .slice(-count)
    .map((m) => `${m.role === "user" ? "แม็ก" : "มิลิน"}: ${m.content.slice(0, 120)}`)
    .join("\n");
}

export async function classifyMessage(
  text: string,
  context?: string
): Promise<"calendar" | "photo_request" | "chat"> {
  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: `${context ? `Recent conversation context:\n${context}\n\n` : ""}Classify this Thai message into one category:
- "calendar": explicitly requesting to view, create, edit, or delete a calendar event or check availability
- "photo_request": explicitly asking Milin to send a photo of herself or show what she looks like right now
- "chat": everything else — including vague scheduling talk in non-calendar contexts, messages using pronouns like "นั่น"/"อัน"/"มัน" to reference something already shown, or general discussion

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
    text: string,
    context?: string
  ) => Promise<"calendar" | "photo_request" | "chat"> = classifyMessage
): Promise<string> {
  const isUrl = /https?:\/\/[^\s]+/.test(text);
  const isLongText = text.length > 500;
  const isCapture = /^จด:/i.test(text.trim());
  const isTodoCapture = /^cap:/i.test(text.trim());
  const isNDN = /^ndn(\s|$)/i.test(text.trim());
  const isReschedule = /^reschedule\s/i.test(text.trim());
  const isNVDN = /^(milin\s+)?nvdn(\s|$)/i.test(text.trim());
  const isInboxQuery = /\binbox\b/i.test(text);

  // All handlers return a reply string. We save every exchange to recentMessages
  // here (fire-and-forget) so memory is complete regardless of which handler ran.
  // conversation.ts does NOT save recentMessages itself — this is the single place.
  async function finish(reply: string): Promise<string> {
    if (reply) {
      appendRecentMessages(text, reply).catch(() => {});
      appendChatHistory(text, reply).catch(() => {});
    }
    return reply;
  }

  // Priority 2: user is replying with a color for a pending "create" action.
  // Must run BEFORE the pre-classifier — a one-word color reply like "แดง" would
  // otherwise be classified as "chat" and lose the pending context.
  if (hasPendingColorReply(memory)) {
    const reply = await handleColorReply(text, memory);
    // Empty return means the pending expired mid-check — fall through normally
    if (reply) return finish(reply);
  }

  // Priority 2.1: "more" for NVDN pagination — before classifier so it doesn't route to chat
  if (isPendingNVDNMore(text, memory)) return finish(await handleNVDN(text, memory));

  // Priority 2.2: "ยืนยัน" confirming a reschedule (delete calendar → add to NDN)
  if (isPendingRescheduleConfirm(text, memory)) {
    const reply = await confirmReschedule(memory);
    if (reply) return finish(reply);
  }

  // Priority 3: "ยืนยัน" confirming a pending delete or update
  if (isPendingCalendarConfirm(text, memory)) {
    const reply = await handleCalendarConfirm(memory);
    // Empty return means expired — fall through to conversation
    if (reply) return finish(reply);
  }

  // Clear any stale expired pendingAction (fire-and-forget)
  if (
    memory.pendingAction &&
    new Date() > new Date(memory.pendingAction.expiresAt)
  ) {
    updateMilinMemory({ pendingAction: undefined }).catch(() => {});
  }

  // Priority 3.1: cap: prefix — must be before long-text check so a long cap: note
  // doesn't fall into the article handler
  if (isTodoCapture) return finish(await handleTodoCapture(text.replace(/^cap:\s*/i, "").trim()));

  // Priority 3.2: NVDN query / delete
  if (isNVDN) return finish(await handleNVDN(text, memory));

  // Priority 3.3: NDN commands + reschedule
  if (isNDN || isReschedule) return finish(await handleNDN(text, memory));

  // Priority 4: explicit capture prefix — must be before long-text check so
  // long "จด:" notes don't fall into the article handler
  if (isCapture) return finish(await handleCapture(text.replace(/^จด:\s*/i, "").trim()));

  // Priority 4.5: inbox query ("ขอดู inbox") — before long-text and Haiku
  if (isInboxQuery) return finish(await handleInboxQuery());

  // Priority 4.6: pending todo classification reply — catches "1 ndn, 2 cal พฤหัส 14.00" etc.
  // Placed after specific commands so ndn/nvdn/cap: still work while classify is pending.
  if (isPendingTodoClassify(memory)) return finish(await handleTodoClassify(text, memory));

  // Priority 5: URL or long text → article handler (no LLM needed to detect)
  if (isUrl || isLongText) return finish(await handleArticle(text, isUrl));

  // Priority 6: Haiku pre-classifier decides calendar / photo_request / chat.
  // Covers natural language that doesn't match any fixed keyword.
  const classifierContext = memory.recentMessages.length
    ? formatClassifierContext(memory.recentMessages)
    : undefined;
  const category = await classifier(text, classifierContext);
  if (category === "calendar") return finish(await handleCalendar(text, memory));

  // Priority 7: photo request — handler sends image+text directly via replyToken,
  // returns "" so the caller knows not to send another reply.
  if (category === "photo_request") {
    await handlePhotoRequest(replyToken, memory);
    appendChatHistory(text, "(ส่งรูป)").catch(() => {});
    return "";
  }

  return finish(await handleConversation(text, memory));
}
