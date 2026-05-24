import Anthropic from "@anthropic-ai/sdk";
import Parser from "rss-parser";
import { fetchArticleText } from "./fetch-article";
import {
  getMilinMemory,
  saveToKnowledgeQueue,
  type KnowledgeItem,
} from "./vault";

const client = new Anthropic();
const rssParser = new Parser();

const DEFAULT_RSS_FEEDS = [
  // Biohacking / Longevity
  "https://peterattiamd.com/feed",
  "https://www.foundmyfitness.com/feed",
  "https://lifespan.io/feed",
  "https://www.hubermanlab.com/feed",
  // Investing / Finance
  "https://advisors.vanguard.com/insights/rss",
  "https://blogs.cfainstitute.org/investor/feed",
  "https://www.morningstar.com/rss/articles",
  "https://www.valuewalk.com/feed",
  // Thailand Business
  "https://www.bangkokpost.com/rss/data/business.xml",
  "https://thailand-business-news.com/feed",
  "https://thaicapitalist.com/feed",
  // AI / Tech
  "https://hnrss.org/frontpage",
  "https://bensbites.beehiiv.com/feed",
  "https://techcrunch.com/feed",
  // Philosophy / Mindset
  "https://fs.blog/feed",
  "https://aeon.co/feed.rss",
];

async function fetchRssItems(
  feedUrl: string
): Promise<{ title: string; link: string; content: string; pubDate: string }[]> {
  try {
    const feed = await rssParser.parseURL(feedUrl);
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;

    return feed.items
      .filter((item) => {
        if (!item.pubDate) return true;
        return new Date(item.pubDate).getTime() > fourteenDaysAgo;
      })
      .slice(0, 8)
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
  snippet: string,
  url: string,
  sourceType: KnowledgeItem["sourceType"],
  interests: string[]
): Promise<KnowledgeItem | null> {
  // Step 1: quick relevance score on snippet (cheap)
  const quickPrompt = `Score relevance 1-10 for Max's interests: ${interests.slice(0, 7).join(", ")}
Title: ${title}
Snippet: ${snippet.slice(0, 400)}
Return JSON only: {"score": 7}
If clearly irrelevant return: {"score": 0}`;

  const quickRes = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 30,
    messages: [{ role: "user", content: quickPrompt }],
  });
  const quickRaw = quickRes.content[0].type === "text" ? quickRes.content[0].text : "{}";
  const quickScore = JSON.parse(quickRaw.match(/\{[\s\S]*\}/)?.[0] || "{}").score || 0;
  if (quickScore < 6) return null;

  // Step 2: fetch full article for items that passed
  const fullText = await fetchArticleText(url, 6000).catch(() => "");
  const content = fullText.length > 300 ? fullText : snippet;

  // Step 3: summarize from full content
  const prompt = `Summarize this article as an atomic note for Max's Obsidian vault.

Max's interests: ${interests.join(", ")}

Vault structure (PARA method):
- 01 Projects
- 02 Areas
- 03 Resources/Biohacking, 03 Resources/Finance, 03 Resources/AI, 03 Resources/Psychology, 03 Resources/Business, 03 Resources/Dhamma, 03 Resources/Gaming
- 04 Archives
- 05 Milin (bot only, never use this)

Title: ${title}
Content: ${content.slice(0, 5000)}

Return JSON only:
{
  "summary": "3-5 sentence substantive summary with key insights",
  "suggestedVaultPath": "03 Resources/Biohacking",
  "relevanceReason": "specific reason Max would care"
}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });

  const raw =
    response.content[0].type === "text" ? response.content[0].text : "{}";
  const result = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");

  return {
    title,
    source: url,
    sourceType,
    summary: result.summary || snippet.slice(0, 300),
    suggestedVaultPath: result.suggestedVaultPath || "00 Inbox",
    relevanceReason: result.relevanceReason || "",
    approved: false,
  };
}

export async function runNightlyResearch(): Promise<KnowledgeItem[]> {
  const memory = await getMilinMemory();

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

  const rawFindings: { title: string; content: string; source: string; type: KnowledgeItem["sourceType"] }[] = [];

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

  // Cap at 25 before scoring — prevents runaway sequential API calls
  // (16 feeds × 8 items = up to 128 candidates; 25 is enough to yield 10 keepers)
  const cappedFindings = rawFindings.slice(0, 25);

  // Score, fetch full article, and summarize (sequential to avoid hammering servers)
  // Hard time budget: stop at 4 min so Vercel doesn't kill the function mid-save
  const BUDGET_MS = 4 * 60 * 1000;
  const startTime = Date.now();
  const scored: (KnowledgeItem | null)[] = [];
  for (const f of cappedFindings) {
    if (Date.now() - startTime > BUDGET_MS) break;
    const item = await scoreAndCreateNote(f.title, f.content, f.source, f.type, interests);
    scored.push(item);
  }

  const filtered = scored
    .filter((item): item is KnowledgeItem => item !== null)
    .slice(0, 10);

  if (filtered.length > 0) {
    const today = new Date().toISOString().split("T")[0];
    await saveToKnowledgeQueue(today, filtered);
  }

  return filtered;
}
