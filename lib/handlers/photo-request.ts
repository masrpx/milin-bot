import Anthropic from "@anthropic-ai/sdk";
import { generateMilinImage } from "../milin-image";
import { replyImageMessage, replyMessage } from "../line";
import { buildMilinSystemPrompt } from "../milin-prompt";
import type { MilinMemory } from "../vault";

const client = new Anthropic({ maxRetries: 4 });

export async function handlePhotoRequest(
  replyToken: string,
  memory: MilinMemory
): Promise<void> {
  let imageUrl: string;
  let sceneContext: string;

  try {
    ({ imageUrl, sceneContext } = await generateMilinImage(memory));
  } catch (err) {
    // Image generation failed (billing, quota, network) — reply with text only
    console.error("handlePhotoRequest: image generation failed:", err);
    const systemPrompt = buildMilinSystemPrompt(memory);
    const fallbackRes = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: "user", content: "แม็ก ขอรูป แต่ มิลิน หารูปส่งไม่ได้ตอนนี้ ตอบสั้นๆ แบบ มิลิน ว่าตอนนี้ทำอะไรอยู่ โดยไม่มีรูป" }],
    });
    const fallbackText =
      fallbackRes.content[0].type === "text"
        ? fallbackRes.content[0].text
        : "ตอนนี้กำลังยุ่งอยู่นิดหน่อย ส่งรูปทีหลังนะ~";
    await replyMessage(replyToken, fallbackText);
    return;
  }

  const systemPrompt = buildMilinSystemPrompt(memory);
  const userPrompt = `แม็ก ถามว่า มิลิน กำลังทำอะไรอยู่ หรือขอรูป
มิลิน กำลัง: ${sceneContext}
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
