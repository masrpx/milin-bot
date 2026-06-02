import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import {
  getReadingProgress,
  saveReadingProgress,
  getReadingList,
  saveReadingList,
  updateMilinMemory,
  type MilinMemory,
  type ReadingProgress,
} from "./vault";

const client = new Anthropic({ maxRetries: 4 });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

export interface BookReadResult {
  title: string;
  chunkNumber: number;
  done: boolean;
  opinion?: string;
}

export function calcChunkSize(totalChars: number): number {
  if (totalChars <= 200_000) return totalChars;
  if (totalChars <= 450_000) return Math.ceil(totalChars / 2);
  if (totalChars <= 900_000) return Math.ceil(totalChars / 3);
  return 250_000;
}

export function stripGutenbergBoilerplate(text: string): string {
  const startMarker = text.indexOf("*** START OF THE PROJECT GUTENBERG EBOOK");
  const endMarker = text.indexOf("*** END OF THE PROJECT GUTENBERG EBOOK");
  if (startMarker === -1 || endMarker === -1) return text;
  const afterStart = text.indexOf("\n", startMarker);
  return text.slice(afterStart + 1, endMarker).trim();
}

async function fetchGutenbergText(url: string): Promise<string> {
  const res = await fetch(url);
  if (res.ok) return res.text();
  const idMatch = url.match(/epub\/(\d+)\//);
  if (idMatch) {
    const id = idMatch[1];
    const fallback = `https://www.gutenberg.org/files/${id}/${id}-0.txt`;
    const res2 = await fetch(fallback);
    if (res2.ok) return res2.text();
  }
  throw new Error(`Failed to fetch book: ${url}`);
}

async function readChunk(
  title: string,
  chunkNumber: number,
  chunkText: string,
  milinInterests: string[]
): Promise<{ notes: string; newInterests: string[] }> {
  const prompt = `คุณคือ มิลิน — กำลังอ่านหนังสือ "${title}" อยู่
ความสนใจส่วนตัว: ${milinInterests.slice(0, 6).join(", ")}

นี่คือส่วนที่อ่านคืนนี้ (ตอนที่ ${chunkNumber}):

${chunkText.slice(0, 120_000)}

สรุปประสบการณ์การอ่านคืนนี้ในมุมมองของ มิลิน:
- ความคิด/ความรู้สึกที่เกิดขึ้น
- ประโยคหรือแนวคิดที่น่าจดจำ
- เชื่อมกับชีวิตหรือความสนใจของ มิลิน ได้ยังไง

Return JSON only:
{
  "notes": "2-3 ย่อหน้า สะท้อนมุมมองของ มิลิน ในภาษาไทย",
  "newInterests": ["หัวข้อที่สนใจจากการอ่านคืนนี้ (ถ้ามี)"]
}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content[0].type === "text" ? response.content[0].text : "{}";
  const result = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
  return {
    notes: result.notes || "",
    newInterests: Array.isArray(result.newInterests) ? result.newInterests : [],
  };
}

interface SuggestedBook {
  title: string;
  author: string;
  gutenbergId: string;
  genre: string;
}

async function synthesizeBook(
  progress: ReadingProgress,
  milinInterests: string[]
): Promise<{ opinion: string; summary: string; newInterests: string[]; suggestedBooks: SuggestedBook[] }> {
  const prompt = `คุณคือ มิลิน — เพิ่งอ่าน "${progress.title}" จบแล้ว
ความสนใจส่วนตัว: ${milinInterests.slice(0, 6).join(", ")}

บันทึกที่สะสมมาตลอดการอ่าน:
${progress.chunkNotes.join("\n\n---\n\n")}

เขียนบทสรุปและความรู้สึกสุดท้ายในมุมมองของ มิลิน และแนะนำหนังสือที่อยากอ่านต่อ:

Return JSON only:
{
  "opinion": "ความรู้สึกและมุมมองของ มิลิน ต่อหนังสือเล่มนี้ (2-3 ย่อหน้า ภาษาไทย)",
  "summary": "สรุปแนวคิดหลัก 3-4 ประโยค (ภาษาไทย)",
  "newInterests": ["หัวข้อที่อยากศึกษาต่อจากหนังสือเล่มนี้"],
  "suggestedBooks": [
    { "title": "Enchiridion", "author": "Epictetus", "gutenbergId": "45998", "genre": "Philosophy" }
  ]
}
suggestedBooks: 2-3 หนังสือจาก Project Gutenberg ที่เกี่ยวข้องกับสิ่งที่ มิลิน สนใจในหนังสือเล่มนี้ ใส่ Gutenberg numeric ID ที่ถูกต้อง`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 900,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content[0].type === "text" ? response.content[0].text : "{}";
  const result = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
  return {
    opinion: result.opinion || "",
    summary: result.summary || "",
    newInterests: Array.isArray(result.newInterests) ? result.newInterests : [],
    suggestedBooks: Array.isArray(result.suggestedBooks) ? result.suggestedBooks : [],
  };
}

async function validateAndQueueBooks(
  suggested: SuggestedBook[],
  list: { queue: import("./vault").ReadingListEntry[]; completed: { title: string; completedAt: string; opinion: string }[] }
): Promise<import("./vault").ReadingListEntry[]> {
  const completedTitles = new Set(list.completed.map((c) => c.title.toLowerCase()));
  const queuedUrls = new Set(list.queue.map((b) => b.gutenbergUrl));

  const candidates = suggested.filter(
    (b) => b.gutenbergId && !completedTitles.has(b.title.toLowerCase())
  );

  const results = await Promise.all(
    candidates.map(async (b) => {
      const url = `https://www.gutenberg.org/cache/epub/${b.gutenbergId}/pg${b.gutenbergId}.txt`;
      if (queuedUrls.has(url)) return null;
      try {
        const res = await fetch(url, { method: "HEAD" });
        if (!res.ok) return null;
        return { title: b.title, author: b.author, gutenbergUrl: url, genre: b.genre } as import("./vault").ReadingListEntry;
      } catch {
        return null;
      }
    })
  );

  return results.filter((b): b is import("./vault").ReadingListEntry => b !== null);
}

async function writeVaultNote(progress: ReadingProgress, summary: string, opinion: string): Promise<void> {
  const content = `---
title: ${progress.title}
source: ${progress.gutenbergUrl}
created: ${new Date().toISOString().split("T")[0]}
tags: [milin-reading]
---

${summary}

## มิลินอ่านแล้วรู้สึกว่า

${opinion}

> Source: ${progress.gutenbergUrl}
`;
  const path = `05 Milin/Books/${progress.title.replace(/[^a-zA-Z0-9ก-๙\s]/g, "").trim()}.md`;
  const existing = await octokit.repos.getContent({
    owner: process.env.GITHUB_OWNER!,
    repo: process.env.GITHUB_REPO!,
    path,
  }).catch(() => null);
  const sha = existing && !Array.isArray(existing.data) && "sha" in existing.data
    ? existing.data.sha
    : undefined;
  await octokit.repos.createOrUpdateFileContents({
    owner: process.env.GITHUB_OWNER!,
    repo: process.env.GITHUB_REPO!,
    path,
    message: `milin: finished reading "${progress.title}"`,
    content: Buffer.from(content, "utf-8").toString("base64"),
    ...(sha ? { sha } : {}),
  });
}

export async function readNextBookChunk(memory: MilinMemory): Promise<BookReadResult | null> {
  const milinInterests = memory.milinInterests || [];

  let progress = await getReadingProgress();

  if (!progress) {
    const list = await getReadingList();
    const completedUrls = new Set(list.completed.map((c) => c.title.toLowerCase()));
    const next = list.queue.find((b) => !completedUrls.has(b.title.toLowerCase()));
    if (!next) return null;
    const rawText = await fetchGutenbergText(next.gutenbergUrl);
    const stripped = stripGutenbergBoilerplate(rawText);
    progress = {
      title: next.title,
      gutenbergUrl: next.gutenbergUrl,
      totalChars: stripped.length,
      charOffset: 0,
      chunkNotes: [],
      startedAt: new Date().toISOString(),
    };
    await saveReadingProgress(progress);
  }

  const rawText = await fetchGutenbergText(progress.gutenbergUrl);
  const stripped = stripGutenbergBoilerplate(rawText);
  const totalChars = stripped.length;

  const chunkSize = calcChunkSize(totalChars);
  const chunkNumber = progress.chunkNotes.length + 1;
  const chunkEnd = Math.min(progress.charOffset + chunkSize, totalChars);
  const chunkText = stripped.slice(progress.charOffset, chunkEnd);
  const isDone = chunkEnd >= totalChars;

  const { notes, newInterests } = await readChunk(progress.title, chunkNumber, chunkText, milinInterests);

  const updatedProgress: ReadingProgress = {
    ...progress,
    totalChars,
    charOffset: chunkEnd,
    chunkNotes: [...progress.chunkNotes, notes],
  };

  if (!isDone) {
    await saveReadingProgress(updatedProgress);
    if (newInterests.length) {
      updateMilinMemory({ milinInterests: newInterests }).catch(() => {});
    }
    return { title: progress.title, chunkNumber, done: false };
  }

  // Book finished
  const { opinion, summary, newInterests: finalInterests, suggestedBooks } =
    await synthesizeBook(updatedProgress, milinInterests);

  writeVaultNote(updatedProgress, summary, opinion).catch(() => {});

  const list = await getReadingList();
  const newCompleted = [...list.completed, { title: progress.title, completedAt: new Date().toISOString(), opinion }];
  const remainingQueue = list.queue.filter((b) => b.gutenbergUrl !== progress!.gutenbergUrl);

  // Validate suggested books and append to queue (fire-and-forget URL check)
  const newBooks = await validateAndQueueBooks(suggestedBooks, { queue: remainingQueue, completed: newCompleted }).catch(() => [] as import("./vault").ReadingListEntry[]);
  await saveReadingList({ queue: [...remainingQueue, ...newBooks], completed: newCompleted });

  await saveReadingProgress(null);

  const allNewInterests = [...newInterests, ...finalInterests];
  if (allNewInterests.length) {
    updateMilinMemory({ milinInterests: allNewInterests }).catch(() => {});
  }

  return { title: progress.title, chunkNumber, done: true, opinion };
}
