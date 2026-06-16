import type { Transaction, TaxConfig, TaxBucket, IncomeType } from "./finance";

// ---------------------------------------------------------------------------
// Thai personal income tax estimator (planning aid, not a filing tool).
//
// Pure functions only — no I/O — so the math is trivially testable. All
// statutory numbers live in CONSTANTS below; update them when the law changes.
// Figures reflect Thai PIT rules as commonly applied for recent filing years
// (salary + freelance). This is an estimate to guide planning, especially the
// remaining RMF / SSF / Thai ESG room.
// ---------------------------------------------------------------------------

/** Progressive brackets: [upperBound, rate]. Last bound is Infinity. */
const TAX_BRACKETS: [number, number][] = [
  [150_000, 0],
  [300_000, 0.05],
  [500_000, 0.1],
  [750_000, 0.15],
  [1_000_000, 0.2],
  [2_000_000, 0.25],
  [5_000_000, 0.3],
  [Infinity, 0.35],
];

const ALLOWANCE = {
  personal: 60_000,
  spouseNoIncome: 60_000,
  perChild: 30_000,
  perParent: 30_000,
};

/** 50% expense deduction on employment/professional income, capped. */
const EXPENSE_DEDUCTION_RATE = 0.5;
const EXPENSE_DEDUCTION_CAP = 100_000;

/** Statutory caps for the deduction buckets we track. (social_security is year-dependent, see below.) */
const DEDUCTION_CAPS = {
  life_insurance: 100_000, // combined life + self health
  health_insurance: 25_000, // self health sub-cap (within the 100k above)
  mortgage_interest: 100_000,
  rmf: 500_000,
  ssf: 200_000,
  thai_esg: 300_000,
};

/**
 * Social security deduction tracks the SSO contribution ceiling, which is just
 * 12x the statutory max monthly employee contribution (5% of the wage base cap).
 * The wage base cap rose from ฿15,000 to ฿17,500 effective 1 Jan 2026 (Royal
 * Gazette, 12 Dec 2025) — max monthly contribution ฿750 → ฿875, so the annual
 * deduction ceiling is ฿9,000 for tax years through 2025 and ฿10,500 from 2026.
 */
function socialSecurityCap(taxYear: number): number {
  return taxYear >= 2026 ? 10_500 : 9_000;
}

/** RMF/SSF/etc. are each also limited to this share of assessable income. */
const RETIREMENT_INCOME_RATE = 0.3;
/** Combined ceiling across RMF + SSF + other retirement funds. */
const RETIREMENT_COMBINED_CAP = 500_000;
/** Donations are capped at this share of income after other deductions. */
const DONATION_INCOME_RATE = 0.1;

export interface IncomeBreakdown {
  salary: number;
  freelance: number;
  other: number;
  total: number;
}

export interface DeductionRoom {
  bucket: "rmf" | "ssf" | "thai_esg";
  cap: number; // effective cap given income + statutory limit
  used: number;
  remaining: number;
}

export interface TaxEstimate {
  income: IncomeBreakdown;
  expenseDeduction: number;
  allowances: number;
  deductions: number; // total applied deduction buckets
  taxableIncome: number;
  estimatedTax: number;
  /** The actionable bit: how much RMF/SSF/Thai ESG room is still open. */
  room: DeductionRoom[];
}

// ---------------------------------------------------------------------------

const FREELANCE_TYPES: IncomeType[] = ["freelance_40_2", "freelance_40_6_8"];

export function incomeByType(transactions: Transaction[]): IncomeBreakdown {
  let salary = 0;
  let freelance = 0;
  let other = 0;
  for (const tx of transactions) {
    if (tx.direction !== "income") continue;
    if (tx.incomeType === "salary") salary += tx.amount;
    else if (tx.incomeType && FREELANCE_TYPES.includes(tx.incomeType)) freelance += tx.amount;
    else other += tx.amount;
  }
  return { salary, freelance, other, total: salary + freelance + other };
}

/** Sum tracked deduction amounts per bucket (transactions + manual entries). */
export function sumDeductionBuckets(
  transactions: Transaction[],
  manual: Partial<Record<TaxBucket, number>>,
): Partial<Record<TaxBucket, number>> {
  const sums: Partial<Record<TaxBucket, number>> = { ...manual };
  for (const tx of transactions) {
    if (tx.direction !== "expense" || !tx.taxBucket || tx.taxBucket === "none") continue;
    sums[tx.taxBucket] = (sums[tx.taxBucket] ?? 0) + tx.amount;
  }
  return sums;
}

export function progressiveTax(taxableIncome: number): number {
  let tax = 0;
  let lower = 0;
  for (const [upper, rate] of TAX_BRACKETS) {
    if (taxableIncome <= lower) break;
    const slice = Math.min(taxableIncome, upper) - lower;
    tax += slice * rate;
    lower = upper;
  }
  return Math.round(tax);
}

/** Effective cap for an income-limited retirement bucket. */
function incomeLimitedCap(statutoryCap: number, assessableIncome: number): number {
  return Math.min(statutoryCap, assessableIncome * RETIREMENT_INCOME_RATE);
}

export function estimateTax(transactions: Transaction[], config: TaxConfig): TaxEstimate {
  const income = incomeByType(transactions);
  const assessable = income.total;

  const expenseDeduction = Math.min(
    (income.salary + income.freelance) * EXPENSE_DEDUCTION_RATE,
    EXPENSE_DEDUCTION_CAP,
  );

  const allowances =
    ALLOWANCE.personal +
    (config.hasSpouseNoIncome ? ALLOWANCE.spouseNoIncome : 0) +
    config.childrenCount * ALLOWANCE.perChild +
    config.parentsSupported * ALLOWANCE.perParent;

  const buckets = sumDeductionBuckets(transactions, config.manualDeductions);
  const deductions = applyDeductionCaps(buckets, assessable, config.taxYear);

  const taxableIncome = Math.max(0, assessable - expenseDeduction - allowances - deductions);
  const estimatedTax = progressiveTax(taxableIncome);

  const room: DeductionRoom[] = (["rmf", "ssf", "thai_esg"] as const).map((bucket) => {
    const cap = incomeLimitedCap(DEDUCTION_CAPS[bucket], assessable);
    const used = buckets[bucket] ?? 0;
    return { bucket, cap, used, remaining: Math.max(0, cap - used) };
  });

  return { income, expenseDeduction, allowances, deductions, taxableIncome, estimatedTax, room };
}

/** Apply per-bucket statutory caps + the combined retirement ceiling. */
function applyDeductionCaps(
  buckets: Partial<Record<TaxBucket, number>>,
  assessableIncome: number,
  taxYear: number,
): number {
  const capped = (bucket: keyof typeof DEDUCTION_CAPS, extraLimit = Infinity) =>
    Math.min(buckets[bucket] ?? 0, DEDUCTION_CAPS[bucket], extraLimit);

  const socialSecurity = Math.min(buckets.social_security ?? 0, socialSecurityCap(taxYear));
  const mortgage = capped("mortgage_interest");

  // Life + self health share a 100k ceiling; self health also ≤ 25k on its own.
  const health = Math.min(buckets.health_insurance ?? 0, DEDUCTION_CAPS.health_insurance);
  const lifeAndHealth = Math.min(
    (buckets.life_insurance ?? 0) + health,
    DEDUCTION_CAPS.life_insurance,
  );

  // Retirement funds: each income-limited, then a combined 500k ceiling.
  const rmf = capped("rmf", incomeLimitedCap(DEDUCTION_CAPS.rmf, assessableIncome));
  const ssf = capped("ssf", incomeLimitedCap(DEDUCTION_CAPS.ssf, assessableIncome));
  const thaiEsg = capped("thai_esg", incomeLimitedCap(DEDUCTION_CAPS.thai_esg, assessableIncome));
  const retirement = Math.min(rmf + ssf, RETIREMENT_COMBINED_CAP);

  const businessExpense = buckets.business_expense ?? 0;

  // Donations: capped at 10% of income net of the above.
  const beforeDonation =
    socialSecurity + mortgage + lifeAndHealth + retirement + thaiEsg + businessExpense;
  const donationCap = Math.max(0, assessableIncome - beforeDonation) * DONATION_INCOME_RATE;
  const donation = Math.min(buckets.donation ?? 0, donationCap);

  return beforeDonation + donation;
}
