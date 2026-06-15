/**
 * Parse all KBank statement .txt files → statements/ingest-draft.json
 *
 * Reads:  statements/KBGC_*.txt  (credit cards)
 *         statements/STM_SA*.txt (savings accounts)
 * Writes: statements/ingest-draft.json
 *
 * Then run: tsx scripts/finance-ingest.ts [--commit]
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

const STATEMENTS_DIR = path.resolve(process.cwd(), "statements");
const DRAFT_PATH = path.join(STATEMENTS_DIR, "ingest-draft.json");
const NOW = new Date().toISOString();

// ---------------------------------------------------------------------------
// Types (mirrors lib/finance.ts — kept local to avoid octokit init at import)
// ---------------------------------------------------------------------------

type Direction = "income" | "expense";
type TaxBucket =
  | "rmf" | "ssf" | "thai_esg" | "life_insurance" | "health_insurance"
  | "social_security" | "donation" | "mortgage_interest" | "business_expense" | "none";

interface Transaction {
  id: string;
  date: string;
  direction: Direction;
  amount: number;
  currency: string;
  description: string;
  category: string;
  taxBucket?: TaxBucket;
  incomeType?: string;
  account: string;
  statementPeriod?: string;
  addedAt: string;
}

interface Rule {
  pattern: RegExp;
  category: string;
  taxBucket?: TaxBucket;
}

// ---------------------------------------------------------------------------
// Categorization rules
// ---------------------------------------------------------------------------

const CC_SKIP = [
  /PAYMENT - THANK YOU/i,
  /PREVIOUS BALANCE/i,
  /CASH REBATE/i,
  /TOTAL BALANCE/i,
  /INTEREST CHARGE/i,
];

const CC_RULES: Rule[] = [
  // Marketing (business expense)
  { pattern: /google ads/i,                        category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /facebk|facebook\.com/i,              category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /tiktok ads|omise\*tiktok/i,          category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /lineofficialaccou/i,                 category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  // Software / tools (business expense)
  { pattern: /canva/i,                             category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /zoom\.com/i,                         category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /google workspace/i,                  category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /claude\.ai/i,                        category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /anthropic/i,                         category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /openai|chatgpt/i,                    category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /adobe/i,                             category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /omise\*flowaccount/i,                category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /speechtext/i,                        category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /pdfleader/i,                         category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /alibaba/i,                           category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  // Transport
  { pattern: /www\.grab\.com|grabtaxi/i,           category: "เดินทาง" },
  { pattern: /www\.tesla\.com/i,                   category: "เดินทาง" },
  { pattern: /evst\.|wiyada petroleum/i,           category: "เดินทาง" },
  { pattern: /sri rat|expressway|sct-susco/i,      category: "เดินทาง" },
  { pattern: /ptt สเตชั่น|ptt station/i,           category: "เดินทาง" },
  // Food delivery
  { pattern: /line man wongnai|pf_line man/i,      category: "อาหาร" },
  { pattern: /lpth\*pf_lm_|lpth\*lp_lm_/i,        category: "อาหาร" },
  // Dining
  { pattern: /katei shabu|mo-mo paradise/i,        category: "อาหาร" },
  { pattern: /hanaya japanese|kaze no sushi/i,     category: "อาหาร" },
  { pattern: /soba house|bul go gi|saemaeul/i,     category: "อาหาร" },
  { pattern: /shabu baru|masaru shabu|tonkatsu/i,  category: "อาหาร" },
  { pattern: /sendai ramen|ginger farm/i,          category: "อาหาร" },
  { pattern: /thongsmith|tana curry/i,             category: "อาหาร" },
  { pattern: /pizza company|red panda/i,           category: "อาหาร" },
  { pattern: /amdaeng|nong geng ji/i,              category: "อาหาร" },
  { pattern: /ruan mae|you and i/i,                category: "อาหาร" },
  { pattern: /sf-|sf cinema|sf movie/i,            category: "บันเทิง" },
  { pattern: /ott-|major cineplex/i,               category: "บันเทิง" },
  { pattern: /kinokuniya|asia books/i,             category: "ช้อปปิ้ง" },
  { pattern: /tesco lotus|tops-|villa market/i,    category: "อาหาร" },
  { pattern: /aoringo|psp cuisine|yonny|rosniyom|คำปันไก่/i, category: "อาหาร" },
  { pattern: /the mall.*food|food.*mall/i,         category: "อาหาร" },
  { pattern: /central/i,                           category: "ช้อปปิ้ง" },
  // Shopping
  { pattern: /\(for shopee\)|shopeeth|airpay.*shopee/i, category: "ช้อปปิ้ง" },
  { pattern: /lineshoppingth/i,                    category: "ช้อปปิ้ง" },
  { pattern: /central dept/i,                      category: "ช้อปปิ้ง" },
  { pattern: /eveandboy/i,                         category: "ช้อปปิ้ง" },
  { pattern: /robbie market|2c2p\*robbie/i,        category: "ช้อปปิ้ง" },
  { pattern: /chaiya charoenkij/i,                 category: "ช้อปปิ้ง" },
  { pattern: /wisdom x lalanros/i,                 category: "ช้อปปิ้ง" },
  // Entertainment / streaming
  { pattern: /netflix/i,                           category: "บันเทิง" },
  { pattern: /disney plus/i,                       category: "บันเทิง" },
  { pattern: /hbomax/i,                            category: "บันเทิง" },
  { pattern: /youtube.*premium/i,                  category: "บันเทิง" },
  { pattern: /amazon prime/i,                      category: "บันเทิง" },
  // Gaming
  { pattern: /steam purchase/i,                    category: "บันเทิง" },
  { pattern: /kuro games|wuthering waves|gryphline/i, category: "บันเทิง" },
  // Subscriptions (personal digital)
  { pattern: /apple\.com\/bill/i,                  category: "บันเทิง" },
  { pattern: /google one/i,                        category: "บิล/สาธารณูปโภค" },
  // Healthcare
  { pattern: /phyathai|siriraj|destinysoln/i,     category: "สุขภาพ" },
  // Fitness / beauty
  { pattern: /move private fitness|inspire fitness|kaew pilates/i, category: "สุขภาพ" },
  { pattern: /esthegrity/i,                        category: "สุขภาพ" },
  // Travel
  { pattern: /traveloka|agoda/i,                   category: "ท่องเที่ยว" },
  { pattern: /^ALP\*/,                             category: "ท่องเที่ยว" },
  // Insurance
  { pattern: /allianz ayudhya/i,                   category: "ประกัน", taxBucket: "life_insurance" },
  // Electronics
  { pattern: /powerbuy|telewiz/i,                  category: "อิเล็กทรอนิกส์" },
  // Phone / internet
  { pattern: /amp\*ais|ais services/i,             category: "บิล/สาธารณูปโภค" },
  // Personal software (non-business)
  { pattern: /obsidian|capcut/i,                   category: "บันเทิง" },
];

const SA_INCOME_RULES: Rule[] = [
  { pattern: /รัชตกายา.*payroll|payroll.*รัชตกา/i, category: "เงินเดือน" },
  { pattern: /บจก\.?\s*รัชตกา(?!ยา)/,              category: "ฟรีแลนซ์" },
  { pattern: /ริชแมน|richman/i,                    category: "ฟรีแลนซ์" },
  { pattern: /ธุรกรรม ตปท|รับเงินธุรกรรม/,          category: "ฟรีแลนซ์" },
  { pattern: /ไลค์อะเซอ/,                           category: "รายรับอื่นๆ" },
];

const SA_EXPENSE_RULES: Rule[] = [
  { pattern: /ริชแมน|richman/i,                        category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /แลนด์มาร์ค/,                             category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /ศูนย์อบรม/,                              category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /จัดหางาน/,                               category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /ซีเอ็มเอ/,                               category: "ค่าใช้จ่ายฟรีแลนซ์", taxBucket: "business_expense" },
  { pattern: /กองทุนกสิกรไทย|หลักทรัพย์จัดการกองทุน/, category: "ลงทุน",         taxBucket: "ssf" },
  { pattern: /มูลนิธิเด็กโสสะ/,                       category: "บริจาค",        taxBucket: "donation" },
  { pattern: /ธนาคารทิสโก้/,                          category: "ผ่อนชำระ" },
  { pattern: /ส\.?ป\.?ส\.|ชำระเงินสมทบมาตรา/,         category: "ประกันสังคม",   taxBucket: "social_security" },
  { pattern: /เมืองไทยประกัน/,                        category: "ประกัน",        taxBucket: "life_insurance" },
  { pattern: /เอไอเอส|ais(?!\s+services)/i,           category: "บิล/สาธารณูปโภค" },
  { pattern: /ทราเวลโลก้า|traveloka/i,                category: "ท่องเที่ยว" },
  { pattern: /วัดพนัญเชิง/,                           category: "บริจาค",        taxBucket: "donation" },
  { pattern: /เอ็มทีเอส โกลด์/,                      category: "ลงทุน" },
  { pattern: /พีทีที|ptt/i,                           category: "เดินทาง" },
];

// Lines in SA files that are always skips
const SA_SKIP_PATTERNS = [
  /บัตรกสิกรไทย/,                               // CC bill payments
  /โอนไป.*(นาย |น\.ส\. |นาง)/,                  // transfers to individuals (incl. นางสาว)
  /SIRAPHOB SIRIVA|MR\.SIRAPHOB/i,               // self inter-account transfers
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stableId(account: string, date: string, desc: string, amount: number): string {
  const raw = `${account}|${date}|${desc}|${amount}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12);
}

function parseAmount(s: string): number {
  return parseFloat(s.replace(/,/g, ""));
}

function ccDate(s: string): string {
  // DD/MM/YY → YYYY-MM-DD
  const [d, m, y] = s.split("/");
  return `20${y}-${m}-${d}`;
}

function saDate(s: string): string {
  // DD-MM-YY → YYYY-MM-DD
  const [d, m, y] = s.split("-");
  return `20${y}-${m}-${d}`;
}

function stripCCSeq(desc: string): string {
  // Remove trailing sequence integer added by PDF extractor: "Google ADS14" → "Google ADS"
  return desc.replace(/\d+$/, "").trim();
}

function applyRules(desc: string, rules: Rule[]): Rule | null {
  for (const rule of rules) {
    if (rule.pattern.test(desc)) return rule;
  }
  return null;
}

// Mirrors normalizeMerchant from lib/finance.ts for merchant map keys
function normalizeMerchant(description: string): string {
  return description
    .toLowerCase()
    .replace(/[#*]/g, " ")
    .replace(/\b(pos|payment|purchase|debit|credit|trf|transfer|ref|no|x{2,})\b/g, " ")
    .replace(/[0-9]+/g, " ")
    .replace(/[^a-z฀-๿]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// CC parser
// ---------------------------------------------------------------------------

function parseCCFile(filePath: string): Transaction[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const filename = path.basename(filePath);

  // Extract statement month from filename: KBGC_..._YYMMDD.txt
  const dateMatch = filename.match(/_(\d{2})(\d{2})\d{2}\.txt$/);
  const statementPeriod = dateMatch ? `20${dateMatch[1]}-${dateMatch[2]}` : undefined;

  const transactions: Transaction[] = [];
  const seenKeys = new Set<string>();
  let currentAccount = "cc-6515";

  for (const line of content.split("\n")) {
    // Track which card section
    if (line.includes("4221 82XX XXXX 6515")) { currentAccount = "cc-6515"; continue; }
    if (line.includes("4417 70XX XXXX 6458")) { currentAccount = "cc-6458"; continue; }

    // Must start with two dates
    const m = line.match(/^(\d{2}\/\d{2}\/\d{2})\s+\d{2}\/\d{2}\/\d{2}\s+(.+)$/);
    if (!m) continue;

    const [, transDate, rest] = m;

    // Split remaining fields by 2+ spaces; amount is always last
    const parts = rest.split(/\s{2,}/);
    if (parts.length < 2) continue;

    const rawDesc = parts[0];
    const rawAmount = parts[parts.length - 1].trim();

    // Must end in a valid number
    if (!/^-?[\d,.]+$/.test(rawAmount)) continue;

    const amount = parseAmount(rawAmount);
    if (amount <= 0) continue; // skip refunds and credits

    const desc = stripCCSeq(rawDesc);

    // Skip system rows
    if (CC_SKIP.some((p) => p.test(desc))) continue;

    const date = ccDate(transDate);
    // Skip example transactions from page 6/6 (dated 2020 in the interest calculation demo)
    if (!date.startsWith("202") || parseInt(date.slice(0, 4)) < 2025) continue;

    const key = `${date}|${desc}|${amount}|${currentAccount}`;
    if (seenKeys.has(key)) continue; // page is duplicated in CC files
    seenKeys.add(key);

    const rule = applyRules(desc, CC_RULES);
    const category = rule?.category ?? "อื่นๆ";
    const taxBucket = rule?.taxBucket;

    const tx: Transaction = {
      id: stableId(currentAccount, date, desc, amount),
      date,
      direction: "expense",
      amount,
      currency: "THB",
      description: desc,
      category,
      account: currentAccount,
      addedAt: NOW,
    };
    if (taxBucket) tx.taxBucket = taxBucket;
    if (statementPeriod) tx.statementPeriod = statementPeriod;

    transactions.push(tx);
  }

  return transactions;
}

// ---------------------------------------------------------------------------
// Savings account parser
// ---------------------------------------------------------------------------

function parseSAFile(filePath: string, accountId: string): Transaction[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const transactions: Transaction[] = [];
  let prevBalance: number | null = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();

    // Opening balance line: "DD-MM-YY   BALANCE ยอดยกมา"
    const openMatch = line.match(/^(\d{2}-\d{2}-\d{2})\s+([\d,]+\.\d{2})\s+ยอดยกมา/);
    if (openMatch) {
      prevBalance = parseAmount(openMatch[2]);
      i++;
      continue;
    }

    // Transaction line: "DD-MM-YY   HH:MM   CHANNEL BALANCE   desc..."
    const txLineMatch = line.match(/^(\d{2}-\d{2}-\d{2})\s+\d{2}:\d{2}\s+/);
    if (!txLineMatch) {
      i++;
      continue;
    }

    const dateStr = line.slice(0, 8);

    // Extract balance: first number with decimal in the line (after date+time prefix)
    const afterPrefix = line.slice(txLineMatch[0].length);
    const balMatch = afterPrefix.match(/([\d,]+\.\d{2})/);
    if (!balMatch) {
      i++;
      continue;
    }
    const balanceAfter = parseAmount(balMatch[1]);

    // Collect description from this line and any continuation lines
    const channelAndBalance = afterPrefix.slice(0, afterPrefix.indexOf(balMatch[1]) + balMatch[1].length);
    let descRaw = afterPrefix.slice(channelAndBalance.length).replace(/^\s+/, "");

    i++;
    while (i < lines.length) {
      const next = lines[i].trimEnd();
      if (next.match(/^\d{2}-\d{2}-\d{2}/) || next.includes("--- page break ---") || next.match(/^KBPDF/)) break;
      if (next.trim()) descRaw += " " + next.trim();
      i++;
    }

    const desc = descRaw.replace(/\s+/g, " ").trim();

    if (prevBalance === null) {
      prevBalance = balanceAfter;
      continue;
    }

    const delta = Math.round((balanceAfter - prevBalance) * 100) / 100;
    const amount = Math.abs(delta);
    const isIncome = delta > 0;
    prevBalance = balanceAfter;

    if (amount < 1) continue; // skip dust/rounding

    // Apply skip rules
    if (SA_SKIP_PATTERNS.some((p) => p.test(desc))) continue;

    // Skip incoming transfers from individuals (personal, not business income)
    // Kept: company transfers (บจก., บริษัท), foreign wire, QR received
    if (isIncome && /จาก.*(นาย |น\.ส\. |นาง|นางสาว )/.test(desc) && !/บจก\.|บริษัท/.test(desc)) continue;

    const date = saDate(dateStr);
    let category: string;
    let taxBucket: TaxBucket | undefined;
    let incomeType: string | undefined;

    if (isIncome) {
      const rule = applyRules(desc, SA_INCOME_RULES);
      category = rule?.category ?? "รายรับอื่นๆ";
      if (category === "เงินเดือน") incomeType = "salary";
      else if (category === "ฟรีแลนซ์") incomeType = "freelance_40_2";
    } else {
      const rule = applyRules(desc, SA_EXPENSE_RULES);
      category = rule?.category ?? "อื่นๆ";
      taxBucket = rule?.taxBucket;
    }

    // Skip uncategorized small expenses in savings (likely misc transfers)
    if (!isIncome && category === "อื่นๆ" && amount < 5000) continue;

    const tx: Transaction = {
      id: stableId(accountId, date, desc, amount),
      date,
      direction: isIncome ? "income" : "expense",
      amount,
      currency: "THB",
      description: desc,
      category,
      account: accountId,
      addedAt: NOW,
    };
    if (taxBucket) tx.taxBucket = taxBucket;
    if (incomeType) tx.incomeType = incomeType;

    transactions.push(tx);
  }

  return transactions;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const allTransactions: Transaction[] = [];

  // CC files (sorted = chronological)
  const ccFiles = fs.readdirSync(STATEMENTS_DIR)
    .filter((f) => f.startsWith("KBGC_") && f.endsWith(".txt"))
    .sort();

  for (const file of ccFiles) {
    const txs = parseCCFile(path.join(STATEMENTS_DIR, file));
    console.log(`${file}: ${txs.length} transactions`);
    allTransactions.push(...txs);
  }

  // Savings files
  const saFiles: { file: string; account: string }[] = [
    { file: "STM_SA0191_01JAN26_14JUN26.txt", account: "sa-0191" },
    { file: "STM_SA6884_01JAN26_14JUN26.txt", account: "sa-6884" },
  ];

  for (const { file, account } of saFiles) {
    const fp = path.join(STATEMENTS_DIR, file);
    if (!fs.existsSync(fp)) { console.warn(`Missing: ${file}`); continue; }
    const txs = parseSAFile(fp, account);
    console.log(`${file}: ${txs.length} transactions`);
    allTransactions.push(...txs);
  }

  // Build merchant map from categorized transactions
  const merchantMap: Record<string, { category: string; taxBucket?: string }> = {};
  for (const tx of allTransactions) {
    if (tx.category === "อื่นๆ" || tx.category === "รายรับอื่นๆ") continue;
    const key = normalizeMerchant(tx.description);
    if (key && !merchantMap[key]) {
      merchantMap[key] = { category: tx.category, ...(tx.taxBucket ? { taxBucket: tx.taxBucket } : {}) };
    }
  }

  const draft = { generatedAt: NOW, transactions: allTransactions, merchantMap };
  fs.writeFileSync(DRAFT_PATH, JSON.stringify(draft, null, 2), "utf-8");

  const income = allTransactions.filter((t) => t.direction === "income").reduce((s, t) => s + t.amount, 0);
  const expense = allTransactions.filter((t) => t.direction === "expense").reduce((s, t) => s + t.amount, 0);

  console.log(`\nTotal: ${allTransactions.length} transactions`);
  console.log(`Income: ${income.toLocaleString("th-TH")} THB`);
  console.log(`Expense: ${expense.toLocaleString("th-TH")} THB`);
  console.log(`Merchant map: ${Object.keys(merchantMap).length} rules`);
  console.log(`\nWrote → ${DRAFT_PATH}`);
  console.log(`Next: tsx scripts/finance-ingest.ts [--commit]`);
}

main();
