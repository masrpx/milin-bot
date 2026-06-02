import Anthropic from "@anthropic-ai/sdk";
import { type MilinMemory, updateMilinMemory } from "../vault";
import {
  getInbox,
  saveInbox,
  getNDN,
  saveNDN,
  getNVDN,
  saveNVDN,
  generateTodoId,
  NDN_CAP,
  type InboxItem,
  type NDNItem,
  type NVDNItem,
} from "../todo";
import { parseCalendarRequest, formatTime, formatDateLabel } from "./calendar";
import { createEvent } from "../calendar";

const client = new Anthropic({ maxRetries: 4 });

// ---------------------------------------------------------------------------
// Pending state helper
// ---------------------------------------------------------------------------

export function isPendingTodoClassify(memory: MilinMemory): boolean {
  if (!memory.pendingAction) return false;
  if (memory.pendingAction.type !== "todo_classify") return false;
  return new Date() <= new Date(memory.pendingAction.expiresAt);
}

// ---------------------------------------------------------------------------
// Inbox query — "ขอดู inbox" / "inbox"
// ---------------------------------------------------------------------------

export async function handleInboxQuery(): Promise<string> {
  const { items } = await getInbox();
  if (items.length === 0) return "inbox ว่างอยู่นะ ไม่มีรายการรอ~";
  const lines = items.map((item, i) => `${i + 1}. ${item.text}`).join("\n");
  return `📥 inbox (${items.length} รายการ):\n${lines}\n\nมิลิน จะถามตอน 21:00 ว่าจะจัดการยังไง`;
}

// ---------------------------------------------------------------------------
// Haiku parser — Max's classification reply → structured actions
// ---------------------------------------------------------------------------

type ClassifyAction = {
  index: number;
  action: "ndn" | "nvdn" | "calendar" | "delete";
  timePhrase?: string;
};

async function parseClassifyReply(
  reply: string,
  items: InboxItem[]
): Promise<ClassifyAction[]> {
  const itemsList = items.map((item, i) => `${i + 1}. ${item.text}`).join("\n");
  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `Inbox items:
${itemsList}

User's classification reply: "${reply}"

Parse into JSON array. Each object: {"index": N, "action": "ndn"|"nvdn"|"calendar"|"delete", "timePhrase": "..."}
- timePhrase only for "calendar" action (e.g. "พฤหัส 14.00", "พรุ่งนี้ 9 โมง")
- If multiple indices share the same action (e.g. "1,2 delete" or "1 2 ndn"), expand into one object per index
- "del" means "delete"
- Only include items the user mentioned
- Return JSON array only, no explanation`,
        },
      ],
    });
    const raw = res.content[0].type === "text" ? res.content[0].text : "[]";
    const parsed = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || "[]") as (Omit<ClassifyAction, "action"> & { action: string })[];
    return parsed
      .map((a) => ({ ...a, action: a.action === "del" ? "delete" : a.action } as ClassifyAction))
      .filter(
        (a) => a.index >= 1 && a.index <= items.length && ["ndn", "nvdn", "calendar", "delete"].includes(a.action)
      );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main classify handler
// ---------------------------------------------------------------------------

export async function handleTodoClassify(
  text: string,
  memory: MilinMemory
): Promise<string> {
  const pending = memory.pendingAction!;

  if (new Date() > new Date(pending.expiresAt)) {
    await updateMilinMemory({ pendingAction: undefined });
    return "";
  }

  const { items: allInbox, sha: inboxSha } = await getInbox();

  // Resolve the snapshot: ordered list of items that were in the ping
  const snapshot = pending.inboxSnapshot ?? [];
  const pingItems = snapshot.length > 0
    ? snapshot.map((id) => allInbox.find((i) => i.id === id)).filter(Boolean) as InboxItem[]
    : allInbox;

  if (pingItems.length === 0) {
    await updateMilinMemory({ pendingAction: undefined });
    return "ไม่มีรายการใน inbox แล้วนะ~";
  }

  const actions = await parseClassifyReply(text, pingItems);
  if (actions.length === 0) {
    return "ไม่แน่ใจว่าต้องการอะไร ลองพิมพ์ใหม่ เช่น '1 ndn, 2 nvdn, 3 cal พฤหัส 14.00'~";
  }

  const { items: ndnItems, sha: ndnSha } = await getNDN();
  const { items: nvdnItems, sha: nvdnSha } = await getNVDN();
  const processedIds = new Set<string>();
  const summaryLines: string[] = [];
  const newNDN: NDNItem[] = [...ndnItems];
  const newNVDN: NVDNItem[] = [...nvdnItems];
  let ndnDirty = false;
  let nvdnDirty = false;
  let ndnOverflow = 0;

  for (const action of actions) {
    const item = pingItems[action.index - 1];
    if (!item) continue;
    processedIds.add(item.id);

    switch (action.action) {
      case "ndn": {
        if (newNDN.length >= NDN_CAP) {
          ndnOverflow++;
          summaryLines.push(`• ${item.text} → ⚠️ NDN เต็ม (ข้ามไว้ใน inbox)`);
          processedIds.delete(item.id); // keep in inbox
        } else {
          newNDN.push({ id: item.id, text: item.text, addedAt: new Date().toISOString() });
          summaryLines.push(`• ${item.text} → NDN`);
          ndnDirty = true;
        }
        break;
      }
      case "nvdn": {
        newNVDN.push({ id: item.id, text: item.text, archivedAt: new Date().toISOString() });
        summaryLines.push(`• ${item.text} → NVDN`);
        nvdnDirty = true;
        break;
      }
      case "calendar": {
        try {
          const req = await parseCalendarRequest(`${item.text} ${action.timePhrase ?? ""}`);
          if (req.intent === "create" && req.startISO && req.endISO) {
            await createEvent(req.title || item.text, req.startISO, req.endISO);
            summaryLines.push(`• ${item.text} → 📅 ${formatDateLabel(req.startISO)} ${formatTime(req.startISO)}`);
          } else {
            summaryLines.push(`• ${item.text} → ⚠️ ไม่แน่ใจเวลา เก็บไว้ใน inbox ก่อน`);
            processedIds.delete(item.id);
          }
        } catch {
          summaryLines.push(`• ${item.text} → ⚠️ สร้างนัดไม่ได้ เก็บไว้ใน inbox`);
          processedIds.delete(item.id);
        }
        break;
      }
      case "delete": {
        summaryLines.push(`• ${item.text} → ลบแล้ว 🗑️`);
        break;
      }
    }
  }

  // Remove processed items from inbox
  const remainingInbox = allInbox.filter((i) => !processedIds.has(i.id));

  const writes: Promise<void>[] = [saveInbox(remainingInbox, inboxSha)];
  if (ndnDirty) writes.push(saveNDN(newNDN, ndnSha));
  if (nvdnDirty) writes.push(saveNVDN(newNVDN, nvdnSha));
  await Promise.all(writes);
  // Swallow 409 conflicts — data writes already committed; a stale pendingAction
  // will self-clear on the next message when inbox is found empty.
  await updateMilinMemory({ pendingAction: undefined }).catch(() => {});

  const remaining = remainingInbox.length;
  const footer = remaining > 0
    ? `\n(ยังมี ${remaining} รายการใน inbox)`
    : "\ninbox ว่างแล้ว ✨";
  const overflowNote = ndnOverflow > 0 ? `\nNDN เต็ม — เคลียร์ก่อนนะ พิมพ์ ndn` : "";

  return `เคลียร์แล้ว ${processedIds.size} รายการ ✓\n${summaryLines.join("\n")}${overflowNote}${footer}`;
}
