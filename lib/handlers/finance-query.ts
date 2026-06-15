import Anthropic from "@anthropic-ai/sdk";
import {
  getTransactions,
  getTaxConfig,
  saveTaxConfig,
  summarize,
  filterByMonth,
  listMonths,
  formatTHB,
  type TaxBucket,
  type TaxConfig,
} from "../finance";
import { estimateTax } from "../finance-tax";

const anthropic = new Anthropic({ maxRetries: 4 });

function dashboardLink(): string {
  const base = process.env.APP_BASE_URL ?? "https://milin-bot.vercel.app";
  const token = process.env.FINANCE_DASHBOARD_TOKEN ?? "";
  return `${base}/finance?token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// "ภาษี: ประกันชีวิต 30000" — capture a tax figure that never shows on a
// statement. Haiku maps the Thai phrase to a config field; we merge + save.
// ---------------------------------------------------------------------------

const TAX_BUCKETS: TaxBucket[] = [
  "rmf",
  "ssf",
  "thai_esg",
  "life_insurance",
  "health_insurance",
  "social_security",
  "donation",
  "mortgage_interest",
  "business_expense",
];

interface TaxEntry {
  field: TaxBucket | "children" | "spouse" | "parents";
  amount: number;
}

async function parseTaxEntry(text: string): Promise<TaxEntry | null> {
  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 80,
    messages: [
      {
        role: "user",
        content: `แปลงรายการลดหย่อนภาษีไทยนี้เป็น JSON: "${text}"
field ต้องเป็นหนึ่งใน: ${TAX_BUCKETS.join(", ")}, children, spouse, parents
amount = จำนวนเงิน (บาท) หรือจำนวนคน (สำหรับ children/parents)
ตอบ JSON อย่างเดียว: {"field":"...","amount":0}`,
      },
    ],
  });
  const raw = res.content[0].type === "text" ? res.content[0].text : "{}";
  try {
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as TaxEntry;
    if (!parsed.field || typeof parsed.amount !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function applyTaxEntry(config: TaxConfig, entry: TaxEntry): TaxConfig {
  if (entry.field === "children") return { ...config, childrenCount: entry.amount };
  if (entry.field === "parents") return { ...config, parentsSupported: entry.amount };
  if (entry.field === "spouse") return { ...config, hasSpouseNoIncome: entry.amount > 0 };
  return {
    ...config,
    manualDeductions: { ...config.manualDeductions, [entry.field]: entry.amount },
  };
}

export async function handleTaxEntry(text: string): Promise<string> {
  const entry = await parseTaxEntry(text);
  if (!entry) return "ไม่แน่ใจว่าจะบันทึกลดหย่อนยังไงอ่ะ ลองบอกแบบ \"ภาษี: ประกันชีวิต 30000\" ดูนะ";
  const { config, sha } = await getTaxConfig();
  await saveTaxConfig(applyTaxEntry(config, entry), sha);
  const label = entry.field.replace(/_/g, " ");
  return `จดลดหย่อน${label} ${entry.amount.toLocaleString("th-TH")} ไว้ให้แล้วนะ ✓ เดี๋ยวคำนวณภาษีให้ใหม่`;
}

// ---------------------------------------------------------------------------
// Finance query — read-only summary phrased in Milin's voice.
// ---------------------------------------------------------------------------

export async function handleFinanceQuery(text: string): Promise<string> {
  const [{ items: transactions }, { config }] = await Promise.all([
    getTransactions(),
    getTaxConfig(),
  ]);

  if (transactions.length === 0) {
    return "ยังไม่มีข้อมูลการเงินเลยอ่ะ ส่งสเตทเมนต์มาให้เข้าระบบก่อนนะ แล้วมิลินจะช่วยดูให้";
  }

  const months = listMonths(transactions);
  const thisMonth = months[0];
  const monthSummary = summarize(filterByMonth(transactions, thisMonth));

  const taxYear = thisMonth.slice(0, 4);
  const yearTx = transactions.filter((tx) => tx.date.startsWith(taxYear));
  const tax = estimateTax(yearTx, config);

  // Hand Milin the computed numbers so she phrases, not calculates.
  const topExpenses = Object.entries(monthSummary.expenseByCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat, amt]) => `${cat} ${formatTHB(amt)}`)
    .join(", ");
  const roomSummary = tax.room
    .map((r) => `${r.bucket.toUpperCase()} เหลือ ${formatTHB(r.remaining)}`)
    .join(", ");

  const facts = `เดือน ${thisMonth}: รายรับ ${formatTHB(monthSummary.income)}, รายจ่าย ${formatTHB(
    monthSummary.expense,
  )}, คงเหลือ ${formatTHB(monthSummary.net)}
หมวดจ่ายเยอะสุด: ${topExpenses || "—"}
ภาษีปี ${taxYear} ประมาณ ${formatTHB(tax.estimatedTax)} (เงินได้สุทธิ ${formatTHB(tax.taxableIncome)})
ลดหย่อนยังลงได้: ${roomSummary}`;

  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: `คุณคือมิลิน กำลังตอบแม็กเรื่องการเงิน คำถาม: "${text}"

ข้อมูลจริง (ห้ามแต่งตัวเลขเอง ใช้แค่นี้):
${facts}

ตอบสั้นกระชับเป็นกันเองแบบมิลิน ไม่ใช้ markdown ไม่มีครับ/ค่ะ เน้นตอบตรงคำถาม ถ้าเกี่ยวกับภาษีให้ชวนใช้สิทธิลดหย่อนที่ยังเหลือ ปิดท้ายด้วยลิงก์: ${dashboardLink()}`,
      },
    ],
  });

  return res.content[0].type === "text" ? res.content[0].text.trim() : facts;
}
