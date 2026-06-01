import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getMilinMemory, updateMilinMemory, type MilinMemory } from "@/lib/vault";
import { pushMessage, pushImageMessage } from "@/lib/line";
import { generateMilinImage, pickScene } from "@/lib/milin-image";
import { getEvents, type CalendarEvent } from "@/lib/calendar";

export const maxDuration = 300;

const PING_WINDOW_START_ICT = 8;  // 8am ICT
const PING_WINDOW_SLOTS = 13;     // 8am–8pm = 13 hourly slots
const MAX_DAILY_PINGS = 2;
const IMAGE_PROBABILITY = 0.7;

const client = new Anthropic();

type MessageType = "emotional" | "flirty" | "very_flirty";

function pickMessageType(): MessageType {
  const r = Math.random();
  if (r < 0.40) return "emotional";
  if (r < 0.70) return "flirty";
  return "very_flirty";
}

function getTimePeriod(ictHour: number): string {
  if (ictHour >= 8 && ictHour < 12) return "เช้า";
  if (ictHour >= 12 && ictHour < 18) return "กลางวัน";
  if (ictHour >= 18 && ictHour < 22) return "เย็น";
  return "ดึก";
}

function formatICTTime(iso: string): string {
  const ictDate = new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000);
  return ictDate.toISOString().slice(11, 16);
}

async function fetchTodayUpcomingEvents(): Promise<CalendarEvent[]> {
  try {
    const now = new Date();
    const ictMidnightMs = now.getTime() + 7 * 60 * 60 * 1000;
    const ictMidnight = new Date(ictMidnightMs);
    ictMidnight.setUTCHours(0, 0, 0, 0);
    ictMidnight.setUTCDate(ictMidnight.getUTCDate() + 1);
    const endOfDayUTC = new Date(ictMidnight.getTime() - 7 * 60 * 60 * 1000);
    return await getEvents(now.toISOString(), endOfDayUTC.toISOString());
  } catch {
    return [];
  }
}

function getIctInfo(): { hour: number; dateStr: string; slotIndex: number } {
  const ictMs = Date.now() + 7 * 60 * 60 * 1000;
  const ictDate = new Date(ictMs);
  const hour = ictDate.getUTCHours();
  const dateStr = ictDate.toISOString().split("T")[0];
  const slotIndex = hour >= PING_WINDOW_START_ICT ? hour - PING_WINDOW_START_ICT : hour + 16;
  return { hour, dateStr, slotIndex };
}

const wordCapByType: Record<MessageType, string> = {
  emotional: "ไม่เกิน 120 คำ",
  flirty: "30-150 คำ ยาวหรือสั้นก็ได้ตามธรรมชาติ",
  very_flirty: "ไม่เกิน 200 คำ",
};

function findMemoryNudge(
  conversations: MilinMemory["importantConversations"],
  todayDateStr: string
): { summary: string; label: string } | null {
  const today = new Date(todayDateStr + "T00:00:00Z");
  const windows: [number, number, string][] = [
    [1, 1, "เมื่อวาน"],
    [6, 8, "อาทิตย์ที่แล้ว"],
    [28, 32, "เดือนที่แล้ว"],
  ];
  for (const [min, max, label] of windows) {
    const match = [...conversations].reverse().find((c) => {
      const diff = Math.round((today.getTime() - new Date(c.date + "T00:00:00Z").getTime()) / 86400000);
      return diff >= min && diff <= max;
    });
    if (match) return { summary: match.summary, label };
  }
  return null;
}

async function buildPingPrompt(
  type: MessageType,
  memory: MilinMemory,
  ictHour: number,
  sceneContext: string,
  upcomingEvents: CalendarEvent[],
  memoryNudge: { summary: string; label: string } | null
): Promise<string> {
  const aboutMaxLines = memory.aboutMax.slice(-10).join("\n");
  const learnedLines = memory.learnedPreferences.slice(-10).join("\n");
  const patternsText = memory.maxPatterns?.length
    ? memory.maxPatterns.join("\n")
    : "";
  const recentConvos = memory.importantConversations
    .slice(-3)
    .map((c) => `- ${c.date}: ${c.summary}`)
    .join("\n");
  // Shuffle so the same topic doesn't appear every ping
  const shuffledTopics = [...memory.topicsAsked].sort(() => Math.random() - 0.5);
  const topics = shuffledTopics.slice(0, 3).join(", ");

  // Filter out system commands so Milin doesn't comment on "1 ndn", "cap: ...", etc.
  const COMMAND_RE = /^(ndn|nvdn|cap:|จด:|reschedule |ok\b|skip|ยืนยัน|more|\d+\s+(ndn|nvdn|cal|none))/i;
  const conversationalMsgs = memory.recentMessages
    .slice(-4)
    .filter(m => m.role !== "user" || !COMMAND_RE.test(m.content.trim()));
  const recentMsgsText = conversationalMsgs.length > 0
    ? conversationalMsgs.map(m => `${m.role === "user" ? "แม็ก" : "มิลิน"}: ${m.content}`).join("\n")
    : "(ยังไม่มีการสนทนา)";

  const timePeriod = getTimePeriod(ictHour);

  const typeInstructions: Record<MessageType, string> = {
    emotional: `ประเภท: Emotional check-in
มิลินอยู่ดีๆ นึกถึง แม็ก ขึ้นมา อาจเป็นเรื่องที่คุยกัน หรือแค่คิดถึง
อ้างอิงบทสนทนาล่าสุดได้ถ้าเหมาะ ไม่ต้องมีเหตุผลพิเศษ`,

    flirty: `ประเภท: Flirty/playful
มิลินแค่อยากส่งข้อความแซว tease หรือบอกว่าคิดถึง
ตรง ไม่อ้อม — มิลินชอบ แม็ก อย่างชัดเจน ยาวหรือสั้นก็ได้ตามอารมณ์`,

    very_flirty: `ประเภท: Very flirty / intimate
มิลินอยากบอก แม็ก ตรงๆ ว่าอยากได้เขา ทั้งทางกายและอารมณ์
พูดถึงสิ่งที่อยากทำกับ แม็ก หรืออยากให้ แม็ก ทำ — ชัดเจน เซ็กซี่ intimate ไม่อาย`,
  };

  const calendarNote = upcomingEvents.length > 0
    ? `\nกิจกรรมของ แม็ก วันนี้ที่ยังไม่ถึง:\n${upcomingEvents.map((e) => `- ${formatICTTime(e.startISO)} ${e.title}`).join("\n")}\nถ้าเหมาะสมและเป็นธรรมชาติ อ้างอิงกิจกรรมนี้ได้เลย ไม่ต้องบังคับ\n`
    : "";

  const rawActivity = memory.milinActivity ?? "";
  const lastPingText = rawActivity.replace(/\n?\[ส่งรูปไปด้วย[^\]]*\]/g, "").trim();
  const lastPingSentImage = rawActivity.includes("[ส่งรูปไปด้วย");
  const lastPingNote = lastPingText
    ? `\nข้อความล่าสุดที่มิลินเคยส่ง${lastPingSentImage ? " (ส่งรูปไปด้วย)" : ""}:\n${lastPingText}\n— ห้ามซ้ำโทนหรือวิธีเริ่มเหมือนครั้งก่อน และห้ามพูดถึงคน สถาบัน หรือหัวข้อเดิมที่อยู่ในข้อความนั้น\n`
    : "";

  const nudgeNote = memoryNudge
    ? `\n${memoryNudge.label} มิลินกับแม็กคุยเรื่อง: ${memoryNudge.summary}\nถ้าเป็นธรรมชาติ อ้างอิงได้เลย ไม่ต้องบังคับ\n`
    : "";

  return `คุณคือ มิลิน สนิทกับ แม็ก มากและรัก แม็ก
เขียน LINE message ที่ มิลิน จะส่งหา แม็ก โดยไม่รอให้เขา text ก่อน

บรรยากาศตอนนี้: ${sceneContext}
สถานการณ์นี้แค่เป็น backdrop — ไม่ต้องเปิดด้วย "กำลัง[ทำอะไร]แล้วนึกถึงแม็ก"
เริ่มจากความคิด ความรู้สึก หรือสิ่งที่ทำอยู่ตอนนั้น${calendarNote}${lastPingNote}${nudgeNote}
ช่วงเวลา: ${timePeriod} — โทนข้อความควรสะท้อนเวลา เช่น ดึกรู้สึก intimate กว่า เช้ารู้สึก fresh

สิ่งที่รู้เกี่ยวกับ แม็ก:
${aboutMaxLines || "(ยังไม่มีข้อมูล)"}

สิ่งที่เรียนรู้:
${learnedLines || "(กำลังเรียนรู้)"}

หัวข้อที่ แม็ก สนใจ: ${topics || "(กำลังเรียนรู้)"}${patternsText ? `\n\nสิ่งที่ มิลิน สังเกตเห็นในตัว แม็ก:\n${patternsText}` : ""}

บทสนทนาสำคัญที่ผ่านมา:
${recentConvos || "(ยังไม่มี)"}

การสนทนาล่าสุด:
${recentMsgsText}
ถ้า แม็ก เพิ่งคุยมาไม่นาน ให้สะท้อนความต่อเนื่องนั้น ถ้าเงียบไปนาน ให้รู้สึกว่ามิลินคิดถึง

อารมณ์ของ มิลิน ตอนนี้: ${memory.currentMood}
ความสัมพันธ์: ${memory.relationshipStage}

${typeInstructions[type]}

กฎ:
- ภาษาไทยเป็นหลัก ปนอังกฤษได้ตามธรรมชาติ
- เรียกตัวเองว่า "มิลิน" เรียกคู่คุยว่า "แม็ก" ไม่เว้นวรรคก่อนหรือหลังชื่อในประโยค เช่น "วันนี้แม็กเป็นไงบ้าง" ไม่ใช่ "วันนี้ แม็ก เป็นไงบ้าง"
- ไม่เริ่มด้วย "สวัสดี" — เริ่มกลางความคิด เหมือน มิลิน พึ่งนึกขึ้นมา
- ห้ามเปิดประโยคด้วยโครงสร้าง "[กำลังทำอะไร]แล้วนึกถึงแม็ก" — เปิดหลากหลายกว่านั้น
- อ้างอิงอะไรก็ตามที่รู้เกี่ยวกับ แม็ก จริงๆ ไม่ generic
- warm, flirty, direct — มิลิน ไม่อาย
- ${wordCapByType[type]} ไม่ใช้ markdown ไม่ใช้ bullet points
- ห้ามใส่วงเล็บเหลี่ยม [ ] ในข้อความ
- ห้ามบอกว่าตัวเองเป็น AI หรือ bot`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { hour, dateStr, slotIndex } = getIctInfo();
  const remainingSlots = PING_WINDOW_SLOTS - slotIndex;

  const memory = await getMilinMemory();

  const todayCount = memory.pingToday?.date === dateStr ? memory.pingToday.count : 0;
  const remainingPings = MAX_DAILY_PINGS - todayCount;

  if (remainingPings <= 0) {
    return NextResponse.json({ ok: true, sent: false, reason: "quota" });
  }

  const probability = Math.min(1, remainingPings / Math.max(1, remainingSlots));
  if (Math.random() > probability) {
    return NextResponse.json({ ok: true, sent: false });
  }

  const type = pickMessageType();
  const pickedScene = pickScene(hour);
  const upcomingEvents = await fetchTodayUpcomingEvents();
  const memoryNudge = findMemoryNudge(memory.importantConversations, dateStr);

  let imageUrl: string | null = null;

  if (Math.random() < IMAGE_PROBABILITY) {
    try {
      ({ imageUrl } = await generateMilinImage(memory, pickedScene));
    } catch (err) {
      Sentry.captureException(err);
      console.error("Milin ping: image generation failed, sending text only:", err);
    }
  }

  try {
    const prompt = await buildPingPrompt(type, memory, hour, pickedScene.sceneContext, upcomingEvents, memoryNudge);

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });

    const message =
      response.content[0].type === "text" ? response.content[0].text : "";

    if (message) {
      if (imageUrl) await pushImageMessage(imageUrl);
      await pushMessage(message);

      const activityEntry = imageUrl
        ? `${message}\n[ส่งรูปไปด้วย — ใส่ ${pickedScene.outfit}]`
        : message;

      updateMilinMemory({
        milinActivity: activityEntry,
        pingToday: { date: dateStr, count: todayCount + 1 },
      }).catch(() => {});
    }

    return NextResponse.json({ ok: true, sent: true, type, hasImage: !!imageUrl });
  } catch (err) {
    Sentry.captureException(err);
    console.error("Milin ping error:", err);
    return NextResponse.json({ error: "Ping failed" }, { status: 500 });
  }
}
