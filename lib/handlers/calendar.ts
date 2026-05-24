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

// ---------------------------------------------------------------------------
// Color theme — Max's personal Google Calendar color system
// Google Calendar colorId strings "1"–"11" map to named colors.
// ---------------------------------------------------------------------------

const COLOR_THEME_DESCRIPTION = `
Color assignment rules (pick the best match, return null if unsure):
- 7  (Peacock/ฟ้า): landmark events, milestones, special occasions, travel
- 6  (Tangerine/ส้ม): BNI, business networking
- 5  (Banana/เหลือง): clinic, doctor, dentist, hospital, medical appointments
- 9  (Basil/เขียวเข้ม): exercise, gym, running, swimming, health/fitness activities
- 11 (Graphite/เทา): factory, manufacturing, production
- 1  (Lavender/ม่วงอ่อน): personal relationships, family, friends
- 8  (Blueberry/น้ำเงิน): insurance, finance, banking, money
- 10 (Tomato/แดง): other work meetings, business, clients
- null: cannot confidently determine category
`.trim();

// Map Thai color names (and loose synonyms) the user might reply with → colorId.
// Used in handleColorReply when asking the user to pick a color.
const THAI_COLOR_TO_ID: Record<string, number> = {
  ม่วงอ่อน: 1, lavender: 1,
  เขียวอ่อน: 2, sage: 2,
  ม่วง: 3, grape: 3,
  ชมพู: 4, flamingo: 4, pink: 4,
  เหลือง: 5, banana: 5, yellow: 5,
  ส้ม: 6, tangerine: 6, orange: 6,
  ฟ้า: 7, peacock: 7,
  น้ำเงิน: 8, blueberry: 8,
  เขียวเข้ม: 9, basil: 9, เขียว: 9, green: 9,
  แดง: 10, tomato: 10, red: 10,
  เทา: 11, graphite: 11, gray: 11, grey: 11,
};

/** Resolve user's color reply text to a colorId, or null if unrecognised. */
function resolveColorFromText(text: string): number | null {
  const normalised = text.trim().toLowerCase();
  // Exact match first
  if (THAI_COLOR_TO_ID[normalised] !== undefined) return THAI_COLOR_TO_ID[normalised];
  // Substring match — user might say "เอาสีแดงเลย" or "ขอน้ำเงินนะ"
  for (const [key, id] of Object.entries(THAI_COLOR_TO_ID)) {
    if (normalised.includes(key)) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pending state helpers
// ---------------------------------------------------------------------------

/** True when user has a pending color-selection for a not-yet-created event. */
export function hasPendingColorReply(memory: MilinMemory): boolean {
  if (!memory.pendingAction) return false;
  if (memory.pendingAction.type !== "create") return false;
  return new Date() <= new Date(memory.pendingAction.expiresAt);
}

/** True when user replies "ยืนยัน" and has a valid non-expired delete/update pending. */
export function isPendingCalendarConfirm(
  text: string,
  memory: MilinMemory
): boolean {
  if (text.trim() !== "ยืนยัน") return false;
  if (!memory.pendingAction) return false;
  if (memory.pendingAction.type === "create") return false; // handled separately
  return new Date() <= new Date(memory.pendingAction.expiresAt);
}

// ---------------------------------------------------------------------------
// Intent detection — fast keyword check used as a routing hint
// (The real routing is via Haiku pre-classifier in the webhook; this is kept
// for legacy compatibility and may be removed later.)
// ---------------------------------------------------------------------------

const CALENDAR_KEYWORDS_RE =
  /นัด|ตาราง|ว่าง|เจอ|ประชุม|ยกเลิก|เลื่อน|พรุ่งนี้|อาทิตย์นี้|สัปดาห์หน้า|วันนี้มีอะไร/;

export function isCalendarMessage(text: string): boolean {
  return CALENDAR_KEYWORDS_RE.test(text);
}

// ---------------------------------------------------------------------------
// Haiku: parse Thai natural language → structured CalendarRequest
// ---------------------------------------------------------------------------

type CalendarRequest = {
  intent: "read" | "free_check" | "create" | "update" | "delete" | "suggest" | "unknown";
  title?: string;
  startISO?: string;
  endISO?: string;
  durationMin?: number;
  targetKeyword?: string;
  colorId?: number | null; // null = ask user; undefined = not applicable
};

async function parseCalendarRequest(text: string): Promise<CalendarRequest> {
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
      max_tokens: 350,
      messages: [
        {
          role: "user",
          content: `Today is ${todayStr} (${dayOfWeek}, Bangkok timezone UTC+7).
Parse this Thai calendar request and return JSON only:
"${text}"

{
  "intent": "read|free_check|create|update|delete|suggest",
  "title": "event title (create/update only, else null)",
  "startISO": "ISO datetime with +07:00 offset",
  "endISO": "ISO datetime with +07:00 offset",
  "durationMin": 60,
  "targetKeyword": "keyword to match existing event title (delete/update only, else null)",
  "colorId": null
}

Date/time rules:
- วันนี้=today, พรุ่งนี้=tomorrow, มะรืน=day after tomorrow
- ศุกร์นี้=coming Friday (if today>=Fri, use next week)
- อาทิตย์นี้/สัปดาห์นี้=Mon-Sun of current week
- สัปดาห์หน้า=next Mon-Sun
- 9 โมง/9 นาฬิกา=09:00, บ่ายโมง=13:00, บ่ายสาม=15:00, เที่ยง=12:00, ทุ่มหนึ่ง=19:00
- ครึ่งชั่วโมง=30min, 1 ชั่วโมง=60min
- read: asking what's on a day (no specific window) → startISO=day 00:00+07:00, endISO=day 23:59:59+07:00
- free_check: asking if a specific time window is free (ว่างไหมช่วง X-Y, มีนัดไหม X-Y) → startISO=exact start time, endISO=exact end time
- suggest: use the week/day range specified, durationMin from text
- All times in +07:00 offset

${COLOR_THEME_DESCRIPTION}
For create intent only: set colorId to the matching number, or null if unsure.
For all other intents: colorId must be null.`,
        },
      ],
    });

    const raw = res.content[0].type === "text" ? res.content[0].text : "{}";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch?.[0] || "{}") as CalendarRequest;
  } catch {
    return { intent: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format ISO datetime to HH:MM in ICT (UTC+7). */
function formatTime(iso: string): string {
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

/** Format ISO date to a readable Thai-ish label (e.g. "วันศุกร์ 30 พ.ค."). */
function formatDateLabel(iso: string): string {
  try {
    const ictMs = new Date(iso).getTime() + 7 * 60 * 60 * 1000;
    const d = new Date(ictMs);
    const dayNames = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัส", "ศุกร์", "เสาร์"];
    const monthNames = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
      "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
    return `วัน${dayNames[d.getUTCDay()]} ${d.getUTCDate()} ${monthNames[d.getUTCMonth()]}`;
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Main calendar handler — called when Haiku pre-classifier routes to "calendar". */
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
          return `${formatDateLabel(req.startISO)} ว่างทั้งวันเลยนะ ไม่มีนัดอะไร~`;
        }
        const lines = events
          .map((e) => `• ${formatTime(e.startISO)} — ${e.title}`)
          .join("\n");
        return `📅 ${formatDateLabel(req.startISO)}:\n${lines}`;
      }

      case "free_check": {
        if (!req.startISO || !req.endISO) {
          return "บอกช่วงเวลาที่อยากเช็คด้วยนะ เช่น 'พรุ่งนี้ 10-12 ว่างไหม'~";
        }
        // Fetch all events for that day, then check for overlap with the specified window
        const datePrefix = req.startISO.slice(0, 10);
        const dayStart = `${datePrefix}T00:00:00+07:00`;
        const dayEnd = `${datePrefix}T23:59:59+07:00`;
        const dayEvents = await getEvents(dayStart, dayEnd);

        const windowStart = new Date(req.startISO);
        const windowEnd = new Date(req.endISO);
        const conflicts = dayEvents.filter((e) => {
          const eStart = new Date(e.startISO);
          const eEnd = new Date(e.endISO);
          return eStart < windowEnd && eEnd > windowStart;
        });

        const windowLabel = `${formatTime(req.startISO)}–${formatTime(req.endISO)}`;
        const dateLabel = formatDateLabel(req.startISO);
        if (conflicts.length === 0) {
          return `ว่างเลยนะ ✅ ${dateLabel} ช่วง ${windowLabel} ไม่มีนัดอะไร~`;
        }
        const conflictLines = conflicts
          .map((e) => `• ${formatTime(e.startISO)}–${formatTime(e.endISO)} ${e.title}`)
          .join("\n");
        return `ไม่ว่างนะ ❌ ${dateLabel} ช่วง ${windowLabel} มีนัดอยู่:\n${conflictLines}`;
      }

      case "create": {
        if (!req.title || !req.startISO || !req.endISO) {
          return "บอกชื่อนัด วันที่ และเวลาด้วยนะ เช่น 'นัด BNI ศุกร์นี้ 9 โมง 1 ชั่วโมง'~";
        }

        const date = formatDateLabel(req.startISO);
        const time = formatTime(req.startISO);

        // Color known → create immediately
        if (req.colorId !== null && req.colorId !== undefined) {
          await createEvent(req.title, req.startISO, req.endISO, undefined, req.colorId);
          return `โอเคนะ จัดให้เลย 📅 ${req.title} ${date} ${time} บันทึกแล้วค่ะ~`;
        }

        // Color unknown → store pendingAction and ask
        const pendingAction: PendingAction = {
          type: "create",
          eventTitle: req.title,
          startISO: req.startISO,
          endISO: req.endISO,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        };
        await updateMilinMemory({ pendingAction });
        return `จะสร้าง '${req.title}' ${date} ${time} นะ~\nนัดนี้อยู่หมวดไหนคะ บอกสีได้เลย 🎨\n(ม่วงอ่อน/เขียวเข้ม/ฟ้า/เหลือง/ส้ม/เทา/น้ำเงิน/แดง/ม่วง/ชมพู)`;
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

/**
 * Called when user sends a color reply to a pending "create" action.
 * Resolves the color name → colorId, creates the event, clears pending state.
 */
export async function handleColorReply(
  text: string,
  memory: MilinMemory
): Promise<string> {
  const pending = memory.pendingAction!;

  // Expiry double-check — can't be too careful
  if (new Date() > new Date(pending.expiresAt)) {
    await updateMilinMemory({ pendingAction: undefined });
    // Treat as a fresh message by falling through — return empty so caller handles it
    return "";
  }

  const colorId = resolveColorFromText(text);

  if (colorId === null) {
    // Unrecognised color — ask again, don't clear pending (still valid)
    return "ไม่แน่ใจสีที่บอกนะ ลองพิมพ์ใหม่ได้มั้ยคะ เช่น แดง เหลือง ส้ม ฟ้า น้ำเงิน เขียวเข้ม เทา ม่วงอ่อน ม่วง ชมพู~";
  }

  try {
    await createEvent(
      pending.eventTitle,
      pending.startISO!,
      pending.endISO!,
      pending.description,
      colorId
    );
    await updateMilinMemory({ pendingAction: undefined });
    const date = formatDateLabel(pending.startISO!);
    const time = formatTime(pending.startISO!);
    return `โอเคนะ จัดให้เลย 📅 ${pending.eventTitle} ${date} ${time} บันทึกแล้วค่ะ~`;
  } catch (err) {
    console.error("handleColorReply createEvent error:", err);
    await updateMilinMemory({ pendingAction: undefined });
    return "มีบางอย่างผิดพลาดตอนสร้างนัด ลองบอกใหม่ได้เลยนะ~";
  }
}

/**
 * Called when user replies "ยืนยัน" and has a valid non-expired delete/update pending.
 * Returns "" if pending is expired (caller should fall through to handleConversation).
 */
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
      if (!pending.eventId) {
        await updateMilinMemory({ pendingAction: undefined });
        return "ไม่เจอ ID ของนัดที่จะลบ ลองบอกใหม่ได้เลยนะ~";
      }
      await deleteEvent(pending.eventId);
      await updateMilinMemory({ pendingAction: undefined });
      return `ลบ '${pending.eventTitle}' เรียบร้อยแล้วนะ~ 🗑️`;
    }

    if (pending.type === "update") {
      if (!pending.eventId) {
        await updateMilinMemory({ pendingAction: undefined });
        return "ไม่เจอ ID ของนัดที่จะอัพเดต ลองบอกใหม่ได้เลยนะ~";
      }
      await updateEvent(pending.eventId, pending.changes || {});
      await updateMilinMemory({ pendingAction: undefined });
      return `อัพเดต '${pending.eventTitle}' เรียบร้อยแล้วนะ~ ✅`;
    }

    // "create" type shouldn't reach here (handled by handleColorReply), but guard anyway
    await updateMilinMemory({ pendingAction: undefined });
    return "";
  } catch (err) {
    console.error("handleCalendarConfirm error:", err);
    await updateMilinMemory({ pendingAction: undefined });
    return "มีบางอย่างผิดพลาดตอนดำเนินการ ลองบอกใหม่ได้เลยนะ~";
  }
}
