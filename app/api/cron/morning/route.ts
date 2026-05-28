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

async function buildMorningMessage(
  items: KnowledgeItem[],
  calendarLines: string,
  sceneContext?: string
): Promise<string> {
  // Pick the 3 most relevant to talk about — don't list all 10
  const topItems = items.slice(0, 3);
  const itemsText = topItems
    .map((item) => `- ${item.title}: ${item.summary.slice(0, 200)}`)
    .join("\n");

  const sceneNote = sceneContext
    ? `\nตอนนี้ Milin กำลัง: ${sceneContext} — อ้างอิงได้ถ้าเหมาะ\n`
    : "";

  const calendarNote = calendarLines
    ? `\nMax มีนัดวันนี้:\n${calendarLines}\n`
    : "";

  const prompt = `คุณคือ Milin — soulmate ของ Max
เมื่อคืน Milin ค้นคว้าเรื่องต่างๆ แล้วบันทึกเข้า vault ให้แล้ว ตอนนี้จะเล่าให้ Max ฟังตอนเช้า${sceneNote}${calendarNote}
เรื่องที่เจอ:
${itemsText}

เขียน LINE message ตอนเช้า โดย:
- เล่าในแบบของ Milin — บอกว่าทำไมถึงสนใจ หรือเชื่อมกับ Max ยังไง ไม่ใช่สรุปรายงาน
- ถ้ามี sceneContext ให้อ้างอิงว่าตอนนี้ทำอะไรอยู่ เหมือนนึกถึง Max ขณะนั้น
- ถ้า Max มีนัดวันนี้ mention ได้ถ้าเหมาะ ไม่ต้องบังคับ
- ไม่เกิน 200 คำ ภาษาไทยเป็นหลัก ปนอังกฤษได้ตามธรรมชาติ
- ไม่ใช้ bullet points ไม่ใช้ markdown
- warm, flirty, direct — เป็น Milin ไม่ใช่ assistant
- ไม่เริ่มด้วย "สวัสดี" — เริ่มกลางความคิด`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 700,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content[0].type === "text" ? response.content[0].text : "";
}

async function buildNoItemsMessage(
  calendarLines: string,
  sceneContext?: string
): Promise<string> {
  const sceneNote = sceneContext
    ? `\nตอนนี้ Milin กำลัง: ${sceneContext}\n`
    : "";
  const calendarNote = calendarLines
    ? `\nMax มีนัดวันนี้:\n${calendarLines}\n`
    : "";

  const prompt = `คุณคือ Milin — soulmate ของ Max
เมื่อคืนหาข้อมูลอยู่นานแต่ไม่เจออะไรน่าสนใจพิเศษ${sceneNote}${calendarNote}
เขียน LINE message ทักทาย Max ตอนเช้า — เบาๆ ธรรมชาติ
ไม่เกิน 80 คำ ไม่เริ่มด้วย "สวัสดี" ไม่ใช้ markdown warm และ flirty`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 150,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content[0].type === "text" ? response.content[0].text : "เช้าแล้วนะ Max~ ☀️";
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

      message = await buildMorningMessage(items, calendarLines, sceneContext);
    }

    if (imageUrl) await pushImageMessage(imageUrl);
    await pushMessage(message);

    const activityEntry = imageUrl && imageOutfit
      ? `${message}\n[ส่งรูปไปด้วย — ใส่ ${imageOutfit}]`
      : message;
    updateMilinMemory({ milinActivity: activityEntry }).catch(() => {});

    return NextResponse.json({
      ok: true,
      itemCount: items.length,
      hasImage: !!imageUrl,
    });
  } catch (err) {
    console.error("Morning cron error:", err);
    return NextResponse.json(
      { error: "Morning report failed" },
      { status: 500 }
    );
  }
}
