import { type MilinMemory, updateMilinMemory } from "../vault";
import { getNVDN, saveNVDN, type NVDNItem } from "../todo";

const PAGE_SIZE = 10;
const PAGINATE_TTL_MS = 10 * 60 * 1000; // 10 min

// ---------------------------------------------------------------------------
// Pending state helper
// ---------------------------------------------------------------------------

export function isPendingNVDNMore(text: string, memory: MilinMemory): boolean {
  if (text.trim().toLowerCase() !== "more") return false;
  if (!memory.pendingAction) return false;
  if (memory.pendingAction.type !== "nvdn_paginate") return false;
  return new Date() <= new Date(memory.pendingAction.expiresAt);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatPage(matches: NVDNItem[], page: number, totalMatches: number, keyword: string): string {
  const start = page * PAGE_SIZE;
  const pageItems = matches.slice(start, start + PAGE_SIZE);
  const hasMore = start + PAGE_SIZE < totalMatches;
  const keywordLabel = keyword ? ` (ค้นหา: "${keyword}")` : "";
  const header = `📦 NVDN${keywordLabel} — แสดง ${start + 1}–${start + pageItems.length} จาก ${totalMatches}:`;
  const lines = pageItems.map((item, i) => `${start + i + 1}. ${item.text}`).join("\n");
  const footer = hasMore ? "\nพิมพ์ more เพื่อดูต่อ" : "\n(หมดแล้ว)";
  return `${header}\n${lines}${footer}`;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleNVDN(text: string, memory: MilinMemory): Promise<string> {
  const trimmed = text.trim();

  // "more" — next page
  if (trimmed.toLowerCase() === "more" && memory.pendingAction?.type === "nvdn_paginate") {
    const { keyword = "", page = 0 } = memory.pendingAction;
    const nextPage = page + 1;
    return showPage(keyword, nextPage, memory);
  }

  // "milin nvdn ลบ N" or "nvdn ลบ N"
  const deleteMatch = trimmed.match(/^(?:milin\s+)?nvdn\s+ลบ\s+(\d+)$/i);
  if (deleteMatch) return handleNVDNDelete(parseInt(deleteMatch[1], 10));

  // "milin nvdn [keyword]" or "nvdn [keyword]"
  const keyword = trimmed.replace(/^(milin\s+)?nvdn\s*/i, "").trim();
  return showPage(keyword, 0, memory);
}

async function showPage(keyword: string, page: number, memory: MilinMemory): Promise<string> {
  const { items } = await getNVDN();

  const matches = keyword
    ? items.filter((item) => item.text.toLowerCase().includes(keyword.toLowerCase()))
    : items;

  if (matches.length === 0) {
    const emptyMsg = keyword
      ? `ไม่เจอ NVDN ที่เกี่ยวกับ '${keyword}' เลย~`
      : "ไม่มี NVDN ตอนนี้เลย~";
    await updateMilinMemory({ pendingAction: undefined });
    return emptyMsg;
  }

  const hasMore = (page + 1) * PAGE_SIZE < matches.length;
  if (hasMore) {
    await updateMilinMemory({
      pendingAction: {
        type: "nvdn_paginate",
        keyword,
        page,
        eventTitle: "",
        expiresAt: new Date(Date.now() + PAGINATE_TTL_MS).toISOString(),
      },
    });
  } else {
    // Last page — clear pending so "more" doesn't linger
    if (memory.pendingAction?.type === "nvdn_paginate") {
      await updateMilinMemory({ pendingAction: undefined });
    }
  }

  return formatPage(matches, page, matches.length, keyword);
}

// ---------------------------------------------------------------------------
// Delete from NVDN: "milin nvdn ลบ N" or "nvdn ลบ N"
// ---------------------------------------------------------------------------

export async function handleNVDNDelete(indexOneBased: number): Promise<string> {
  const { items, sha } = await getNVDN();
  const index = indexOneBased - 1;
  if (index < 0 || index >= items.length) return "ไม่เจอ item นั้น ลองดู NVDN ใหม่นะ~";
  const [removed] = items.splice(index, 1);
  await saveNVDN(items, sha);
  return `ลบ '${removed.text}' ออกจาก NVDN แล้วนะ~ 🗑️`;
}
