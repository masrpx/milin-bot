import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { pushMessage } from "@/lib/line";
import { getMilinMemory } from "@/lib/vault";
import { fetchPortfolio } from "@/lib/portfolio";
import { buildMilinSystemPrompt, fetchBangkokWeather } from "@/lib/milin-prompt";

export const maxDuration = 60;

const client = new Anthropic();

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [portfolioRaw, memory, weather] = await Promise.all([
      fetchPortfolio(),
      getMilinMemory(),
      fetchBangkokWeather(),
    ]);

    if (!portfolioRaw) {
      return NextResponse.json({ ok: false, reason: "no portfolio data" });
    }

    const systemPrompt = buildMilinSystemPrompt(memory, undefined, weather, portfolioRaw);

    const userPrompt = `มิลินดูพอร์ตของแม็กประจำอาทิตย์นี้แล้ว เขียน LINE message สรุปให้แม็กโดย:
- บอก allocation ปัจจุบัน เทียบกับ target weight — ตัวไหน overweight/underweight
- ถ้ามี DCA entries ล่าสุด mention ได้
- ถ้าเห็น rebalance opportunity หรือ action ที่ควรทำ บอกตรงๆ
- ไม่เกิน 200 คำ ไม่ใช้ markdown ไม่ใช้ bullet points
- ไม่เริ่มด้วย "สวัสดี" ไม่ใส่วงเล็บเหลี่ยม [ ]`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userPrompt }],
    });

    const message = response.content[0].type === "text" ? response.content[0].text : "";
    if (message) await pushMessage(message);

    return NextResponse.json({ ok: true });
  } catch (err) {
    Sentry.captureException(err);
    console.error("Portfolio update cron error:", err);
    return NextResponse.json({ error: "Portfolio update failed" }, { status: 500 });
  }
}
