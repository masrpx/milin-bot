import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import Parser from "rss-parser";
import * as cheerio from "cheerio";
import {
  getMilinMemory,
  getVaultMOCs,
  saveToKnowledgeQueue,
  type KnowledgeItem,
} from "./vault";

const client = new Anthropic();
const rssParser = new Parser();

const DEFAULT_RSS_FEEDS = [
  "https://waitbutwhy.com/feed",
  "https://fs.blog/feed/",
  "https://www.dhammatalks.org/rss.xml",
];

async function generateResearchQueries(
  interests: string[],
  vaultContext: string
): Promise<string[]> {
  const prompt = `Based on Max's interests and vault context, suggest 5 specific research queries for tonight.

Max's interests: ${interests.join(", ")}
Recent vault context:
${vaultContext.slice(0, 2000)}

Return ONLY a JSON array of 5 query strings, nothing else:
["query 1", "query 2", ...]`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const raw =
    response.content[0].type === "text" ? response.content[0].text : "[]";
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  return JSON.parse(jsonMatch?.[0] || "[]");
}

async function searchPerplexity(query: string): Promise<string> {
  if (!process.env.PERPLEXITY_API_KEY) return "";

  try {
    const response = await axios.post(
      "https://api.perplexity.ai/chat/completions",
      {
        model: "sonar",
        messages: [
          {
            role: "user",
            content: query,
          },
        ],
        max_tokens: 800,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    return response.data?.choices?.[0]?.message?.content || "";
  } catch {
    return "";
  }
}

async function fetchRssItems(
  feedUrl: string
): Promise<{ title: string; link: string; content: string; pubDate: string }[]> {
  try {
    const feed = await rssParser.parseURL(feedUrl);
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;

    return feed.items
      .filter((item) => {
        if (!item.pubDate) return true;
        return new Date(item.pubDate).getTime() > threeDaysAgo;
      })
      .slice(0, 5)
      .map((item) => ({
        title: item.title || "",
        link: item.link || feedUrl,
        content: item.contentSnippet || item.content || "",
        pubDate: item.pubDate || "",
      }));
  } catch {
    return [];
  }
}

async function scoreAndCreateNote(
  title: string,
  content: string,
  source: string,
  sourceType: KnowledgeItem["sourceType"],
  interests: string[]
): Promise<KnowledgeItem | null> {
  const prompt = `Rate the relevance of this content for Max (1-10) and create an atomic note if score >= 7.

Max's interests: ${interests.join(", ")}

Title: ${title}
Content: ${content.slice(0, 1500)}

Return JSON only:
{
  "score": 8,
  "summary": "2-3 sentence summary",
  "suggestedVaultPath": "04 Resources/Biohacking",
  "relevanceReason": "why Max would care"
}

If score < 7, return: {"score": 0}`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });

  const raw =
    response.content[0].type === "text" ? response.content[0].text : "{}";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const result = JSON.parse(jsonMatch?.[0] || "{}");

  if (!result.score || result.score < 7) return null;

  return {
    title,
    source,
    sourceType,
    summary: result.summary || "",
    suggestedVaultPath: result.suggestedVaultPath || "00 Inbox",
    relevanceReason: result.relevanceReason || "",
    approved: false,
  };
}

export async function runNightlyResearch(): Promise<KnowledgeItem[]> {
  const memory = await getMilinMemory();
  const vaultContext = await getVaultMOCs();

  const interests = [
    "Dhamma",
    "Biohacking",
    "Business scaling",
    "Investing",
    "Gaming",
    "Psychology",
    "AI",
    ...memory.aboutMax,
  ];

  const queries = await generateResearchQueries(interests, vaultContext);

  const rawFindings: { title: string; content: string; source: string; type: KnowledgeItem["sourceType"] }[] = [];

  // Perplexity web search
  await Promise.all(
    queries.map(async (query) => {
      const result = await searchPerplexity(query);
      if (result) {
        rawFindings.push({
          title: query,
          content: result,
          source: "Perplexity Web Search",
          type: "web",
        });
      }
    })
  );

  // RSS feeds
  const allRssItems = await Promise.all(
    DEFAULT_RSS_FEEDS.map(fetchRssItems)
  );
  for (const items of allRssItems) {
    for (const item of items) {
      rawFindings.push({
        title: item.title,
        content: item.content,
        source: item.link,
        type: "rss",
      });
    }
  }

  // Score and filter
  const scored = await Promise.all(
    rawFindings.map((f) =>
      scoreAndCreateNote(f.title, f.content, f.source, f.type, interests)
    )
  );

  const filtered = scored
    .filter((item): item is KnowledgeItem => item !== null)
    .slice(0, 10);

  if (filtered.length > 0) {
    const today = new Date().toISOString().split("T")[0];
    await saveToKnowledgeQueue(today, filtered);
  }

  return filtered;
}
