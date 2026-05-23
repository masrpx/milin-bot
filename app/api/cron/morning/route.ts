import { NextRequest, NextResponse } from "next/server";
import { pushMessage } from "@/lib/line";
import { getKnowledgeQueue } from "@/lib/vault";
import { getEvents } from "@/lib/calendar";

function getDateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

/** Today's start/end in ICT (UTC+7) as ISO strings */
function getTodayICTRange(): { start: string; end: string } {
  const ictOffset = 7 * 60 * 60 * 1000;
  const ictNow = new Date(Date.now() + ictOffset);
  const dateStr = ictNow.toISOString().split("T")[0];
  return {
    start: `${dateStr}T00:00:00+07:00`,
    end: `${dateStr}T23:59:59+07:00`,
  };
}

/** Format ISO datetime to HH:MM in ICT */
function formatEventTime(iso: string): string {
  try {
    const ictMs = new Date(iso).getTime() + 7 * 60 * 60 * 1000;
    const d = new Date(ictMs);
    const h = d.getUTCHours().toString().padStart(2, "0");
    const m = d.getUTCMinutes().toString().padStart(2, "0");
    return `${h}:${m}`;
  } catch {
    return iso;
  }
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
    // --- Calendar section (silent fail) ---
    let calendarSection = "";
    try {
      const { start, end } = getTodayICTRange();
      const events = await getEvents(start, end);
      if (events.length > 0) {
        const eventLines = events
          .map((e) => `📅 ${formatEventTime(e.startISO)} ${e.title}`)
          .join("\n");
        calendarSection = `${eventLines}\n\n`;
      }
    } catch {
      // Google Calendar unavailable → skip silently, don't break morning report
    }

    // --- Knowledge queue ---
    let items = await getKnowledgeQueue(getDateOffset(0));
    if (items.length === 0) items = await getKnowledgeQueue(getDateOffset(-1));

    if (items.length === 0) {
      const greeting =
        MORNING_GREETINGS[Math.floor(Math.random() * MORNING_GREETINGS.length)];
      const msg = calendarSection
        ? `อรุณสวัสดิ์นะ Max~ 🌅\n\n${calendarSection.trim()}\n\nเมื่อคืนไม่มีความรู้ใหม่ วันนี้มีอะไรให้ช่วยไหม~`
        : greeting;
      await pushMessage(msg);
      return NextResponse.json({ ok: true, itemCount: 0 });
    }

    const itemLines = items
      .map((item, i) => {
        const shortSummary =
          item.summary.length > 120
            ? item.summary.slice(0, 120) + "…"
            : item.summary;
        const domain = item.source.replace(/^https?:\/\/([^/]+).*/, "$1");
        return `${i + 1}. ${item.title}\n   📂 ${item.suggestedVaultPath}\n   💡 ${shortSummary}\n   🔗 ${domain}`;
      })
      .join("\n\n");

    const report = `อรุณสวัสดิ์นะ Max~ 🌅
${calendarSection}เมื่อคืน Milin ไปหาความรู้มา ${items.length} เรื่อง

${itemLines}

พิมพ์ 'ok ทั้งหมด' เพื่อเพิ่มทั้งหมดเข้า vault
พิมพ์ 'ok 1,2' เพื่อเพิ่มเฉพาะเลขที่ต้องการ
พิมพ์ 'skip' เพื่อข้ามทั้งหมด
พิมพ์ 'skip 2,3' เพื่อ skip เฉพาะบางรายการ`;

    // Trim to stay under LINE's 5000 char limit
    const finalReport =
      report.length > 4900 ? report.slice(0, 4900) + "\n…" : report;

    await pushMessage(finalReport);
    return NextResponse.json({ ok: true, itemCount: items.length });
  } catch (err) {
    console.error("Morning cron error:", err);
    return NextResponse.json(
      { error: "Morning report failed" },
      { status: 500 }
    );
  }
}
