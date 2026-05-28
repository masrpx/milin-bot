import { getEvents, createEvent, deleteEvent } from "../calendar";
import { type MilinMemory, updateMilinMemory } from "../vault";
import {
  getNDN,
  getNVDN,
  saveNDN,
  saveNVDN,
  generateTodoId,
  type NDNItem,
} from "../todo";
import {
  parseCalendarRequest,
  formatTime,
  formatDateLabel,
} from "./calendar";

// ---------------------------------------------------------------------------
// Pending state helpers
// ---------------------------------------------------------------------------

export function isPendingRescheduleConfirm(
  text: string,
  memory: MilinMemory
): boolean {
  if (text.trim() !== "ยืนยัน") return false;
  if (!memory.pendingAction) return false;
  if (memory.pendingAction.type !== "reschedule") return false;
  return new Date() <= new Date(memory.pendingAction.expiresAt);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

async function listNDN(): Promise<string> {
  const { items } = await getNDN();
  if (items.length === 0) return "ไม่มี NDN ตอนนี้ 🎉";
  const lines = items
    .map((item, i) => {
      const age = daysSince(item.addedAt);
      const ageLabel = age === 0 ? "วันนี้" : `${age} วันที่แล้ว`;
      return `${i + 1}. ${item.text} (${ageLabel})`;
    })
    .join("\n");
  return `📋 NDN (${items.length}/${10}):\n${lines}\n\nndn N ลบ / ndn N nvdn / ndn N [เวลา]`;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

async function deleteNDNItem(index: number): Promise<string> {
  const { items, sha } = await getNDN();
  if (index < 0 || index >= items.length) return "ไม่เจอ item นั้น ลองพิมพ์ ndn เพื่อดูก่อนนะ";
  const [removed] = items.splice(index, 1);
  await saveNDN(items, sha);
  return `ลบ '${removed.text}' ออกแล้วนะ~ 🗑️`;
}

// ---------------------------------------------------------------------------
// Move NDN → NVDN
// ---------------------------------------------------------------------------

async function moveToNVDN(index: number): Promise<string> {
  const { items: ndnItems, sha: ndnSha } = await getNDN();
  if (index < 0 || index >= ndnItems.length) return "ไม่เจอ item นั้น ลองพิมพ์ ndn เพื่อดูก่อนนะ";

  const [item] = ndnItems.splice(index, 1);
  const { items: nvdnItems, sha: nvdnSha } = await getNVDN();
  const nvdnItem = { id: item.id, text: item.text, archivedAt: new Date().toISOString() };

  await Promise.all([
    saveNDN(ndnItems, ndnSha),
    saveNVDN([...nvdnItems, nvdnItem], nvdnSha),
  ]);
  return `ย้าย '${item.text}' ไป NVDN แล้วนะ~ 📦`;
}

// ---------------------------------------------------------------------------
// Schedule NDN item → Google Calendar (no color-pick, immediate)
// ---------------------------------------------------------------------------

async function scheduleNDNItem(item: NDNItem, allItems: NDNItem[], ndnSha: string | undefined, timePhrase: string): Promise<string> {
  const req = await parseCalendarRequest(`${item.text} ${timePhrase}`);
  if (req.intent !== "create" || !req.startISO || !req.endISO) {
    return `ไม่แน่ใจเวลาที่บอกนะ ลองพิมพ์ใหม่ เช่น 'ndn 1 พฤหัส 14.00'~`;
  }
  await createEvent(req.title || item.text, req.startISO, req.endISO);
  const remaining = allItems.filter((i) => i.id !== item.id);
  await saveNDN(remaining, ndnSha);
  const date = formatDateLabel(req.startISO);
  const time = formatTime(req.startISO);
  return `จัดให้เลย ✅ '${item.text}' ${date} ${time} — ลบออกจาก NDN แล้วนะ~`;
}

// ---------------------------------------------------------------------------
// Reschedule: find calendar event → delete from calendar → add to NDN
// ---------------------------------------------------------------------------

async function initiateReschedule(keyword: string, memory: MilinMemory): Promise<string> {
  const ictOffset = 7 * 60 * 60 * 1000;
  const now = new Date(Date.now() + ictOffset);
  const dateStr = now.toISOString().split("T")[0];
  const start = `${dateStr}T00:00:00+07:00`;
  const futureDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const futureDateStr = futureDate.toISOString().split("T")[0];
  const end = `${futureDateStr}T23:59:59+07:00`;

  let events;
  try {
    events = await getEvents(start, end);
  } catch {
    return "เข้า Google Calendar ไม่ได้ตอนนี้ ลองใหม่นะ~";
  }

  const target = events.find((e) =>
    e.title.toLowerCase().includes(keyword.toLowerCase())
  );
  if (!target) {
    return `ไม่เจอนัด '${keyword}' ใน 7 วันข้างหน้า ลองบอกชื่อให้ชัดขึ้นนะ~`;
  }

  await updateMilinMemory({
    pendingAction: {
      type: "reschedule",
      eventId: target.id,
      eventTitle: target.title,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    },
  });
  const date = formatDateLabel(target.startISO);
  const time = formatTime(target.startISO);
  return `จะย้าย '${target.title}' (${date} ${time}) กลับ NDN ใช่มั้ยคะ? ตอบ 'ยืนยัน' นะ~`;
}

export async function confirmReschedule(memory: MilinMemory): Promise<string> {
  const pending = memory.pendingAction!;
  if (new Date() > new Date(pending.expiresAt)) {
    await updateMilinMemory({ pendingAction: undefined });
    return "";
  }
  try {
    await deleteEvent(pending.eventId!);
    const { items: ndnItems, sha: ndnSha } = await getNDN();
    const newItem: NDNItem = {
      id: generateTodoId(),
      text: pending.eventTitle,
      addedAt: new Date().toISOString(),
    };
    if (ndnItems.length < 10) {
      await saveNDN([...ndnItems, newItem], ndnSha);
    }
    await updateMilinMemory({ pendingAction: undefined });
    const ndnWarning = ndnItems.length >= 10 ? "\n(NDN เต็ม เลยไม่ได้ add — เคลียร์ก่อนนะ)" : "";
    return `ย้าย '${pending.eventTitle}' กลับ NDN แล้วนะ~ ✅${ndnWarning}`;
  } catch (err) {
    console.error("confirmReschedule error:", err);
    await updateMilinMemory({ pendingAction: undefined });
    return "มีบางอย่างผิดพลาด ลองใหม่นะ~";
  }
}

// ---------------------------------------------------------------------------
// Main handler — routes by text pattern
// ---------------------------------------------------------------------------

export async function handleNDN(text: string, memory: MilinMemory): Promise<string> {
  const trimmed = text.trim();

  if (/^reschedule\s+/i.test(trimmed)) {
    const keyword = trimmed.replace(/^reschedule\s+/i, "").trim();
    return initiateReschedule(keyword, memory);
  }

  // "ndn" alone → list
  if (/^ndn$/i.test(trimmed)) return listNDN();

  // "ndn N [action]"
  const match = trimmed.match(/^ndn\s+(\d+)\s*(.*)/i);
  if (!match) return listNDN();

  const oneIndexed = parseInt(match[1], 10);
  const zeroIndexed = oneIndexed - 1;
  const actionRaw = match[2].trim();
  const action = actionRaw.toLowerCase();

  if (action === "ลบ" || action === "del" || action === "delete") {
    return deleteNDNItem(zeroIndexed);
  }
  if (action === "nvdn") {
    return moveToNVDN(zeroIndexed);
  }
  if (action === "") {
    return listNDN();
  }

  // Treat remaining text as a time phrase → schedule to calendar
  const { items, sha } = await getNDN();
  const item = items[zeroIndexed];
  if (!item) return "ไม่เจอ item นั้น ลองพิมพ์ ndn เพื่อดูก่อนนะ";
  return scheduleNDNItem(item, items, sha, actionRaw);
}
