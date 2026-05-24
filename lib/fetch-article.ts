// Shared article fetcher used by research.ts and handlers/article.ts
import axios from "axios";
import * as cheerio from "cheerio";

const CONTENT_SELECTORS = [
  "article", "main", ".content", ".post-content", "#content", "body",
];

export async function fetchArticleText(
  url: string,
  maxLength = 8000
): Promise<string> {
  const { data: html } = await axios.get(url, {
    timeout: 10000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MilinBot/1.0)" },
  });
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, aside, .ad, .ads, .advertisement").remove();

  for (const sel of CONTENT_SELECTORS) {
    const text = $(sel).text().replace(/\s+/g, " ").trim();
    if (text.length > 200) return text.slice(0, maxLength);
  }
  return $("body").text().replace(/\s+/g, " ").trim().slice(0, maxLength);
}
