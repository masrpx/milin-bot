import {
  getKnowledgeQueue,
  approveKnowledgeItem,
  deleteKnowledgeQueue,
} from "../vault";

function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

function parseApproveCommand(text: string): {
  action: "ok_all" | "ok_specific" | "skip_all" | "skip_specific";
  indices?: number[];
} {
  const t = text.trim().toLowerCase();

  if (t === "ok all" || t === "ok ทั้งหมด") return { action: "ok_all" };
  if (t === "skip" || t === "ข้ามทั้งหมด") return { action: "skip_all" };

  const okMatch = t.match(/^ok\s+([\d,\s]+)$/);
  if (okMatch) {
    const indices = okMatch[1]
      .split(/[,\s]+/)
      .map((n) => parseInt(n.trim()) - 1)
      .filter((n) => !isNaN(n));
    return { action: "ok_specific", indices };
  }

  const skipMatch = t.match(/^skip\s+([\d,\s]+)$/);
  if (skipMatch) {
    const indices = skipMatch[1]
      .split(/[,\s]+/)
      .map((n) => parseInt(n.trim()) - 1)
      .filter((n) => !isNaN(n));
    return { action: "skip_specific", indices };
  }

  return { action: "skip_all" };
}

export function isApproveCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t === "ok all" ||
    t === "ok ทั้งหมด" ||
    t === "skip" ||
    t === "ข้ามทั้งหมด" ||
    /^ok\s+[\d,\s]+$/.test(t) ||
    /^skip\s+[\d,\s]+$/.test(t)
  );
}

export async function handleApprove(text: string): Promise<string> {
  const date = getYesterday();
  const items = await getKnowledgeQueue(date);

  if (items.length === 0) {
    return "ไม่มี notes ที่รอ approve อยู่นะ~";
  }

  const command = parseApproveCommand(text);
  const approvedTitles: string[] = [];

  if (command.action === "ok_all") {
    for (let i = 0; i < items.length; i++) {
      await approveKnowledgeItem(date, i);
      approvedTitles.push(items[i].title);
    }
    await deleteKnowledgeQueue(date);

    return `เพิ่มเข้า vault แล้ว ${approvedTitles.length} notes 🗂️
${approvedTitles.map((t) => `- ${t}`).join("\n")}`;
  }

  if (command.action === "skip_all") {
    await deleteKnowledgeQueue(date);
    return "โอเค ลบทิ้งหมดแล้วนะ ไม่เป็นไร~";
  }

  if (command.action === "ok_specific" && command.indices) {
    const validIndices = command.indices.filter(
      (i) => i >= 0 && i < items.length
    );
    for (const i of validIndices) {
      await approveKnowledgeItem(date, i);
      approvedTitles.push(items[i].title);
    }
    await deleteKnowledgeQueue(date);

    return `เพิ่มเข้า vault แล้ว ${approvedTitles.length} notes 🗂️
${approvedTitles.map((t) => `- ${t}`).join("\n")}
ส่วนที่เหลือ Milin ลบทิ้งให้แล้วนะ`;
  }

  if (command.action === "skip_specific" && command.indices) {
    const skipSet = new Set(command.indices);
    for (let i = 0; i < items.length; i++) {
      if (!skipSet.has(i)) {
        await approveKnowledgeItem(date, i);
        approvedTitles.push(items[i].title);
      }
    }
    await deleteKnowledgeQueue(date);

    return `เพิ่มเข้า vault แล้ว ${approvedTitles.length} notes 🗂️
${approvedTitles.map((t) => `- ${t}`).join("\n")}
ส่วนที่ skip ลบทิ้งแล้วนะ~`;
  }

  return "ไม่เข้าใจคำสั่ง ลองพิมพ์ 'ok all', 'ok 1,2', หรือ 'skip' นะ";
}
