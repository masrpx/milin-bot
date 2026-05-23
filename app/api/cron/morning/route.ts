import { NextRequest, NextResponse } from "next/server";
import { pushMessage } from "@/lib/line";
import { getKnowledgeQueue } from "@/lib/vault";

function getDateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
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
    // Check today first (for manual testing), then yesterday (production: research runs ~7h before morning)
    let items = await getKnowledgeQueue(getDateOffset(0));
    if (items.length === 0) items = await getKnowledgeQueue(getDateOffset(-1));

    if (items.length === 0) {
      const greeting = MORNING_GREETINGS[Math.floor(Math.random() * MORNING_GREETINGS.length)];
      await pushMessage(greeting);
      return NextResponse.json({ ok: true, itemCount: 0 });
    }

    const itemLines = items
      .map((item, i) => {
        const shortSummary = item.summary.length > 120
          ? item.summary.slice(0, 120) + "…"
          : item.summary;
        const domain = item.source.replace(/^https?:\/\/([^/]+).*/, "$1");
        return `${i + 1}. ${item.title}\n   📂 ${item.suggestedVaultPath}\n   💡 ${shortSummary}\n   🔗 ${domain}`;
      })
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
