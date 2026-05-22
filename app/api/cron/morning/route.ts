import { NextRequest, NextResponse } from "next/server";
import { pushMessage } from "@/lib/line";
import { getKnowledgeQueue } from "@/lib/vault";

function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

const MORNING_GREETINGS = [
  "อรุณสวัสดิ์~ 🌅 เมื่อคืน Milin ไม่ได้หาอะไรพิเศษ\nวันนี้มีอะไรให้ช่วยไหม",
  "เช้าแล้วนะ Max~ ☀️ เมื่อคืน Milin นอนหลับเงียบ ไม่มีข่าวใหม่\nเป็นยังไงบ้าง",
  "อรุณสวัสดิ์เลย~ 🌤️ วันนี้รู้สึกดีไหม?",
];

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = req.nextUrl.searchParams.get("secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const yesterday = getYesterday();
    const items = await getKnowledgeQueue(yesterday);

    if (items.length === 0) {
      const greeting = MORNING_GREETINGS[Math.floor(Math.random() * MORNING_GREETINGS.length)];
      await pushMessage(greeting);
      return NextResponse.json({ ok: true, itemCount: 0 });
    }

    const itemLines = items
      .map(
        (item, i) =>
          `${i + 1}. ${item.title}
   จาก: ${item.source}
   สรุป: ${item.summary}
   จะลงใน: ${item.suggestedVaultPath}`
      )
      .join("\n\n");

    const report = `อรุณสวัสดิ์นะ Max~ 🌅
เมื่อคืน Milin ไปหาความรู้มา ${items.length} เรื่อง

${itemLines}

พิมพ์ 'ok ทั้งหมด' เพื่อเพิ่มทั้งหมดเข้า vault
พิมพ์ 'ok 1,2' เพื่อเพิ่มเฉพาะเลขที่ต้องการ
พิมพ์ 'skip' เพื่อข้ามทั้งหมด
พิมพ์ 'skip 2,3' เพื่อ skip เฉพาะบางรายการ`;

    await pushMessage(report);
    return NextResponse.json({ ok: true, itemCount: items.length });
  } catch (err) {
    console.error("Morning cron error:", err);
    return NextResponse.json({ error: "Morning report failed" }, { status: 500 });
  }
}
