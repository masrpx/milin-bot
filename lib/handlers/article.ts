import Anthropic from "@anthropic-ai/sdk";
import * as cheerio from "cheerio";
import axios from "axios";
import { saveToKnowledgeQueue, type KnowledgeItem } from "../vault";

const client = new Anthropic();

async function fetchArticleText(url: string): Promise<string> {
  const { data: html } = await axios.get(url, {
    timeout: 10000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MilinBot/1.0)" },
  });
  const $ = cheerio.load(html);

  $("script, style, nav, header, footer, aside, .ad, .ads, .advertisement").remove();

  const selectors = ["article", "main", ".content", ".post-content", "#content", "body"];
  for (const sel of selectors) {
    const text = $(sel).text().replace(/\s+/g, " ").trim();
    if (text.length > 200) return text.slice(0, 8000);
  }

  return $("body").text().replace(/\s+/g, " ").trim().slice(0, 8000);
}

export async function handleArticle(
  input: string,
  isUrl: boolean
): Promise<string> {
  let articleText: string;

  try {
    if (isUrl) {
      const urlMatch = input.match(/https?:\/\/[^\s]+/);
      const url = urlMatch?.[0] || input;
      articleText = await fetchArticleText(url);
    } else {
      articleText = input;
    }
  } catch {
    return "อ่านลิงก์นั้นไม่ได้อ่ะ ลองส่งมาเป็นข้อความแทนได้ไหม~";
  }

  if (articleText.length < 100) {
    return "บทความสั้นเกินไปอ่ะ ไม่มีอะไรให้อ่าน~";
  }

  const today = new Date().toISOString().split("T")[0];
  const sourceUrl = isUrl ? input.match(/https?:\/\/[^\s]+/)?.[0] || "" : "";

  const prompt = `อ่านบทความนี้และแตกเป็น atomic notes
แต่ละ note ควรมี 1 concept ที่ชัดเจน
Max สนใจ: Dhamma, Biohacking, Business, Finance, Psychology, Gaming, AI

ตอบเป็น JSON array เท่านั้น ไม่มีข้อความอื่น:
[
  {
    "title": "ชื่อ note",
    "summary": "สรุปเนื้อหา 2-3 ประโยค",
    "suggestedVaultPath": "เช่น 04 Resources/Biohacking",
    "relevanceReason": "เกี่ยวกับ Max ยังไง"
  }
]

บทความ:
${articleText.slice(0, 6000)}`;

  let items: KnowledgeItem[] = [];

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const raw =
      response.content[0].type === "text" ? response.content[0].text : "[]";
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(jsonMatch?.[0] || "[]");

    items = parsed.map(
      (p: {
        title?: string;
        summary?: string;
        suggestedVaultPath?: string;
        relevanceReason?: string;
      }) => ({
        title: p.title || "Untitled",
        source: sourceUrl || "direct input",
        sourceType: isUrl ? ("web" as const) : ("article" as const),
        summary: p.summary || "",
        suggestedVaultPath: p.suggestedVaultPath || "00 Inbox",
        relevanceReason: p.relevanceReason || "",
        approved: false,
      })
    );
  } catch {
    return "อ่านให้แล้วแต่แตก notes ไม่ได้อ่ะ ลองใหม่นะ~";
  }

  if (items.length === 0) {
    return "อ่านแล้วแต่ไม่เจอ notes ที่น่าสนใจเลยอ่ะ~";
  }

  await saveToKnowledgeQueue(today, items);

  return `อ่านให้แล้วนะ แตกออกมาได้ ${items.length} notes
พรุ่งนี้เช้า Milin จะรายงานให้ดู
ถ้าชอบค่อยลงใน vault 🗂️`;
}
