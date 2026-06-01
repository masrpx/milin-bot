import {
  getMilinMemory,
  saveToKnowledgeQueue,
  appendSeenResearchUrls,
  type KnowledgeItem,
} from "./vault";
import { readNextBookChunk, type BookReadResult } from "./book-reader";
import { runWebSearch } from "./web-search";

export type { BookReadResult };

export async function runNightlyResearch(): Promise<{
  searchItems: KnowledgeItem[];
  bookResult: BookReadResult | null;
}> {
  const memory = await getMilinMemory();

  const [bookResult, searchItems] = await Promise.all([
    readNextBookChunk(memory).catch(() => null),
    runWebSearch(memory).catch(() => [] as KnowledgeItem[]),
  ]);

  // Only search items go through the knowledge-queue pipeline (auto-saved to vault each morning)
  // Book progress is stored in reading-progress.json by book-reader — not in the queue
  if (searchItems.length > 0) {
    const today = new Date().toISOString().split("T")[0];
    await saveToKnowledgeQueue(today, searchItems);
    appendSeenResearchUrls(searchItems.map((i) => i.source)).catch(() => {});
  }

  return { searchItems, bookResult };
}
