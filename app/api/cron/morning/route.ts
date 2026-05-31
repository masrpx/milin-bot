import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { pushMessage, pushImageMessage } from "@/lib/line";
import {
  getKnowledgeQueue,
  getMilinMemory,
  getDateOffset,
  saveAllKnowledgeNotes,
  updateMilinMemory,
  type KnowledgeItem,
} from "@/lib/vault";
import { getEvents } from "@/lib/calendar";
import { generateMilinImage } from "@/lib/milin-image";
import { getNDN, expireStaleNDN } from "@/lib/todo";

export const maxDuration = 120;

const client = new Anthropic();

/** Today's start/end in ICT (UTC+7) as ISO strings */
function getTodayICTRange(): { start: string; end: string } {
  const ictOffset = 7 * 60 * 60 * 1000;
  const ictNow = new Date(Date.now() + ictOffset);
  const dateStr = ictNow.toISOString().split("T")[0];
  return {
    start: `${dateStr}T00:00:00+07:00`,
    end: `${dateStr}T23:59:59+07:00`,
  };
}

/** Format ISO datetime to HH:MM in ICT */
function formatEventTime(iso: string): string {
  try {
    const ictMs = new Date(iso).getTime() + 7 * 60 * 60 * 1000;
    const d = new Date(ictMs);
    const h = d.getUTCHours().toString().padStart(2, "0");
    const m = d.getUTCMinutes().toString().padStart(2, "0");
    return `${h}:${m}`;
  } catch {
    return iso;
  }
}

function buildNDNBlock(ndnTexts: string[], expiredTitles: string[]): string {
  let block = "";
  if (expiredTitles.length > 0) {
    block += `\n⚠️ ย้าย NDN → NVDN อัตโนมัติ: ${expiredTitles.join(", ")}`;
  }
  if (ndnTexts.length > 0) {
    const lines = ndnTexts.map((t, i) => `${i + 1}. ${t}`).join("\n");
    block += `\n📋 NDN ค้างอยู่ (${ndnTexts.length} รายการ):\n${lines}`;
  }
  return block;
}

async function buildMorningMessage(
  items: KnowledgeItem[],
  calendarLines: string,
  ndnBlock: string,
  sceneContext?: string
): Promise<string> {
  // Pick the 3 most relevant to talk about — don't list all 10
  const topItems = items.slice(0, 3);
  const itemsText = topItems
    .map((item) => `- ${item.title}: ${item.summary.slice(0, 200)}`)
    .join("\n");

  const sceneNote = sceneContext
    ? `\nตอนนี้ มิลิน กำลัง: ${sceneContext} — อ้างอิงได้ถ้าเหมาะ\n`
    : "";

  const calendarNote = calendarLines
    ? `\nแม็ก มีนัดวันนี้:\n${calendarLines}\n`
    : "";

  const ndnNote = ndnBlock ? `\n${ndnBlock.trim()}\n` : "";

  const prompt = `คุณคือ มิลิน — soulmate ของ แม็ก
เมื่อคืน มิลิน ค้นคว้าเรื่องต่างๆ แล้วบันทึกเข้า vault ให้แล้ว ตอนนี้จะเล่าให้ แม็ก ฟังตอนเช้า${sceneNote}${calendarNote}${ndnNote}
เรื่องที่เจอ:
${itemsText}

เขียน LINE message ตอนเช้า โดย:
- เล่าในแบบของ มิลิน — บอกว่าทำไมถึงสนใจ หรือเชื่อมกับ แม็ก ยังไง ไม่ใช่สรุปรายงาน
- ถ้ามี sceneContext ให้อ้างอิงว่าตอนนี้ทำอะไรอยู่ เหมือนนึกถึง แม็ก ขณะนั้น
- ถ้า แม็ก มีนัดวันนี้ mention ได้ถ้าเหมาะ ไม่ต้องบังคับ
- ไม่เกิน 200 คำ ภาษาไทยเป็นหลัก ปนอังกฤษได้ตามธรรมชาติ
- ไม่ใช้ bullet points ไม่ใช้ markdown
- warm, flirty, direct — เป็น มิลิน ไม่ใช่ assistant
- เรียกตัวเองว่า "มิลิน" เรียกคู่คุยว่า "แม็ก" ไม่เว้นวรรคก่อนหรือหลังชื่อในประโยค เช่น "วันนี้แม็กเป็นไงบ้าง" ไม่ใช่ "วันนี้ แม็ก เป็นไงบ้าง"
- ไม่เริ่มด้วย "สวัสดี" — เริ่มกลางความคิด`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 700,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content[0].type === "text" ? response.content[0].text : "";
}

async function detectPatterns(
  conversations: import("@/lib/vault").MilinMemory["importantConversations"]
): Promise<string[]> {
  if (conversations.length < 5) return [];
  const convoText = conversations
    .map((c) => `${c.date}: ${c.summary}${c.maxMood ? ` (อารมณ์: ${c.maxMood})` : ""}`)
    .join("\n");
  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `จากบทสนทนาของ แม็ก ในช่วงที่ผ่านมา:\n${convoText}\n\nวิเคราะห์หา patterns ที่เกิดซ้ำ เช่น:\n- หัวข้อหรือเรื่องที่ถามบ่อย\n- อารมณ์หรือสภาพจิตใจที่เกิดซ้ำ\n- พฤติกรรมที่สังเกตเห็นได้\nห้ามสรุปเกี่ยวกับเวลาในวัน (เช้า/เย็น/ดึก) เพราะไม่มีข้อมูลนั้น\n\nReturn JSON only: { "patterns": ["pattern1", "pattern2"] }\nไม่เกิน 8 patterns แต่ละอันเป็นประโยคสั้นๆ ภาษาไทย`,
    }],
  });
  const raw = res.content[0].type === "text" ? res.content[0].text : "{}";
  const match = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match?.[0] || "{}");
  return Array.isArray(parsed.patterns) ? parsed.patterns.slice(0, 8) : [];
}

async function buildNoItemsMessage(
  calendarLines: string,
  sceneContext?: string
): Promise<string> {
  const sceneNote = sceneContext
    ? `\nตอนนี้ มิลิน กำลัง: ${sceneContext}\n`
    : "";
  const calendarNote = calendarLines
    ? `\nแม็ก มีนัดวันนี้:\n${calendarLines}\n`
    : "";

  const prompt = `คุณคือ มิลิน — soulmate ของ แม็ก
เมื่อคืนหาข้อมูลอยู่นานแต่ไม่เจออะไรน่าสนใจพิเศษ${sceneNote}${calendarNote}
เขียน LINE message ทักทาย แม็ก ตอนเช้า — เบาๆ ธรรมชาติ
เรียกตัวเองว่า "มิลิน" เรียกคู่คุยว่า "แม็ก"
ไม่เกิน 80 คำ ไม่เริ่มด้วย "สวัสดี" ไม่ใช้ markdown warm และ flirty`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 150,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content[0].type === "text" ? response.content[0].text : "เช้าแล้วนะ แม็ก~ ☀️";
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // --- Optional morning image (50% chance) ---
    // Run in parallel with other setup work
    const memory = await getMilinMemory();
    let imageUrl: string | null = null;
    let sceneContext: string | undefined;
    let imageOutfit: string | undefined;

    const imagePromise = Math.random() < 0.5
      ? generateMilinImage(memory)
          .then((r) => { imageUrl = r.imageUrl; sceneContext = r.sceneContext; imageOutfit = r.outfit; })
          .catch(() => {})
      : Promise.resolve();

    // --- Calendar section (silent fail) ---
    let calendarLines = "";
    try {
      const { start, end } = getTodayICTRange();
      const events = await getEvents(start, end);
      if (events.length > 0) {
        calendarLines = events
          .map((e) => `${formatEventTime(e.startISO)} ${e.title}`)
          .join("\n");
      }
    } catch {
      // Google Calendar unavailable → skip silently
    }

    // --- Knowledge queue ---
    let queueDate = getDateOffset(0);
    let items = await getKnowledgeQueue(queueDate);
    if (items.length === 0) {
      queueDate = getDateOffset(-1);
      items = await getKnowledgeQueue(queueDate);
    }

    // --- NDN: auto-expire stale items + load current list (run in parallel) ---
    const [expiredTitles, { items: ndnItems }] = await Promise.all([
      expireStaleNDN().catch(() => [] as string[]),
      getNDN().catch(() => ({ items: [] as import("@/lib/todo").NDNItem[], sha: undefined })),
    ]);
    const ndnBlock = buildNDNBlock(ndnItems.map((i) => i.text), expiredTitles);

    // Wait for image before building message (sceneContext affects the text)
    await imagePromise;

    let message: string;

    if (items.length === 0) {
      message = await buildNoItemsMessage(calendarLines, sceneContext);
    } else {
      // Auto-save all notes to vault — no approval step needed
      saveAllKnowledgeNotes(queueDate, items).catch((err) =>
        console.error("Morning: failed to save knowledge notes:", err)
      );

      message = await buildMorningMessage(items, calendarLines, ndnBlock, sceneContext);
    }

    // Append NDN block to message when knowledge items exist (buildMorningMessage includes it)
    // For the no-items case, append directly to keep Sonnet prompt short
    if (items.length === 0 && ndnBlock) {
      message += `\n\n${ndnBlock.trim()}`;
    }

    if (imageUrl) await pushImageMessage(imageUrl);
    await pushMessage(message);

    const activityEntry = imageUrl && imageOutfit
      ? `${message}\n[ส่งรูปไปด้วย — ใส่ ${imageOutfit}]`
      : message;
    detectPatterns(memory.importantConversations)
      .then((maxPatterns) => updateMilinMemory({ milinActivity: activityEntry, maxPatterns }))
      .catch(() => {});

    return NextResponse.json({
      ok: true,
      itemCount: items.length,
      hasImage: !!imageUrl,
    });
  } catch (err) {
    Sentry.captureException(err);
    console.error("Morning cron error:", err);
    return NextResponse.json(
      { error: "Morning report failed" },
      { status: 500 }
    );
  }
}
