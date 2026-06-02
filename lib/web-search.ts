import Anthropic from "@anthropic-ai/sdk";
import { updateMilinMemory, type MilinMemory, type KnowledgeItem } from "./vault";

const client = new Anthropic({ maxRetries: 4 });

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

async function tavilySearch(query: string): Promise<TavilyResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, search_depth: "basic", max_results: 3 }),
  });
  if (!res.ok) return [];
  const data = await res.json() as { results?: TavilyResult[] };
  return data.results || [];
}

async function generateSearchQueries(milinInterests: string[]): Promise<string[]> {
  const prompt = `คุณคือ มิลิน — อยากค้นหาเรื่องที่น่าสนใจในโลกออนไลน์วันนี้
ความสนใจส่วนตัว: ${milinInterests.slice(0, 8).join(", ")}

สร้าง 2 search query ภาษาอังกฤษที่ มิลิน อยากค้นหาตอนนี้:
- อาจเป็นข่าวหรือเหตุการณ์ล่าสุดที่เกี่ยวกับความสนใจ
- หรือคำถามที่สงสัยอยู่ในใจ
- เป็นธรรมชาติ ไม่ต้องครอบคลุมทุกหัวข้อ

Return JSON only: { "queries": ["query1", "query2"] }`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = response.content[0].type === "text" ? response.content[0].text : "{}";
  const result = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
  return Array.isArray(result.queries) ? result.queries.slice(0, 2) : [];
}

async function summarizeResult(
  result: TavilyResult,
  milinInterests: string[]
): Promise<KnowledgeItem | null> {
  if (!result.content?.trim()) return null;

  const prompt = `สรุปบทความนี้เป็น atomic note สำหรับ มิลิน
ความสนใจส่วนตัวของ มิลิน: ${milinInterests.slice(0, 6).join(", ")}

Title: ${result.title}
Content: ${result.content.slice(0, 3000)}

Return JSON only:
{
  "summary": "3-4 ประโยค สรุปสาระสำคัญ",
  "relevanceReason": "เหตุผลที่ มิลิน สนใจเรื่องนี้"
}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = response.content[0].type === "text" ? response.content[0].text : "{}";
  const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");

  return {
    title: result.title,
    source: result.url,
    sourceType: "web",
    summary: parsed.summary || result.content.slice(0, 300),
    suggestedVaultPath: "05 Milin/Discoveries",
    relevanceReason: parsed.relevanceReason || "",
    approved: false,
  };
}

export async function runWebSearch(memory: MilinMemory): Promise<KnowledgeItem[]> {
  const milinInterests = memory.milinInterests || [];
  if (!milinInterests.length) return [];

  const queries = await generateSearchQueries(milinInterests);
  if (!queries.length) return [];

  const allResults = (await Promise.all(queries.map(tavilySearch))).flat();

  // Deduplicate by URL
  const seen = new Set<string>();
  const unique = allResults.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  const items = await Promise.all(unique.slice(0, 4).map((r) => summarizeResult(r, milinInterests)));
  const filtered = items.filter((i): i is KnowledgeItem => i !== null).slice(0, 3);

  // Discover new interest threads from search topics (fire-and-forget)
  if (filtered.length) {
    const newTopics = filtered.map((i) => i.relevanceReason).filter(Boolean).slice(0, 2);
    if (newTopics.length) {
      updateMilinMemory({ milinInterests: newTopics }).catch(() => {});
    }
  }

  return filtered;
}
