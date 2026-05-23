import Anthropic from "@anthropic-ai/sdk";
import {
  getEvents,
  createEvent,
  deleteEvent,
  updateEvent,
  findFreeSlots,
} from "../calendar";
import { type MilinMemory, type PendingAction, updateMilinMemory } from "../vault";

const client = new Anthropic();

// --- Intent detection ---

const CALENDAR_KEYWORDS_RE =
  /นัด|ตาราง|ว่าง|เจอ|ประชุม|ยกเลิก|เลื่อน|พรุ่งนี้|อาทิตย์นี้|สัปดาห์หน้า|วันนี้มีอะไร/;

export function isCalendarMessage(text: string): boolean {
  return CALENDAR_KEYWORDS_RE.test(text);
}

// Check if the message is a confirmation for a pending action
export function isPendingCalendarConfirm(
  text: string,
  memory: MilinMemory
): boolean {
  if (text.trim() !== "ยืนยัน") return false;
  if (!memory.pendingAction) return false;
  if (new Date() > new Date(memory.pendingAction.expiresAt)) return false;
  return true;
}

// --- Date/time parsing via Haiku ---

type CalendarRequest = {
  intent: "read" | "create" | "update" | "delete" | "suggest" | "unknown";
  title?: string;
  startISO?: string;
  endISO?: string;
  durationMin?: number;
  targetKeyword?: string;
};

async function parseCalendarRequest(text: string): Promise<CalendarRequest> {
  // Current time in ICT
  const nowUTC = new Date();
  const ictOffset = 7 * 60 * 60 * 1000;
  const ictNow = new Date(nowUTC.getTime() + ictOffset);
  const todayStr = ictNow.toISOString().split("T")[0];
  const dayOfWeek = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัส", "ศุกร์", "เสาร์"][
    ictNow.getUTCDay()
  ];

  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `Today is ${todayStr} (${dayOfWeek}, Bangkok timezone UTC+7).
Parse this Thai calendar request and return JSON only:
"${text}"

{
  "intent": "read|create|update|delete|suggest",
  "title": "event title (create/update only, else null)",
  "startISO": "ISO datetime with +07:00 offset",
  "endISO": "ISO datetime with +07:00 offset",
  "durationMin": 60,
  "targetKeyword": "keyword to match existing event title (delete/update only, else null)"
}

Rules:
- วันนี้=today, พรุ่งนี้=tomorrow, มะรืน=day after tomorrow
- ศุกร์นี้=coming Friday (if today>=Fri, use next week)
- อาทิตย์นี้/สัปดาห์นี้=Mon-Sun of current week
- สัปดาห์หน้า=next Mon-Sun
- 9 โมง/9 นาฬิกา=09:00, บ่ายโมง=13:00, บ่ายสาม=15:00, เที่ยง=12:00, ทุ่มหนึ่ง=19:00
- ครึ่งชั่วโมง=30min, 1 ชั่วโมง=60min
- read: startISO=day 00:00+07:00, endISO=day 23:59:59+07:00
- suggest: use the week/day range specified, durationMin from text
- All times in +07:00 offset`,
        },
      ],
    });

    const raw =
      res.content[0].type === "text" ? res.content[0].text : "{}";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch?.[0] || "{}") as CalendarRequest;
  } catch {
    return { intent: "unknown" };
  }
}

// --- Formatting helpers ---

/** Format ISO datetime to HH:MM in ICT */
function formatTime(iso: string): string {
  try {
    const utcMs = new Date(iso).getTime();
    const ictMs = utcMs + 7 * 60 * 60 * 1000;
    const d = new Date(ictMs);
    const h = d.getUTCHours().toString().padStart(2, "0");
    const m = d.getUTCMinutes().toString().padStart(2, "0");
    return `${h}:${m}`;
  } catch {
    return iso;
  }
}

/** Format ISO date to Thai label (วันนี้, พรุ่งนี้, or วัน/dd/mm) */
function formatDateLabel(iso: string): string {
  try {
    const ictOffset = 7 * 60 * 60 * 1000;
    const ictMs = new Date(iso).getTime() + ictOffset;
    const ictDate = new Date(ictMs);
    const dateStr = ictDate.toISOString().split("T")[0];

    const nowICT = new Date(Date.now() + ictOffset);
    const todayStr = nowICT.toISOString().split("T")[0];
    const tomorrowStr = new Date(nowICT.getTime() + 86400000)
      .toISOString()
      .split("T")[0];

    if (dateStr === todayStr) return "วันนี้";
    if (dateStr === tomorrowStr) return "พรุ่งนี้";

    const days = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัส", "ศุกร์", "เสาร์"];
    return `วัน${days[ictDate.getUTCDay()]} ${ictDate.getUTCDate()}/${ictDate.getUTCMonth() + 1}`;
  } catch {
    return iso;
  }
}

// --- Main handlers ---

export async function handleCalendar(
  text: string,
  _memory: MilinMemory
): Promise<string> {
  try {
    const req = await parseCalendarRequest(text);

    switch (req.intent) {
      case "read": {
        if (!req.startISO || !req.endISO) {
          return "บอกให้ชัดขึ้นได้มั้ย วันไหนอยากดูตาราง~";
        }
        const events = await getEvents(req.startISO, req.endISO);
        if (events.length === 0) {
          const label = formatDateLabel(req.startISO);
          return `${label} ว่างทั้งวันเลยนะ ไม่มีนัดอะไร~`;
        }
        const lines = events
          .map((e) => `• ${formatTime(e.startISO)} — ${e.title}`)
          .join("\n");
        return `📅 ${formatDateLabel(req.startISO)}:\n${lines}`;
      }

      case "create": {
        if (!req.title || !req.startISO || !req.endISO) {
          return "บอกชื่อนัด วันที่ และเวลาด้วยนะ เช่น 'นัด BNI ศุกร์นี้ 9 โมง 1 ชั่วโมง'~";
        }
        await createEvent(req.title, req.startISO, req.endISO);
        const date = formatDateLabel(req.startISO);
        const time = formatTime(req.startISO);
        return `โอเคนะ จัดให้เลย 📅 ${req.title} ${date} ${time} บันทึกแล้วค่ะ~`;
      }

      case "delete": {
        if (!req.startISO || !req.endISO) {
          return "บอกวันที่นัดที่อยากยกเลิกด้วยนะ~";
        }
        const events = await getEvents(req.startISO, req.endISO);
        const target = req.targetKeyword
          ? events.find((e) =>
              e.title.toLowerCase().includes(req.targetKeyword!.toLowerCase())
            )
          : events[0];

        if (!target) {
          return "ไม่เจอนัดที่ว่าเลยนะ ลองบอกชื่อให้ชัดขึ้นได้มั้ย~";
        }

        const pendingAction: PendingAction = {
          type: "delete",
          eventId: target.id,
          eventTitle: target.title,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        };
        await updateMilinMemory({ pendingAction });
        return `จะลบ '${target.title}' ใช่มั้ยคะ? ตอบ 'ยืนยัน' ถึงจะลบนะ~`;
      }

      case "update": {
        if (!req.startISO || !req.endISO) {
          return "บอกวันที่นัดที่อยากเลื่อนด้วยนะ~";
        }
        const events = await getEvents(req.startISO, req.endISO);
        const target = req.targetKeyword
          ? events.find((e) =>
              e.title.toLowerCase().includes(req.targetKeyword!.toLowerCase())
            )
          : events[0];

        if (!target) {
          return "ไม่เจอนัดที่ว่าเลยนะ ลองบอกชื่อให้ชัดขึ้นได้มั้ย~";
        }

        const pendingAction: PendingAction = {
          type: "update",
          eventId: target.id,
          eventTitle: target.title,
          changes: {
            ...(req.startISO ? { startISO: req.startISO } : {}),
            ...(req.endISO ? { endISO: req.endISO } : {}),
          },
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        };
        await updateMilinMemory({ pendingAction });
        const newTime = formatTime(req.startISO);
        const newDate = formatDateLabel(req.startISO);
        return `จะเลื่อน '${target.title}' ไปเป็น ${newDate} ${newTime} ใช่มั้ยคะ? ตอบ 'ยืนยัน' ถึงจะเลื่อนนะ~`;
      }

      case "suggest": {
        if (!req.startISO || !req.endISO) {
          return "บอกช่วงเวลาที่อยากหาเวลาว่างด้วยนะ~";
        }
        const durationMin = req.durationMin || 60;
        const slots = await findFreeSlots(req.startISO, req.endISO, durationMin);
        if (slots.length === 0) {
          return "ดูแล้วไม่มีช่วงว่างพอเลยอ่ะ ลองวันอื่นดูมั้ย~";
        }
        const slotLines = slots
          .map((s) => `• ${formatTime(s.startISO)} – ${formatTime(s.endISO)}`)
          .join("\n");
        return `ดูแล้วมีว่างช่วงนี้ค่ะ:\n${slotLines}`;
      }

      default:
        return "บอกให้ชัดขึ้นได้มั้ยนะ ว่าอยากดูนัด สร้างนัด ยกเลิก หรือหาเวลาว่าง~";
    }
  } catch (err) {
    console.error("handleCalendar error:", err);
    return "ขอโทษนะ เข้าถึง Google Calendar ไม่ได้ตอนนี้ ลองใหม่อีกทีได้มั้ย~";
  }
}

/** Called when user replies "ยืนยัน" and there's a valid, non-expired pendingAction */
export async function handleCalendarConfirm(
  memory: MilinMemory
): Promise<string> {
  const pending = memory.pendingAction!;

  // Double-check expiry
  if (new Date() > new Date(pending.expiresAt)) {
    await updateMilinMemory({ pendingAction: undefined });
    return "";
  }

  try {
    if (pending.type === "delete") {
      await deleteEvent(pending.eventId);
      await updateMilinMemory({ pendingAction: undefined });
      return `ลบ '${pending.eventTitle}' เรียบร้อยแล้วนะ~ 🗑️`;
    }

    if (pending.type === "update") {
      await updateEvent(pending.eventId, pending.changes || {});
      await updateMilinMemory({ pendingAction: undefined });
      return `อัพเดต '${pending.eventTitle}' เรียบร้อยแล้วนะ~ ✅`;
    }

    return "";
  } catch (err) {
    console.error("handleCalendarConfirm error:", err);
    await updateMilinMemory({ pendingAction: undefined });
    return "มีบางอย่างผิดพลาดตอนดำเนินการ ลองบอกใหม่ได้เลยนะ~";
  }
}
