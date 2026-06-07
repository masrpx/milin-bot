import Anthropic from "@anthropic-ai/sdk";
import { searchVault, updateMilinMemory, type MilinMemory, type RecentMessage } from "../vault";
import {
  buildMilinSystemPrompt,
  buildMemoryExtractPrompt,
  fetchBangkokWeather,
  type MemoryExtract,
} from "../milin-prompt";
import { fetchPortfolio } from "../portfolio";

const client = new Anthropic({ maxRetries: 4 });

// Internal — not used for routing, only to decide if vault search is worth doing
const NEEDS_VAULT = [
  "?", "ใคร", "อะไร", "ยังไง", "ทำไม", "เมื่อไหร่", "ที่ไหน",
  "หา", "ค้นหา", "สรุป", "บอก", "อธิบาย", "แนะนำ", "มีไหม", "ช่วย", "เรื่อง",
];

const NEEDS_PORTFOLIO = [
  "พอร์ต", "หุ้น", "ลงทุน", "dca", "portfolio", "rebalance", "weight", "asset",
];

export async function handleConversation(
  text: string,
  memory: MilinMemory
): Promise<string> {
  const shouldSearchVault = NEEDS_VAULT.some((t) => text.includes(t));
  const shouldFetchPortfolio = NEEDS_PORTFOLIO.some((t) => text.toLowerCase().includes(t));

  const [vaultResults, weather, portfolioRaw] = await Promise.all([
    shouldSearchVault ? searchVault(text) : Promise.resolve([]),
    fetchBangkokWeather(),
    shouldFetchPortfolio ? fetchPortfolio() : Promise.resolve(undefined),
  ]);
  const vaultContext = vaultResults.length
    ? vaultResults.join("\n\n---\n\n")
    : undefined;

  // Inject last 5 important conversations as additional context
  const recentConvos = memory.importantConversations
    .slice(-5)
    .map((c) => `${c.date}: ${c.summary}`)
    .join("\n");
  const contextNote = recentConvos
    ? `\n\n## บทสนทนาล่าสุด\n${recentConvos}`
    : "";

  const systemPrompt = buildMilinSystemPrompt(memory, vaultContext, weather, portfolioRaw) + contextNote;

  // Build message history: last stored turns + current user message.
  // History is always valid alternating pairs (stored as user+assistant), so no sanitization needed.
  const messages: Anthropic.MessageParam[] = [
    ...(memory.recentMessages || []).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user" as const, content: text },
  ];

  // System prompt cached as one ephemeral block. Cache hits when Max sends
  // back-to-back messages within 5 min — updateMemoryAsync is fire-and-forget
  // so the prompt is often identical between consecutive messages in a session.
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages,
  });

  const reply =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Always update memory — both emotional and knowledge conversations matter
  updateMemoryAsync(text, reply, memory, shouldSearchVault).catch(() => {});

  return reply;
}

async function updateMemoryAsync(
  userMessage: string,
  aiResponse: string,
  currentMemory: MilinMemory,
  wasVaultQuery: boolean
): Promise<void> {
  try {
    const extractPrompt = buildMemoryExtractPrompt(
      userMessage,
      aiResponse,
      wasVaultQuery
    );

    const extractResponse = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{ role: "user", content: extractPrompt }],
    });

    const raw =
      extractResponse.content[0].type === "text"
        ? extractResponse.content[0].text
        : "{}";

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const extract: MemoryExtract = JSON.parse(jsonMatch?.[0] || "{}");

    const today = new Date().toISOString().split("T")[0];
    const updates: Partial<MilinMemory> = {
      lastConversationAt: new Date().toISOString(),
    };

    if (extract.newFacts?.length) updates.aboutMax = extract.newFacts;
    if (extract.newPreferences?.length)
      updates.learnedPreferences = extract.newPreferences;
    if (extract.topicAsked)
      updates.topicsAsked = [extract.topicAsked];

    // Always record a conversation entry (not just when mood is detected)
    const summary = extract.importantTopic || userMessage.slice(0, 80);
    updates.importantConversations = [{
      date: today,
      summary,
      maxMood: extract.maxMood || undefined,
    }];

    // Mood update: verbatim keyword check first (fast), then semantic match on Haiku's maxMood
    const keywordMoodMap: Record<string, string> = {
      เครียด: "attentive and caring",
      เศร้า: "warm and supportive",
      มีความสุข: "playful and joyful",
      ตื่นเต้น: "excited and energetic",
    };
    for (const [key, mood] of Object.entries(keywordMoodMap)) {
      if (userMessage.includes(key)) {
        updates.currentMood = mood;
        break;
      }
    }

    // If no keyword hit, derive from Haiku's extracted maxMood
    if (!updates.currentMood && extract.maxMood) {
      const m = extract.maxMood.toLowerCase();
      const semanticMoodMap: [string[], string][] = [
        [["stress", "เครียด", "tired", "exhaust", "burnout", "งาน"], "attentive and caring"],
        [["sad", "เศร้า", "down", "lonely", "เหงา", "upset", "cry"], "warm and supportive"],
        [["happy", "มีความสุข", "ดีใจ", "สนุก", "great", "good"], "playful and joyful"],
        [["excit", "ตื่นเต้น", "hyped", "pumped", "hype"], "excited and energetic"],
        [["flirt", "playful", "teas", "cheeky"], "flirty and playful"],
        [["calm", "relax", "chill", "สงบ", "ผ่อน"], "calm and present"],
        [["curious", "interest", "สนใจ", "wonder", "think"], "curious and engaged"],
      ];
      for (const [keywords, mood] of semanticMoodMap) {
        if (keywords.some((k) => m.includes(k))) {
          updates.currentMood = mood;
          break;
        }
      }
    }

    await updateMilinMemory(updates);
  } catch {
    // Non-critical — don't surface memory update errors
  }
}
