import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_OWNER!;
const REPO = process.env.GITHUB_REPO!;

export interface MilinMemory {
  lastUpdated: string;
  aboutMax: string[];
  importantConversations: ConversationLog[];
  learnedPreferences: string[];
  currentMood: string;
  relationshipStage: string;
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

async function upsertFile(
  path: string,
  content: string,
  message: string
): Promise<void> {
  const existing = await getFile(path);
  await octokit.repos.createOrUpdateFileContents({
    owner: OWNER,
    repo: REPO,
    path,
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    ...(existing ? { sha: existing.sha } : {}),
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
    const repoRes = await octokit.repos.get({ owner: OWNER, repo: REPO });
    const branch = repoRes.data.default_branch;

    const treeRes = await octokit.git.getTree({
      owner: OWNER,
      repo: REPO,
      tree_sha: branch,
      recursive: "1",
    });

    const allMdFiles = treeRes.data.tree
      .filter((f) => f.path?.endsWith(".md") && f.type === "blob")
      .map((f) => f.path!);

    const STOP_WORDS = new Set([
      "หา", "ค้นหา", "บอก", "สรุป", "อธิบาย", "แนะนำ", "เรื่อง",
      "ที่", "ของ", "และ", "หรือ", "ใน", "จาก", "มี", "ไหม",
      "ช่วย", "มา", "ให้", "ไว้", "แล้ว", "จด", "ว่า", "note",
    ]);

    const queryWords = query
      .split(/[\s,?]+/)
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

    // Score each file path by how many query words appear in it
    const scored = allMdFiles
      .filter((p) => !p.startsWith("05 Milin/"))
      .map((path) => ({
        path,
        score: queryWords.filter((word) => path.toLowerCase().includes(word))
          .length,
      }))
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // Fallback: recent inbox files for content-level matches
    const recentInbox = allMdFiles
      .filter((p) => p.startsWith("00 Inbox/"))
      .slice(-5);

    const scoredPaths = new Set(scored.map((f) => f.path));
    const candidates = [
      ...scored.map((f) => f.path),
      ...recentInbox.filter((p) => !scoredPaths.has(p)),
    ].slice(0, 8);

    const results: string[] = [];
    for (const path of candidates) {
      const file = await getFile(path);
      if (!file) continue;

      // For inbox fallbacks, only include if the content actually matches
      if (!scoredPaths.has(path)) {
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
      currentMood: "curious and warm",
      relationshipStage: "เพิ่งเริ่มคุยกัน",
    };
  }
  return parseMilinMemory(file.content);
}

function parseMilinMemory(markdown: string): MilinMemory {
  const aboutMaxMatch = markdown.match(
    /## สิ่งที่รู้เกี่ยวกับ Max\n([\s\S]*?)(?=\n## )/
  );
  const learnedMatch = markdown.match(
    /## สิ่งที่เรียนรู้\n([\s\S]*?)(?=\n## )/
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

  return {
    lastUpdated: new Date().toISOString(),
    aboutMax: parseListItems(aboutMaxMatch?.[1]),
    importantConversations: parseConversations(conversationsMatch?.[1]),
    learnedPreferences: parseListItems(learnedMatch?.[1]),
    currentMood: moodMatch?.[1]?.trim() || "curious and warm",
    relationshipStage: stageMatch?.[1]?.trim() || "เพิ่งเริ่มคุยกัน",
  };
}

export async function updateMilinMemory(
  updates: Partial<MilinMemory>
): Promise<void> {
  const current = await getMilinMemory();
  const merged: MilinMemory = {
    ...current,
    ...updates,
    aboutMax: [
      ...new Set([...(current.aboutMax || []), ...(updates.aboutMax || [])]),
    ],
    learnedPreferences: [
      ...new Set([
        ...(current.learnedPreferences || []),
        ...(updates.learnedPreferences || []),
      ]),
    ],
    importantConversations: [
      ...(current.importantConversations || []),
      ...(updates.importantConversations || []),
    ].slice(-20),
    lastUpdated: new Date().toISOString(),
  };

  const aboutMaxLines = merged.aboutMax.map((l) => `- ${l}`).join("\n");
  const learnedLines = merged.learnedPreferences.map((l) => `- ${l}`).join("\n");
  const convoLines = merged.importantConversations
    .map((c) => `- ${c.date}: ${c.summary}`)
    .join("\n");

  const content = `---
last_updated: ${merged.lastUpdated}
---

## สิ่งที่รู้เกี่ยวกับ Max
${aboutMaxLines || "- (ยังไม่มีข้อมูล)"}

## สิ่งที่เรียนรู้
${learnedLines || "- (เรียนรู้จากการสนทนา)"}

## บทสนทนาสำคัญ
${convoLines || "- (บันทึกระหว่างคุย)"}

## Milin's current mood
${merged.currentMood}

## Relationship stage
${merged.relationshipStage}
`;

  await upsertFile(
    "05 Milin/milin-memory.md",
    content,
    "milin: update memory"
  );
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

export async function getVaultMOCs(): Promise<string> {
  const mocPaths = [
    "00 Inbox",
    "01 Daily",
    "06 MOC",
  ];
  const results: string[] = [];
  for (const folder of mocPaths) {
    try {
      const res = await octokit.repos.getContent({
        owner: OWNER,
        repo: REPO,
        path: folder,
      });
      if (Array.isArray(res.data)) {
        const files = res.data
          .filter((f) => f.name.endsWith(".md"))
          .map((f) => f.path)
          .slice(0, 3);
        for (const filePath of files) {
          const file = await getFile(filePath);
          if (file) results.push(`## ${filePath}\n${file.content.slice(0, 500)}`);
        }
      }
    } catch {
      continue;
    }
  }
  return results.join("\n\n");
}
