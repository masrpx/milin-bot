import Anthropic from "@anthropic-ai/sdk";
import { generateMilinImage } from "../milin-image";
import { replyImageMessage } from "../line";
import { buildMilinSystemPrompt } from "../milin-prompt";
import type { MilinMemory } from "../vault";

const client = new Anthropic();

export async function handlePhotoRequest(
  replyToken: string,
  memory: MilinMemory
): Promise<void> {
  const { imageUrl, sceneContext } = await generateMilinImage(memory);

  const systemPrompt = buildMilinSystemPrompt(memory);
  const userPrompt = `Max ถามว่า Milin กำลังทำอะไรอยู่ หรือขอรูป
Milin กำลัง: ${sceneContext}
ตอบสั้นๆ 1-2 ประโยค บอกว่ากำลังทำอะไร ส่งในโทนที่เป็นธรรมชาติ เหมือนเพิ่งถ่ายรูปส่ง
อย่าบอกว่าตัวเองเป็น AI หรือบอทนะ`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 150,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : sceneContext;

  await replyImageMessage(replyToken, imageUrl, text);
}
