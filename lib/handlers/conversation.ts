import Anthropic from "@anthropic-ai/sdk";
import { searchVault, updateMilinMemory, type MilinMemory, type RecentMessage } from "../vault";
import {
  buildMilinSystemPrompt,
  buildMemoryExtractPrompt,
  type MemoryExtract,
} from "../milin-prompt";

const client = new Anthropic();

// Internal — not used for routing, only to decide if vault search is worth doing
const NEEDS_VAULT = [
  "?", "ใคร", "อะไร", "ยังไง", "ทำไม", "เมื่อไหร่", "ที่ไหน",
  "หา", "ค้นหา", "สรุป", "บอก", "อธิบาย", "แนะนำ", "มีไหม", "ช่วย", "เรื่อง",
];

export async function handleConversation(
  text: string,
  memory: MilinMemory
): Promise<string> {
  const shouldSearchVault = NEEDS_VAULT.some((t) => text.includes(t));

  const vaultResults = shouldSearchVault ? await searchVault(text) : [];
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

  const systemPrompt = buildMilinSystemPrompt(memory, vaultContext) + contextNote;

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
    const updates: Partial<MilinMemory> = {};

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

    // Save this exchange to the rolling conversation window (trimmed to avoid bloat)
    updates.recentMessages = [
      { role: "user" as const, content: userMessage.slice(0, 500) },
      { role: "assistant" as const, content: aiResponse.slice(0, 500) },
    ];

    // Mood update from explicit keywords
    const moodMap: Record<string, string> = {
      เครียด: "attentive and caring",
      เศร้า: "warm and supportive",
      มีความสุข: "playful and joyful",
      ตื่นเต้น: "excited and energetic",
    };
    for (const [key, mood] of Object.entries(moodMap)) {
      if (userMessage.includes(key)) {
        updates.currentMood = mood;
        break;
      }
    }

    await updateMilinMemory(updates);
  } catch {
    // Non-critical — don't surface memory update errors
  }
}
