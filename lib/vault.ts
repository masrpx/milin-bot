import { Octokit } from "@octokit/rest";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_OWNER!;
const REPO = process.env.GITHUB_REPO!;

export interface PendingAction {
  type: "delete" | "update" | "create" | "reschedule" | "nvdn_paginate" | "todo_classify";
  eventId?: string;      // delete/update/reschedule
  eventTitle: string;
  startISO?: string;     // create only
  endISO?: string;       // create only
  description?: string;  // create only
  changes?: {
    title?: string;
    startISO?: string;
    endISO?: string;
    description?: string;
    colorId?: number;
  };
  // nvdn_paginate only
  keyword?: string;
  page?: number;
  // todo_classify only — ordered inbox item IDs from the ping snapshot
  inboxSnapshot?: string[];
  expiresAt: string; // ISO
}

export interface RecentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface MilinMemory {
  lastUpdated: string;
  aboutMax: string[];
  importantConversations: ConversationLog[];
  learnedPreferences: string[];
  topicsAsked: string[];
  currentMood: string;
  relationshipStage: string;
  pendingAction?: PendingAction;
  // Last 10 messages from actual conversations — always valid alternating user/assistant
  recentMessages: RecentMessage[];
  // Latest proactive message Milin sent (from milin-ping cron)
  milinActivity?: string;
  // Daily ping quota tracking — ICT date + count sent today
  pingToday?: { date: string; count: number };
  // ISO timestamp of the last real conversation with Max
  lastConversationAt?: string;
  // Recurring behavioral patterns detected from importantConversations — regenerated daily
  maxPatterns?: string[];
  // Milin's own evolving interests — seeded + updated from books and web searches
  milinInterests?: string[];
}

export interface ConversationLog {
  date: string;
  summary: string;
  maxMood?: string;
}

export interface KnowledgeItem {
  title: string;
  source: string;
  sourceType: "web" | "youtube" | "rss" | "article";
  summary: string;
  suggestedVaultPath: string;
  relevanceReason: string;
  approved?: boolean;
}

const MILIN_INTEREST_SEEDS = [
  "ปรัชญาสโตอิก",
  "บทกวีและวรรณกรรม",
  "จิตวิทยาความสัมพันธ์",
  "แฟชั่นและการออกแบบ",
  "ดนตรีคลาสสิก",
  "การเดินทางและวัฒนธรรม",
];

async function getFile(
  path: string
): Promise<{ content: string; sha: string } | null> {
  try {
    const res = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path });
    if ("content" in res.data && typeof res.data.content === "string") {
      return {
        content: Buffer.from(res.data.content, "base64").toString("utf-8"),
        sha: res.data.sha,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Exported so cron/morning and handlers/approve can share date-offset logic
export function getDateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

async function upsertFile(
  path: string,
  content: string,
  message: string,
  knownSha?: string        // pass when sha is already in hand to skip an extra getFile call
): Promise<void> {
  const sha = knownSha ?? (await getFile(path))?.sha;
  await octokit.repos.createOrUpdateFileContents({
    owner: OWNER,
    repo: REPO,
    path,
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    ...(sha ? { sha } : {}),
  });
}

async function deleteFile(path: string): Promise<void> {
  const existing = await getFile(path);
  if (!existing) return;
  await octokit.repos.deleteFile({
    owner: OWNER,
    repo: REPO,
    path,
    message: `chore: delete ${path}`,
    sha: existing.sha,
  });
}

export async function searchVault(query: string): Promise<string[]> {
  try {
    const branch = "main";

    const treeRes = await octokit.git.getTree({
      owner: OWNER,
      repo: REPO,
      tree_sha: branch,
      recursive: "1",
    });

    const allMdFiles = treeRes.data.tree
      .filter((f) => f.path?.endsWith(".md") && f.type === "blob")
      .map((f) => f.path!)
      .filter((p) => {
        if (!p.startsWith("05 Milin/")) return true;
        // Allow Milin's readable content; exclude internal state
        return p.startsWith("05 Milin/Books/") || p.startsWith("05 Milin/Discoveries/");
      });

    const STOP_WORDS = new Set([
      "หา", "ค้นหา", "บอก", "สรุป", "อธิบาย", "แนะนำ", "เรื่อง",
      "ที่", "ของ", "และ", "หรือ", "ใน", "จาก", "มี", "ไหม",
      "ช่วย", "มา", "ให้", "ไว้", "แล้ว", "จด", "ว่า", "note",
      "folder", "อะไรก็ได้", "ทั้งหมด",
    ]);

    const queryWords = query
      .split(/[\s,?]+/)
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

    // Step 1: path keyword scoring (works for English terms like "projects", "finance")
    const scored = allMdFiles
      .map((path) => ({
        path,
        score: queryWords.filter((word) => path.toLowerCase().includes(word)).length,
      }))
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // Step 2: if path scoring found nothing, use Claude to map Thai query → file paths
    // (e.g. "การเงิน" → finds "CFP Certification.md", "Investing.md")
    let candidatePaths: string[];
    if (scored.length === 0) {
      candidatePaths = await pickFilesWithClaude(query, allMdFiles);
    } else {
      candidatePaths = scored.map((f) => f.path);
    }

    // Step 3: also check recent inbox files for content-level matches
    const inboxFiles = allMdFiles.filter((p) => p.startsWith("00 Inbox/")).slice(-5);
    const candidateSet = new Set(candidatePaths);
    const toRead = [
      ...candidatePaths,
      ...inboxFiles.filter((p) => !candidateSet.has(p)),
    ].slice(0, 8);

    const results: string[] = [];
    for (const path of toRead) {
      const file = await getFile(path);
      if (!file) continue;

      // For inbox additions, only include if content actually matches
      if (!candidateSet.has(path)) {
        const lower = file.content.toLowerCase();
        if (!queryWords.some((w) => lower.includes(w))) continue;
      }

      results.push(`## ${path}\n${file.content.slice(0, 1500)}`);
    }

    return results;
  } catch (err) {
    console.error("searchVault error:", err);
    return [];
  }
}

async function pickFilesWithClaude(
  query: string,
  files: string[]
): Promise<string[]> {
  try {
    const fileList = files.slice(0, 300).join("\n");

    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `Vault file list:\n${fileList}\n\nUser query: "${query}"\n\nWhich 3-5 files most likely contain the answer? Consider Thai-English equivalences (การเงิน=Finance/CFP/Investing, ธุรกิจ=Business, สุขภาพ=Health/Biohacking, etc.).\nReturn JSON only: ["path1", "path2"]\nIf none match, return: []`,
        },
      ],
    });

    const raw = res.content[0].type === "text" ? res.content[0].text : "[]";
    const picks: string[] = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || "[]");
    return picks.filter((p) => files.includes(p)).slice(0, 5);
  } catch {
    return [];
  }
}

export async function saveToInbox(content: string): Promise<void> {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toTimeString().split(" ")[0].replace(/:/g, "-");
  const path = `00 Inbox/${date}-${time}.md`;
  const fileContent = `---\ncreated: ${now.toISOString()}\ntags: [inbox]\n---\n\n${content}\n`;
  await upsertFile(path, fileContent, `inbox: add note ${date}`);
}

export async function getMilinMemory(): Promise<MilinMemory> {
  const file = await getFile("05 Milin/milin-memory.md");
  if (!file) {
    return {
      lastUpdated: new Date().toISOString(),
      aboutMax: [],
      importantConversations: [],
      learnedPreferences: [],
      topicsAsked: [],
      currentMood: "curious and warm",
      relationshipStage: "สนิทกันมาก",
      recentMessages: [],
    };
  }
  return parseMilinMemory(file.content);
}

export function parseMilinMemory(markdown: string): MilinMemory {
  const aboutMaxMatch = markdown.match(
    /## สิ่งที่รู้เกี่ยวกับ Max\n([\s\S]*?)(?=\n## )/
  );
  const learnedMatch = markdown.match(
    /## สิ่งที่เรียนรู้\n([\s\S]*?)(?=\n## )/
  );
  const topicsMatch = markdown.match(
    /## หัวข้อที่ Max สนใจ\n([\s\S]*?)(?=\n## |$)/
  );
  const moodMatch = markdown.match(/## Milin's current mood\n([\s\S]*?)(?=\n## |$)/);
  const stageMatch = markdown.match(/## Relationship stage\n([\s\S]*?)(?=\n## |$)/);
  const conversationsMatch = markdown.match(
    /## บทสนทนาสำคัญ\n([\s\S]*?)(?=\n## |$)/
  );

  const parseListItems = (block: string | undefined): string[] => {
    if (!block) return [];
    return block
      .trim()
      .split("\n")
      .filter((l) => l.trim().startsWith("-"))
      .map((l) => l.replace(/^-\s*/, "").trim())
      .filter(Boolean);
  };

  const parseConversations = (block: string | undefined): ConversationLog[] => {
    if (!block) return [];
    return block
      .trim()
      .split("\n")
      .filter((l) => l.trim().startsWith("-"))
      .map((l) => {
        const text = l.replace(/^-\s*/, "").trim();
        const dateMatch = text.match(/^(\d{4}-\d{2}-\d{2}):\s*(.+)/);
        if (dateMatch) return { date: dateMatch[1], summary: dateMatch[2] };
        return { date: "", summary: text };
      })
      .filter((c) => c.summary);
  };

  const conversations = parseConversations(conversationsMatch?.[1]);
  const count = conversations.length;
  let relationshipStage = stageMatch?.[1]?.trim() || "สนิทกันมาก";
  // Auto-evolve if stored stage doesn't match conversation count
  if (count >= 30) relationshipStage = "สนิทกันมาก";
  else if (count >= 15) relationshipStage = "สนิทกันมากขึ้น";
  else if (count >= 5) relationshipStage = "เริ่มสนิทกัน";
  else relationshipStage = "เพิ่งเริ่มคุยกัน";

  const patternsMatch = markdown.match(
    /## สิ่งที่มิลินสังเกตเห็น\n([\s\S]*?)(?=\n## |$)/
  );
  const milinInterestsMatch = markdown.match(
    /## ความสนใจของมิลิน\n([\s\S]*?)(?=\n## |$)/
  );

  const pendingActionMatch = markdown.match(
    /## Pending Action\n([\s\S]*?)(?=\n## |$)/
  );
  let pendingAction: PendingAction | undefined;
  if (pendingActionMatch?.[1]?.trim()) {
    try {
      pendingAction = JSON.parse(pendingActionMatch[1].trim()) as PendingAction;
    } catch {
      pendingAction = undefined;
    }
  }

  // Parse recent conversation messages (stored as JSON array)
  const recentMessagesMatch = markdown.match(
    /## Recent Messages\n```json\n([\s\S]*?)\n```/
  );
  let recentMessages: RecentMessage[] = [];
  if (recentMessagesMatch?.[1]?.trim()) {
    try {
      recentMessages = JSON.parse(recentMessagesMatch[1].trim()) as RecentMessage[];
    } catch {
      recentMessages = [];
    }
  }

  // Parse Milin's latest proactive message (from milin-ping)
  const milinActivityMatch = markdown.match(
    /## Milin's Recent Activity\n([\s\S]*?)(?=\n## |$)/
  );
  const milinActivity = milinActivityMatch?.[1]?.trim() || undefined;

  const pingTodayMatch = markdown.match(/## Ping Today\n([\s\S]*?)(?=\n## |$)/);
  let pingToday: { date: string; count: number } | undefined;
  if (pingTodayMatch?.[1]?.trim()) {
    try { pingToday = JSON.parse(pingTodayMatch[1].trim()); } catch {}
  }

  const lastConversationAtMatch = markdown.match(/## Last Conversation At\n([\s\S]*?)(?=\n## |$)/);
  const lastConversationAt = lastConversationAtMatch?.[1]?.trim() || undefined;

  return {
    lastUpdated: new Date().toISOString(),
    aboutMax: parseListItems(aboutMaxMatch?.[1]),
    importantConversations: conversations,
    learnedPreferences: parseListItems(learnedMatch?.[1]),
    topicsAsked: parseListItems(topicsMatch?.[1]),
    currentMood: moodMatch?.[1]?.trim() || "curious and warm",
    relationshipStage,
    pendingAction,
    recentMessages,
    milinActivity,
    pingToday,
    lastConversationAt,
    maxPatterns: parseListItems(patternsMatch?.[1]),
    milinInterests: parseListItems(milinInterestsMatch?.[1]).length > 0
      ? parseListItems(milinInterestsMatch?.[1])
      : [...MILIN_INTEREST_SEEDS],
  };
}

export async function updateMilinMemory(
  updates: Partial<MilinMemory>
): Promise<void> {
  // Read file directly (not via getMilinMemory) so we keep the SHA for the write —
  // avoids a second getFile call inside upsertFile.
  const existingFile = await getFile("05 Milin/milin-memory.md");
  const current: MilinMemory = existingFile
    ? parseMilinMemory(existingFile.content)
    : {
        lastUpdated: new Date().toISOString(),
        aboutMax: [], importantConversations: [], learnedPreferences: [],
        topicsAsked: [], currentMood: "curious and warm", relationshipStage: "สนิทกันมาก",
        recentMessages: [],
      };

  const mergeUnique = (a: string[], b: string[], cap: number) =>
    [...new Set([...a, ...b])].slice(-cap);

  const newConvos = [
    ...(current.importantConversations || []),
    ...(updates.importantConversations || []),
  ].slice(-30);

  // Auto-evolve relationship stage from conversation count
  const count = newConvos.length;
  const relationshipStage =
    count >= 30 ? "สนิทกันมาก" :
    count >= 15 ? "สนิทกันมากขึ้น" :
    count >= 5  ? "เริ่มสนิทกัน" :
                  "เพิ่งเริ่มคุยกัน";

  // Append new message pairs to history, cap at 10 messages (5 pairs)
  const newRecentMessages = [
    ...(current.recentMessages || []),
    ...(updates.recentMessages || []),
  ].slice(-10);

  const merged: MilinMemory = {
    ...current,
    ...updates,
    aboutMax: mergeUnique(current.aboutMax || [], updates.aboutMax || [], 30),
    learnedPreferences: mergeUnique(current.learnedPreferences || [], updates.learnedPreferences || [], 30),
    topicsAsked: mergeUnique(current.topicsAsked || [], updates.topicsAsked || [], 20),
    milinInterests: mergeUnique(
      current.milinInterests?.length ? current.milinInterests : [...MILIN_INTEREST_SEEDS],
      updates.milinInterests || [],
      15
    ),
    importantConversations: newConvos,
    recentMessages: newRecentMessages,
    // milinActivity: updates.milinActivity takes precedence (already covered by ...updates spread above)
    relationshipStage,
    lastUpdated: new Date().toISOString(),
  };

  const aboutMaxLines = merged.aboutMax.map((l) => `- ${l}`).join("\n");
  const learnedLines = merged.learnedPreferences.map((l) => `- ${l}`).join("\n");
  const topicsLines = merged.topicsAsked.map((l) => `- ${l}`).join("\n");
  const convoLines = merged.importantConversations
    .map((c) => `- ${c.date}: ${c.summary}`)
    .join("\n");

  const patternsSection = merged.maxPatterns?.length
    ? `\n## สิ่งที่มิลินสังเกตเห็น\n${merged.maxPatterns.map((l) => `- ${l}`).join("\n")}\n`
    : "";
  const milinInterestsSection = merged.milinInterests?.length
    ? `\n## ความสนใจของมิลิน\n${merged.milinInterests.map((l) => `- ${l}`).join("\n")}\n`
    : "";

  const pendingActionSection = merged.pendingAction
    ? `\n## Pending Action\n${JSON.stringify(merged.pendingAction)}\n`
    : "";

  const recentMessagesJson = JSON.stringify(merged.recentMessages);
  const milinActivitySection = merged.milinActivity
    ? `\n## Milin's Recent Activity\n${merged.milinActivity}\n`
    : "";
  const pingTodaySection = merged.pingToday
    ? `\n## Ping Today\n${JSON.stringify(merged.pingToday)}\n`
    : "";
  const lastConversationAtSection = merged.lastConversationAt
    ? `\n## Last Conversation At\n${merged.lastConversationAt}\n`
    : "";

  const content = `---
last_updated: ${merged.lastUpdated}
---

## สิ่งที่รู้เกี่ยวกับ Max
${aboutMaxLines || "- (ยังไม่มีข้อมูล)"}

## สิ่งที่เรียนรู้
${learnedLines || "- (เรียนรู้จากการสนทนา)"}

## หัวข้อที่ Max สนใจ
${topicsLines || "- (กำลังเรียนรู้)"}

## บทสนทนาสำคัญ
${convoLines || "- (บันทึกระหว่างคุย)"}

## Milin's current mood
${merged.currentMood}

## Relationship stage
${merged.relationshipStage}

## Recent Messages
\`\`\`json
${recentMessagesJson}
\`\`\`
${milinActivitySection}${pingTodaySection}${lastConversationAtSection}${patternsSection}${milinInterestsSection}${pendingActionSection}`;

  await upsertFile(
    "05 Milin/milin-memory.md",
    content,
    "milin: update memory",
    existingFile?.sha
  );
}

export async function appendRecentMessages(
  userText: string,
  botReply: string
): Promise<void> {
  await updateMilinMemory({
    recentMessages: [
      { role: "user", content: userText.slice(0, 500) },
      { role: "assistant", content: botReply.slice(0, 500) },
    ],
  });
}

export async function appendChatHistory(
  userText: string,
  botReply: string
): Promise<void> {
  // Use ICT (UTC+7) for date and time
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const date = now.toISOString().split("T")[0];
  const time = now.toISOString().split("T")[1].slice(0, 5);

  const filePath = `05 Milin/history/${date}.md`;
  const existing = await getFile(filePath);

  const header = existing ? "" : `# Chat History — ${date}\n\n`;
  const entry = `### ${time}\n**Max:** ${userText}\n**Milin:** ${botReply}\n\n`;

  const newContent = (existing?.content ?? "") + header + entry;
  await upsertFile(filePath, newContent, `chat: ${date} ${time}`, existing?.sha);
}

export async function saveToKnowledgeQueue(
  date: string,
  items: KnowledgeItem[]
): Promise<void> {
  const path = `05 Milin/knowledge-queue/${date}.md`;
  const lines = items
    .map(
      (item, i) =>
        `## ${i + 1}. ${item.title}
- source: ${item.source}
- type: ${item.sourceType}
- vault_path: ${item.suggestedVaultPath}
- relevance: ${item.relevanceReason}
- approved: ${item.approved ? "true" : "false"}

${item.summary}
`
    )
    .join("\n---\n\n");

  const content = `---
date: ${date}
total: ${items.length}
---

${lines}`;

  await upsertFile(path, content, `milin: save knowledge queue ${date}`);
}

export async function getKnowledgeQueue(
  date: string
): Promise<KnowledgeItem[]> {
  const file = await getFile(`05 Milin/knowledge-queue/${date}.md`);
  if (!file) return [];
  return parseKnowledgeQueue(file.content);
}

function parseKnowledgeQueue(markdown: string): KnowledgeItem[] {
  const sections = markdown.split(/\n---\n/).filter((s) => s.includes("##"));
  return sections.map((section) => {
    const titleMatch = section.match(/## \d+\.\s*(.+)/);
    const sourceMatch = section.match(/- source:\s*(.+)/);
    const typeMatch = section.match(/- type:\s*(.+)/);
    const pathMatch = section.match(/- vault_path:\s*(.+)/);
    const relevanceMatch = section.match(/- relevance:\s*(.+)/);
    const approvedMatch = section.match(/- approved:\s*(.+)/);
    const summaryMatch = section.match(/approved: .+\n\n([\s\S]+?)$/);

    return {
      title: titleMatch?.[1]?.trim() || "",
      source: sourceMatch?.[1]?.trim() || "",
      sourceType: (typeMatch?.[1]?.trim() as KnowledgeItem["sourceType"]) || "web",
      suggestedVaultPath: pathMatch?.[1]?.trim() || "00 Inbox",
      relevanceReason: relevanceMatch?.[1]?.trim() || "",
      summary: summaryMatch?.[1]?.trim() || "",
      approved: approvedMatch?.[1]?.trim() === "true",
    };
  });
}

export async function approveKnowledgeItem(
  date: string,
  itemIndex: number
): Promise<void> {
  const items = await getKnowledgeQueue(date);
  const item = items[itemIndex];
  if (!item) return;

  const noteContent = `---
title: ${item.title}
source: ${item.source}
created: ${date}
tags: [milin-research]
---

${item.summary}

> Source: ${item.source}
`;

  const notePath = `${item.suggestedVaultPath}/${item.title.replace(/[^a-zA-Z0-9ก-๙\s]/g, "").trim()}.md`;
  await upsertFile(notePath, noteContent, `milin: add note "${item.title}"`);

  items[itemIndex] = { ...item, approved: true };
  await saveToKnowledgeQueue(date, items);
}

export async function deleteKnowledgeQueue(date: string): Promise<void> {
  await deleteFile(`05 Milin/knowledge-queue/${date}.md`);
}

export async function getSeenResearchUrls(): Promise<Set<string>> {
  const file = await getFile("05 Milin/research-seen.json");
  if (!file) return new Set();
  try {
    const parsed = JSON.parse(file.content);
    return new Set(Array.isArray(parsed.urls) ? parsed.urls : []);
  } catch {
    return new Set();
  }
}

export async function appendSeenResearchUrls(newUrls: string[]): Promise<void> {
  const file = await getFile("05 Milin/research-seen.json");
  let existing: string[] = [];
  let sha: string | undefined;
  if (file) {
    sha = file.sha;
    try {
      const parsed = JSON.parse(file.content);
      existing = Array.isArray(parsed.urls) ? parsed.urls : [];
    } catch {}
  }
  const combined = [...new Set([...existing, ...newUrls])].slice(-300);
  await upsertFile(
    "05 Milin/research-seen.json",
    JSON.stringify({ urls: combined }, null, 2),
    "milin: update research seen urls",
    sha
  );
}

/**
 * Save all knowledge items as vault notes then delete the queue in one pass.
 * Faster than calling approveKnowledgeItem() per item (avoids N×2 queue read/writes).
 */
export async function saveAllKnowledgeNotes(
  date: string,
  items: KnowledgeItem[]
): Promise<void> {
  await Promise.all(
    items.map((item) => {
      const noteContent = `---
title: ${item.title}
source: ${item.source}
created: ${date}
tags: [milin-research]
---

${item.summary}

> Source: ${item.source}
`;
      const notePath = `${item.suggestedVaultPath}/${item.title
        .replace(/[^a-zA-Z0-9ก-๙\s]/g, "")
        .trim()}.md`;
      return upsertFile(notePath, noteContent, `milin: add note "${item.title}"`);
    })
  );
  await deleteKnowledgeQueue(date);
}

// ── Reading progress / list ────────────────────────────────────────────────

export interface ReadingProgress {
  title: string;
  gutenbergUrl: string;
  totalChars: number;
  charOffset: number;
  chunkNotes: string[];
  startedAt: string;
}

export interface ReadingListEntry {
  title: string;
  author: string;
  gutenbergUrl: string;
  genre: string;
}

export interface ReadingList {
  queue: ReadingListEntry[];
  completed: { title: string; completedAt: string; opinion: string }[];
}

const SEED_READING_LIST: ReadingListEntry[] = [
  { title: "Meditations", author: "Marcus Aurelius", gutenbergUrl: "https://www.gutenberg.org/cache/epub/2680/pg2680.txt", genre: "Philosophy" },
  { title: "Siddhartha", author: "Hermann Hesse", gutenbergUrl: "https://www.gutenberg.org/cache/epub/2500/pg2500.txt", genre: "Philosophy" },
  { title: "Tao Te Ching", author: "Lao Tzu", gutenbergUrl: "https://www.gutenberg.org/cache/epub/216/pg216.txt", genre: "Philosophy" },
  { title: "Thus Spoke Zarathustra", author: "Friedrich Nietzsche", gutenbergUrl: "https://www.gutenberg.org/cache/epub/1998/pg1998.txt", genre: "Philosophy" },
  { title: "Beyond Good and Evil", author: "Friedrich Nietzsche", gutenbergUrl: "https://www.gutenberg.org/cache/epub/4363/pg4363.txt", genre: "Philosophy" },
  { title: "The Republic", author: "Plato", gutenbergUrl: "https://www.gutenberg.org/cache/epub/1497/pg1497.txt", genre: "Philosophy" },
  { title: "The Picture of Dorian Gray", author: "Oscar Wilde", gutenbergUrl: "https://www.gutenberg.org/cache/epub/174/pg174.txt", genre: "Literature" },
  { title: "Crime and Punishment", author: "Fyodor Dostoevsky", gutenbergUrl: "https://www.gutenberg.org/cache/epub/2554/pg2554.txt", genre: "Literature" },
  { title: "Jane Eyre", author: "Charlotte Brontë", gutenbergUrl: "https://www.gutenberg.org/cache/epub/1260/pg1260.txt", genre: "Literature" },
  { title: "The Art of War", author: "Sun Tzu", gutenbergUrl: "https://www.gutenberg.org/cache/epub/132/pg132.txt", genre: "Philosophy" },
];

export async function getReadingProgress(): Promise<ReadingProgress | null> {
  const file = await getFile("05 Milin/reading-progress.json");
  if (!file) return null;
  try {
    return JSON.parse(file.content) as ReadingProgress;
  } catch {
    return null;
  }
}

export async function saveReadingProgress(progress: ReadingProgress | null): Promise<void> {
  const path = "05 Milin/reading-progress.json";
  if (progress === null) {
    await deleteFile(path);
    return;
  }
  await upsertFile(path, JSON.stringify(progress, null, 2), "milin: update reading progress");
}

export async function getReadingList(): Promise<ReadingList> {
  const file = await getFile("05 Milin/reading-list.json");
  if (!file) {
    return { queue: [...SEED_READING_LIST], completed: [] };
  }
  try {
    const parsed = JSON.parse(file.content) as ReadingList;
    if (!parsed.queue?.length && !parsed.completed?.length) {
      return { queue: [...SEED_READING_LIST], completed: [] };
    }
    return parsed;
  } catch {
    return { queue: [...SEED_READING_LIST], completed: [] };
  }
}

export async function saveReadingList(list: ReadingList): Promise<void> {
  await upsertFile(
    "05 Milin/reading-list.json",
    JSON.stringify(list, null, 2),
    "milin: update reading list"
  );
}

