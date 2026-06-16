import { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Finance data layer — shared by the local ingestion workbench
// (scripts/finance-extract.ts + in-session categorization) and Milin's
// read-only consumers (dashboard, chat queries, tax view).
//
// Storage mirrors lib/todo.ts: plain JSON files in the GitHub vault, read with
// their sha so callers can write back without an extra read, with a 409-retry
// to survive concurrent writes.
// ---------------------------------------------------------------------------

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_OWNER!;
const REPO = process.env.GITHUB_REPO!;

const TRANSACTIONS_PATH = "05 Milin/finance-transactions.json";
const MERCHANT_MAP_PATH = "05 Milin/finance-merchant-map.json";
const CATEGORIES_PATH = "05 Milin/finance-categories.json";
const TAX_CONFIG_PATH = "05 Milin/finance-tax.json";
const BALANCES_PATH = "05 Milin/finance-balances.json";

export type Direction = "income" | "expense";

/** Thai personal-income-tax deduction buckets a transaction can map to. */
export type TaxBucket =
  | "rmf"
  | "ssf"
  | "thai_esg"
  | "life_insurance"
  | "health_insurance"
  | "social_security"
  | "donation"
  | "mortgage_interest"
  | "business_expense"
  | "none";

/** Income subtype, used by the tax engine (salary vs freelance). */
export type IncomeType = "salary" | "freelance_40_2" | "freelance_40_6_8" | "other";

export interface Transaction {
  id: string;
  date: string; // YYYY-MM-DD
  direction: Direction;
  amount: number; // positive THB
  currency: string; // "THB"
  description: string; // raw merchant / memo from the statement
  category: string; // resolved category name (canonical list)
  taxBucket?: TaxBucket;
  incomeType?: IncomeType; // income rows only
  account: string; // account / card id, e.g. "kbank-savings"
  statementPeriod?: string; // YYYY-MM
  addedAt: string; // ISO
}

export interface Category {
  name: string;
  direction: Direction;
  defaultTaxBucket?: TaxBucket;
}

/** Learned merchant → category mapping; grows as we categorize. */
export interface MerchantRule {
  category: string;
  taxBucket?: TaxBucket;
}
export type MerchantMap = Record<string, MerchantRule>;

/**
 * Tax-time figures that don't appear on bank/card statements (allowance config
 * + deductions paid by other means). Captured via the `ภาษี:` chat command and
 * fed to the tax engine alongside transaction-derived deductions.
 */
export interface TaxConfig {
  taxYear: number;
  hasSpouseNoIncome: boolean;
  childrenCount: number;
  parentsSupported: number; // parents (self + spouse) you support, 30k each
  /** Manual deduction amounts, keyed by bucket; merged with transaction sums. */
  manualDeductions: Partial<Record<TaxBucket, number>>;
}

/** Snapshot of an account's running balance as of its latest parsed statement line. */
export interface AccountBalance {
  account: string;
  date: string; // YYYY-MM-DD, last transaction date on the statement
  balance: number; // THB
}

export function defaultTaxConfig(): TaxConfig {
  return {
    taxYear: new Date().getFullYear(),
    hasSpouseNoIncome: false,
    childrenCount: 0,
    parentsSupported: 0,
    manualDeductions: {},
  };
}

// ---------------------------------------------------------------------------
// Seeded canonical categories (Thai). Written on first run if the file is
// missing, same idea as SEED_READING_LIST. Max can edit afterwards.
// ---------------------------------------------------------------------------

export const SEED_CATEGORIES: Category[] = [
  // expenses
  { name: "อาหาร", direction: "expense" },
  { name: "เดินทาง", direction: "expense" },
  { name: "ช้อปปิ้ง", direction: "expense" },
  { name: "บิล/สาธารณูปโภค", direction: "expense" },
  { name: "สุขภาพ", direction: "expense", defaultTaxBucket: "health_insurance" },
  { name: "บันเทิง", direction: "expense" },
  { name: "การศึกษา", direction: "expense" },
  { name: "ลงทุน", direction: "expense" },
  { name: "ประกัน", direction: "expense", defaultTaxBucket: "life_insurance" },
  { name: "บริจาค", direction: "expense", defaultTaxBucket: "donation" },
  { name: "ค่าธรรมเนียม", direction: "expense" },
  { name: "ค่าใช้จ่ายฟรีแลนซ์", direction: "expense", defaultTaxBucket: "business_expense" },
  { name: "อื่นๆ", direction: "expense" },
  // income
  { name: "เงินเดือน", direction: "income" },
  { name: "ฟรีแลนซ์", direction: "income" },
  { name: "ดอกเบี้ย/ปันผล", direction: "income" },
  { name: "รายรับอื่นๆ", direction: "income" },
];

export function generateFinanceId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

// ---------------------------------------------------------------------------
// Generic vault JSON I/O (mirrors lib/todo.ts)
// ---------------------------------------------------------------------------

async function readJsonFile<T>(path: string, fallback: T): Promise<{ data: T; sha?: string }> {
  try {
    const res = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path });
    if (!("content" in res.data)) return { data: fallback };
    const raw = Buffer.from(res.data.content, "base64").toString("utf-8");
    return { data: JSON.parse(raw) as T, sha: res.data.sha };
  } catch {
    return { data: fallback };
  }
}

async function writeJsonFile<T>(path: string, data: T, sha?: string): Promise<void> {
  const content = Buffer.from(JSON.stringify(data, null, 2), "utf-8").toString("base64");
  const write = (currentSha?: string) =>
    octokit.repos.createOrUpdateFileContents({
      owner: OWNER,
      repo: REPO,
      path,
      message: `milin: update ${path.split("/").pop()}`,
      content,
      ...(currentSha ? { sha: currentSha } : {}),
    });
  try {
    await write(sha);
  } catch (err: unknown) {
    if ((err as { status?: number }).status === 409) {
      const fresh = await readJsonFile<T>(path, data);
      await write(fresh.sha);
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export async function getTransactions(): Promise<{ items: Transaction[]; sha?: string }> {
  const { data, sha } = await readJsonFile<Transaction[]>(TRANSACTIONS_PATH, []);
  return { items: data, sha };
}

export async function saveTransactions(items: Transaction[], sha?: string): Promise<void> {
  const resolvedSha = sha ?? (await readJsonFile<Transaction[]>(TRANSACTIONS_PATH, [])).sha;
  await writeJsonFile(TRANSACTIONS_PATH, items, resolvedSha);
}

// ---------------------------------------------------------------------------
// Merchant map (learned category table)
// ---------------------------------------------------------------------------

export async function getMerchantMap(): Promise<{ map: MerchantMap; sha?: string }> {
  const { data, sha } = await readJsonFile<MerchantMap>(MERCHANT_MAP_PATH, {});
  return { map: data, sha };
}

export async function saveMerchantMap(map: MerchantMap, sha?: string): Promise<void> {
  const resolvedSha = sha ?? (await readJsonFile<MerchantMap>(MERCHANT_MAP_PATH, {})).sha;
  await writeJsonFile(MERCHANT_MAP_PATH, map, resolvedSha);
}

// ---------------------------------------------------------------------------
// Categories (canonical list; seeded on first read)
// ---------------------------------------------------------------------------

export async function getCategories(): Promise<{ items: Category[]; sha?: string }> {
  const { data, sha } = await readJsonFile<Category[] | null>(CATEGORIES_PATH, null);
  if (!data || data.length === 0) return { items: SEED_CATEGORIES };
  return { items: data, sha };
}

export async function saveCategories(items: Category[], sha?: string): Promise<void> {
  const resolvedSha = sha ?? (await readJsonFile<Category[]>(CATEGORIES_PATH, [])).sha;
  await writeJsonFile(CATEGORIES_PATH, items, resolvedSha);
}

// ---------------------------------------------------------------------------
// Tax config
// ---------------------------------------------------------------------------

export async function getTaxConfig(): Promise<{ config: TaxConfig; sha?: string }> {
  const { data, sha } = await readJsonFile<TaxConfig | null>(TAX_CONFIG_PATH, null);
  return { config: { ...defaultTaxConfig(), ...(data ?? {}) }, sha };
}

export async function saveTaxConfig(config: TaxConfig, sha?: string): Promise<void> {
  const resolvedSha = sha ?? (await readJsonFile<TaxConfig>(TAX_CONFIG_PATH, defaultTaxConfig())).sha;
  await writeJsonFile(TAX_CONFIG_PATH, config, resolvedSha);
}

// ---------------------------------------------------------------------------
// Account balances (cash on hand, from savings-account statements)
// ---------------------------------------------------------------------------

export async function getBalances(): Promise<{ items: AccountBalance[]; sha?: string }> {
  const { data, sha } = await readJsonFile<AccountBalance[]>(BALANCES_PATH, []);
  return { items: data, sha };
}

/** Balances are a snapshot keyed by account, not an append log — incoming replaces existing per account. */
export async function saveBalances(items: AccountBalance[], sha?: string): Promise<void> {
  const resolvedSha = sha ?? (await readJsonFile<AccountBalance[]>(BALANCES_PATH, [])).sha;
  await writeJsonFile(BALANCES_PATH, items, resolvedSha);
}

// ---------------------------------------------------------------------------
// Merchant normalization + categorization + dedup
// ---------------------------------------------------------------------------

/**
 * Collapse statement-line noise so the same merchant maps to one key:
 * "STARBUCKS #4412 BKK 12/05" and "STARBUCKS CENTRAL WORLD" → "starbucks".
 * Strips digits, store/ref numbers, punctuation, and common payment prefixes.
 */
export function normalizeMerchant(description: string): string {
  return description
    .toLowerCase()
    .replace(/[#*]/g, " ")
    .replace(/\b(pos|payment|purchase|debit|credit|trf|transfer|ref|no|x{2,})\b/g, " ")
    .replace(/[0-9]+/g, " ")
    .replace(/[^a-z฀-๿]+/g, " ") // keep latin + Thai letters
    .replace(/\s+/g, " ")
    .trim();
}

/** Look up a learned rule for this transaction. Returns null on a miss. */
export function categorize(description: string, map: MerchantMap): MerchantRule | null {
  return map[normalizeMerchant(description)] ?? null;
}

/** Stable identity for a transaction, used for dedup across overlapping statements. */
export function transactionKey(tx: Pick<Transaction, "date" | "amount" | "direction" | "description" | "account">): string {
  return [tx.date, tx.amount, tx.direction, normalizeMerchant(tx.description), tx.account].join("|");
}

/** Return only the incoming transactions not already present in `existing`. */
export function dedupeTransactions(existing: Transaction[], incoming: Transaction[]): Transaction[] {
  const seen = new Set(existing.map(transactionKey));
  const out: Transaction[] = [];
  for (const tx of incoming) {
    const key = transactionKey(tx);
    if (seen.has(key)) continue;
    seen.add(key); // also guards against duplicates within the incoming batch
    out.push(tx);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation (pure) — shared by the dashboard and the chat query handler
// ---------------------------------------------------------------------------

/** "YYYY-MM" the transaction falls in. */
export function txMonth(tx: Transaction): string {
  return tx.date.slice(0, 7);
}

/** Distinct months present, newest first. */
export function listMonths(transactions: Transaction[]): string[] {
  return [...new Set(transactions.map(txMonth))].sort().reverse();
}

export function filterByMonth(transactions: Transaction[], month: string): Transaction[] {
  return transactions.filter((tx) => txMonth(tx) === month);
}

export interface PeriodSummary {
  income: number;
  expense: number;
  net: number;
  expenseByCategory: Record<string, number>;
  incomeByCategory: Record<string, number>;
}

export function summarize(transactions: Transaction[]): PeriodSummary {
  const summary: PeriodSummary = {
    income: 0,
    expense: 0,
    net: 0,
    expenseByCategory: {},
    incomeByCategory: {},
  };
  for (const tx of transactions) {
    const bucket = tx.direction === "income" ? summary.incomeByCategory : summary.expenseByCategory;
    bucket[tx.category] = (bucket[tx.category] ?? 0) + tx.amount;
    if (tx.direction === "income") summary.income += tx.amount;
    else summary.expense += tx.amount;
  }
  summary.net = summary.income - summary.expense;
  return summary;
}

/** THB formatting helper for UI + chat. */
export function formatTHB(amount: number): string {
  return amount.toLocaleString("th-TH", { maximumFractionDigits: 0 }) + " ฿";
}

export interface CashInHand {
  total: number;
  /** Oldest of the per-account snapshot dates — the total is only as fresh as its stalest account. */
  asOf: string;
  accounts: AccountBalance[];
}

/** Sum cash-account balances; only meaningful for savings/checking, not credit cards (debt, not cash). */
export function cashInHand(balances: AccountBalance[]): CashInHand {
  const total = balances.reduce((sum, b) => sum + b.balance, 0);
  const asOf = balances.length ? [...balances].sort((a, b) => a.date.localeCompare(b.date))[0].date : "";
  return { total, asOf, accounts: balances };
}
