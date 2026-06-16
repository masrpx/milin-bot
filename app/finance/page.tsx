import { notFound } from "next/navigation";
import {
  getTransactions,
  getMerchantMap,
  getTaxConfig,
  getBalances,
  listMonths,
  filterByMonth,
  summarize,
  cashInHand,
  formatTHB,
  type Transaction,
} from "@/lib/finance";
import { estimateTax } from "@/lib/finance-tax";

// Always read fresh from the vault; this is a private, low-traffic view.
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ token?: string; month?: string }>;
}

export default async function FinancePage({ searchParams }: PageProps) {
  const { token, month: monthParam } = await searchParams;

  // Single-user token gate. Unset secret or wrong token → 404 (don't reveal).
  const secret = process.env.FINANCE_DASHBOARD_TOKEN;
  if (!secret || token !== secret) notFound();

  const [{ items: transactions }, { map: merchantMap }, { config: taxConfig }, { items: balances }] =
    await Promise.all([getTransactions(), getMerchantMap(), getTaxConfig(), getBalances()]);
  const cash = cashInHand(balances);

  const months = listMonths(transactions);
  const month = monthParam && months.includes(monthParam) ? monthParam : months[0];
  const monthTx = month ? filterByMonth(transactions, month) : [];
  const summary = summarize(monthTx);

  // Tax estimate runs over the whole selected calendar year (YTD planning).
  const taxYear = month ? month.slice(0, 4) : String(new Date().getFullYear());
  const yearTx = transactions.filter((tx) => tx.date.startsWith(taxYear));
  const tax = estimateTax(yearTx, taxConfig);

  const link = (m: string) => `/finance?token=${encodeURIComponent(token!)}&month=${m}`;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8 font-sans text-zinc-900 dark:text-zinc-100">
      <h1 className="text-2xl font-semibold tracking-tight">การเงินของแม็ก</h1>

      {transactions.length === 0 ? (
        <p className="mt-6 text-zinc-500">
          ยังไม่มีรายการ — รัน <code>tsx scripts/finance-extract.ts</code> แล้วให้ Claude บันทึกเข้า vault ก่อนนะ
        </p>
      ) : (
        <>
          <MonthTabs months={months} active={month} link={link} />

          <section className="mt-6 grid grid-cols-3 gap-3">
            <Stat label="รายรับ" value={summary.income} tone="text-emerald-600" />
            <Stat label="รายจ่าย" value={summary.expense} tone="text-rose-600" />
            <Stat label="คงเหลือ" value={summary.net} tone={summary.net >= 0 ? "text-emerald-600" : "text-rose-600"} />
          </section>

          {cash.accounts.length > 0 && <CashPanel cash={cash} />}

          <CategoryBars title="รายจ่ายตามหมวด" data={summary.expenseByCategory} />
          {Object.keys(summary.incomeByCategory).length > 0 && (
            <CategoryBars title="รายรับตามหมวด" data={summary.incomeByCategory} barClass="bg-emerald-400" />
          )}

          <TaxPanel tax={tax} year={taxYear} />

          <TransactionTable transactions={monthTx} />

          <MerchantTable map={merchantMap} />
        </>
      )}
    </main>
  );
}

function MonthTabs({
  months,
  active,
  link,
}: {
  months: string[];
  active: string;
  link: (m: string) => string;
}) {
  return (
    <nav className="mt-4 flex flex-wrap gap-2">
      {months.map((m) => (
        <a
          key={m}
          href={link(m)}
          className={`rounded-full px-3 py-1 text-sm ${
            m === active
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
          }`}
        >
          {m}
        </a>
      ))}
    </nav>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tone}`}>{formatTHB(value)}</div>
    </div>
  );
}

function CategoryBars({
  title,
  data,
  barClass = "bg-rose-400",
}: {
  title: string;
  data: Record<string, number>;
  barClass?: string;
}) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map(([, v]) => v));
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium text-zinc-500">{title}</h2>
      <div className="mt-3 space-y-2">
        {rows.map(([name, value]) => (
          <div key={name} className="flex items-center gap-3">
            <div className="w-28 shrink-0 truncate text-sm">{name}</div>
            <div className="h-5 flex-1 rounded bg-zinc-100 dark:bg-zinc-800">
              <div
                className={`h-5 rounded ${barClass}`}
                style={{ width: `${Math.max(2, (value / max) * 100)}%` }}
              />
            </div>
            <div className="w-24 shrink-0 text-right text-sm tabular-nums">{formatTHB(value)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CashPanel({ cash }: { cash: ReturnType<typeof cashInHand> }) {
  return (
    <section className="mt-6 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-zinc-500">เงินสดในมือ</h2>
        <span className="text-xs text-zinc-400">ข้อมูล ณ {cash.asOf}</span>
      </div>
      <div className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">{formatTHB(cash.total)}</div>
      <div className="mt-2 space-y-1 text-sm">
        {cash.accounts.map((b) => (
          <div key={b.account} className="flex justify-between text-zinc-500">
            <span>{b.account}</span>
            <span className="tabular-nums">{formatTHB(b.balance)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TaxPanel({ tax, year }: { tax: ReturnType<typeof estimateTax>; year: string }) {
  return (
    <section className="mt-8 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-sm font-medium text-zinc-500">ภาษีปี {year} (ประมาณการ)</h2>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <Row label="รายได้รวม" value={tax.income.total} />
        <Row label="เงินเดือน" value={tax.income.salary} />
        <Row label="ฟรีแลนซ์" value={tax.income.freelance} />
        <Row label="หักค่าใช้จ่าย" value={tax.expenseDeduction} />
        <Row label="ค่าลดหย่อน" value={tax.allowances + tax.deductions} />
        <Row label="เงินได้สุทธิ" value={tax.taxableIncome} />
        <Row label="ภาษีโดยประมาณ" value={tax.estimatedTax} strong />
      </div>
      <h3 className="mt-4 text-xs font-medium text-zinc-500">ลดหย่อนที่ยังลงทุนเพิ่มได้</h3>
      <div className="mt-2 space-y-1 text-sm">
        {tax.room.map((r) => (
          <div key={r.bucket} className="flex justify-between">
            <span className="uppercase">{r.bucket.replace("_", " ")}</span>
            <span className="tabular-nums text-emerald-600">เหลือ {formatTHB(r.remaining)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Row({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-zinc-500">{label}</span>
      <span className={`tabular-nums ${strong ? "font-semibold" : ""}`}>{formatTHB(value)}</span>
    </div>
  );
}

function TransactionTable({ transactions }: { transactions: Transaction[] }) {
  const sorted = [...transactions].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium text-zinc-500">รายการ ({sorted.length})</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-zinc-400">
            <tr>
              <th className="py-1 pr-3">วันที่</th>
              <th className="py-1 pr-3">รายการ</th>
              <th className="py-1 pr-3">หมวด</th>
              <th className="py-1 pr-3 text-right">จำนวน</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((tx) => (
              <tr key={tx.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-1 pr-3 tabular-nums text-zinc-500">{tx.date}</td>
                <td className="py-1 pr-3">{tx.description}</td>
                <td className="py-1 pr-3 text-zinc-500">{tx.category}</td>
                <td
                  className={`py-1 pr-3 text-right tabular-nums ${
                    tx.direction === "income" ? "text-emerald-600" : "text-rose-600"
                  }`}
                >
                  {tx.direction === "income" ? "+" : "-"}
                  {formatTHB(tx.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MerchantTable({ map }: { map: Record<string, { category: string }> }) {
  const rows = Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
  if (rows.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium text-zinc-500">หมวดที่เรียนรู้ไว้ ({rows.length})</h2>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        {rows.map(([merchant, rule]) => (
          <div key={merchant} className="flex justify-between gap-2">
            <span className="truncate text-zinc-600 dark:text-zinc-400">{merchant}</span>
            <span className="shrink-0">{rule.category}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
