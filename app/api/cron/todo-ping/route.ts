import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { pushMessage } from "@/lib/line";
import { getInbox } from "@/lib/todo";
import { updateMilinMemory } from "@/lib/vault";

export const maxDuration = 30;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { items } = await getInbox();

    if (items.length === 0) {
      return NextResponse.json({ ok: true, sent: false, reason: "inbox empty" });
    }

    const lines = items.map((item, i) => `${i + 1}. ${item.text}`).join("\n");
    const message = `📥 inbox วันนี้ (${items.length} รายการ):\n${lines}\n\nตอบได้เลยว่าจะทำอะไรกับแต่ละรายการ:\nndn=เก็บทำทีหลัง, nvdn=ข้ามไปเลย, cal [เวลา]=ลงตาราง, del=ลบ\n\nเช่น: "1 ndn, 2 nvdn, 3 cal พฤหัส 14.00"`;

    await pushMessage(message);

    await updateMilinMemory({
      pendingAction: {
        type: "todo_classify",
        eventTitle: "",
        inboxSnapshot: items.map((i) => i.id),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    });

    return NextResponse.json({ ok: true, sent: true, itemCount: items.length });
  } catch (err) {
    Sentry.captureException(err);
    console.error("todo-ping cron error:", err);
    return NextResponse.json({ error: "todo-ping failed" }, { status: 500 });
  }
}
