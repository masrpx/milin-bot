import Anthropic from "@anthropic-ai/sdk";
import { searchVault, getMilinMemory } from "../vault";
import { buildMilinSystemPrompt } from "../milin-prompt";

const client = new Anthropic();

export async function handleQuery(
  text: string,
  memory: Awaited<ReturnType<typeof getMilinMemory>>
): Promise<string> {
  const vaultResults = await searchVault(text);
  const vaultContext = vaultResults.length
    ? vaultResults.join("\n\n---\n\n")
    : "ไม่พบข้อมูลที่เกี่ยวข้องใน vault";

  const systemPrompt = buildMilinSystemPrompt(memory, vaultContext);

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: "user", content: text }],
  });

  const answer =
    response.content[0].type === "text" ? response.content[0].text : "";

  if (vaultResults.length > 0) {
    const foundPrefix =
      ["เจอแล้ว~ ", "หาเจอแล้วนะ ", ""][Math.floor(Math.random() * 3)];
    return foundPrefix + answer;
  }

  return answer;
}
