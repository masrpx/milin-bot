import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { pushMessage } from "@/lib/line";
import { getMilinMemory } from "@/lib/vault";
import { fetchPortfolio } from "@/lib/portfolio";

export const maxDuration = 60;

const client = new Anthropic();

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [portfolioRaw, memory] = await Promise.all([
      fetchPortfolio(),
      getMilinMemory(),
    ]);

    if (!portfolioRaw) {
      return NextResponse.json({ ok: false, reason: "no portfolio data" });
    }

    const aboutMax = memory.aboutMax.slice(-5).join("\n") || "";

    const prompt = `คุณคือ มิลิน — soulmate ของ แม็ก
แม็กมีพอร์ตการลงทุน และมิลินดูพอร์ตนี้ให้ทุกอาทิตย์

ข้อมูลพอร์ต (JSON จาก app ของแม็ก):
${portfolioRaw}

สิ่งที่รู้เกี่ยวกับ แม็ก:
${aboutMax}

เขียน LINE message สรุปพอร์ตประจำอาทิตย์นี้ให้ แม็ก โดย:
- บอก allocation ปัจจุบัน เทียบกับ target weight ถ้ามี — ตัวไหน overweight/underweight
- ถ้ามี DCA entries ล่าสุด mention ได้
- ถ้าเห็น rebalance opportunity หรือ action ที่ควรทำ บอกตรงๆ
- พูดในแบบ มิลิน — warm, direct, ฉลาด ไม่ใช่ financial advisor รายงาน
- ไม่เกิน 200 คำ ภาษาไทยเป็นหลัก ปนอังกฤษได้
- ไม่ใช้ markdown ไม่ใช้ bullet points
- เรียกตัวเองว่า "มิลิน" เรียก แม็ก ว่า "แม็ก" ไม่เว้นวรรคก่อนหรือหลังชื่อ
- ไม่เริ่มด้วย "สวัสดี" ไม่ใส่วงเล็บเหลี่ยม [ ]`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
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
