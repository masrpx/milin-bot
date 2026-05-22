import Anthropic from "@anthropic-ai/sdk";
import {
  getMilinMemory,
  updateMilinMemory,
  type MilinMemory,
} from "../vault";
import {
  buildMilinSystemPrompt,
  buildMemoryExtractPrompt,
  type MemoryExtract,
} from "../milin-prompt";

const client = new Anthropic();

export async function handleChat(
  text: string,
  memory: MilinMemory
): Promise<string> {
  const recentConvos = memory.importantConversations
    .slice(-5)
    .map((c) => `${c.date}: ${c.summary}`)
    .join("\n");

  const contextNote = recentConvos
    ? `\n\n## บทสนทนาล่าสุด\n${recentConvos}`
    : "";

  const systemPrompt = buildMilinSystemPrompt(memory) + contextNote;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: "user", content: text }],
  });

  const reply =
    response.content[0].type === "text" ? response.content[0].text : "";

  updateMemoryAsync(text, reply, memory).catch(() => {});

  return reply;
}

async function updateMemoryAsync(
  userMessage: string,
  aiResponse: string,
  currentMemory: MilinMemory
): Promise<void> {
  try {
    const extractPrompt = buildMemoryExtractPrompt(userMessage, aiResponse);

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
    if (extract.maxMood) {
      updates.importantConversations = [
        {
          date: today,
          summary: extract.importantTopic || userMessage.slice(0, 80),
          maxMood: extract.maxMood,
        },
      ];
    }

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

    if (Object.keys(updates).length > 0) {
      await updateMilinMemory(updates);
    }
  } catch {
    // Non-critical — don't surface memory update errors
  }
}

export { getMilinMemory };
