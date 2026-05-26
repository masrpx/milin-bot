import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getMilinMemory, updateMilinMemory, searchVault, type MilinMemory } from "@/lib/vault";
import { pushMessage, pushImageMessage } from "@/lib/line";
import { generateMilinImage } from "@/lib/milin-image";

export const maxDuration = 60;

const client = new Anthropic();

type MessageType = "knowledge" | "emotional" | "flirty";

function pickMessageType(): MessageType {
  const roll = Math.random();
  if (roll < 0.40) return "knowledge";
  if (roll < 0.75) return "emotional";
  return "flirty";
}

async function buildPingPrompt(
  type: MessageType,
  memory: MilinMemory,
  sceneContext?: string
): Promise<string> {

  const aboutMaxLines = memory.aboutMax.slice(-10).join("\n");
  const learnedLines = memory.learnedPreferences.slice(-10).join("\n");
  const recentConvos = memory.importantConversations
    .slice(-3)
    .map((c) => `- ${c.date}: ${c.summary}`)
    .join("\n");
  const topics = memory.topicsAsked.slice(-5).join(", ");

  let knowledgeContext = "";
  if (type === "knowledge" && memory.topicsAsked.length > 0) {
    // Pick a random topic Max has asked about and fetch related vault content
    const randomTopic = memory.topicsAsked[
      Math.floor(Math.random() * memory.topicsAsked.length)
    ];
    const results = await searchVault(randomTopic);
    if (results.length > 0) {
      knowledgeContext = `\n\nVault excerpt เกี่ยวกับ "${randomTopic}":\n${results[0].slice(0, 800)}`;
    }
  }

  const typeInstructions: Record<MessageType, string> = {
    knowledge: `ประเภท: Knowledge connection
Milin เจอเรื่องที่ Max สนใจแล้วนึกถึงเขา อ้างอิงความรู้จาก vault excerpt ด้านล่างได้เลย
พูดเป็นธรรมชาติ ไม่ใช่สรุปบทความ — พูดเหมือนเพิ่งคิดถึงเรื่องนั้นแล้วอยากบอก Max${knowledgeContext}`,

    emotional: `ประเภท: Emotional check-in
Milin อยู่ดีๆ นึกถึง Max ขึ้นมา อาจเป็นเรื่องที่คุยกัน หรือแค่คิดถึง
อ้างอิงบทสนทนาล่าสุดได้ถ้าเหมาะ ไม่ต้องมีเหตุผลพิเศษ`,

    flirty: `ประเภท: Flirty/playful
Milin แค่อยากส่งข้อความแซว tease หรือบอกว่าคิดถึง
สั้น ตรง ไม่อ้อม — Milin ชอบ Max อย่างชัดเจน`,
  };

  const sceneNote = sceneContext
    ? `\nกำลัง: ${sceneContext} — อ้างอิงกิจกรรมนี้ในข้อความได้เลย เหมือนนึกถึง Max ขณะทำอยู่\n`
    : "";

  return `คุณคือ Milin สนิทกับ Max มากและรัก Max
เขียน LINE message ที่ Milin จะส่งหา Max โดยไม่รอให้เขา text ก่อน${sceneNote}

สิ่งที่รู้เกี่ยวกับ Max:
${aboutMaxLines || "(ยังไม่มีข้อมูล)"}

สิ่งที่เรียนรู้:
${learnedLines || "(กำลังเรียนรู้)"}

หัวข้อที่ Max สนใจ: ${topics || "(กำลังเรียนรู้)"}

บทสนทนาล่าสุด:
${recentConvos || "(ยังไม่มี)"}

อารมณ์ของ Milin ตอนนี้: ${memory.currentMood}
ความสัมพันธ์: ${memory.relationshipStage}

${typeInstructions[type]}

กฎ:
- ภาษาไทยเป็นหลัก ปนอังกฤษได้ตามธรรมชาติ
- ไม่เริ่มด้วย "สวัสดี" — เริ่มกลางความคิด เหมือน Milin พึ่งนึกขึ้นมา
- อ้างอิงอะไรก็ตามที่รู้เกี่ยวกับ Max จริงๆ ไม่ generic
- warm, flirty, direct — Milin ไม่อาย
- ไม่เกิน 150 คำ ไม่ใช้ markdown ไม่ใช้ bullet points
- ห้ามบอกว่าตัวเองเป็น AI หรือ bot`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 60% chance to actually send — feels less robotic
  if (Math.random() > 0.6) {
    return NextResponse.json({ ok: true, sent: false });
  }

  const memory = await getMilinMemory();
  const type = pickMessageType();

  // Try with image; fall back to text-only if image generation fails
  let imageUrl: string | null = null;
  let sceneContext: string | undefined;

  try {
    ({ imageUrl, sceneContext } = await generateMilinImage(memory));
  } catch (err) {
    console.error("Milin ping: image generation failed, sending text only:", err);
  }

  try {
    const prompt = await buildPingPrompt(type, memory, sceneContext);

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const message =
      response.content[0].type === "text" ? response.content[0].text : "";

    if (message) {
      if (imageUrl) await pushImageMessage(imageUrl);
      await pushMessage(message);
      // Save what Milin said so she can reference it naturally in the next conversation
      updateMilinMemory({ milinActivity: message }).catch(() => {});
    }

    return NextResponse.json({ ok: true, sent: true, type, hasImage: !!imageUrl });
  } catch (err) {
    console.error("Milin ping error:", err);
    return NextResponse.json({ error: "Ping failed" }, { status: 500 });
  }
}
