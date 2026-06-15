import { describe, it, expect } from "vitest";
import {
  normalizeMerchant,
  dedupeTransactions,
  categorize,
  summarize,
  type Transaction,
  type MerchantMap,
} from "@/lib/finance";
import {
  progressiveTax,
  sumDeductionBuckets,
  estimateTax,
  incomeByType,
} from "@/lib/finance-tax";
import { defaultTaxConfig } from "@/lib/finance";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tx(partial: Partial<Transaction>): Transaction {
  return {
    id: Math.random().toString(36).slice(2),
    date: "2026-06-01",
    direction: "expense",
    amount: 100,
    currency: "THB",
    description: "TEST",
    category: "อื่นๆ",
    account: "acct-1",
    addedAt: new Date().toISOString(),
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// normalizeMerchant
// ---------------------------------------------------------------------------

describe("normalizeMerchant", () => {
  it("collapses store-number variants of the same merchant to one key", () => {
    expect(normalizeMerchant("STARBUCKS #4412")).toBe(normalizeMerchant("STARBUCKS #9981"));
    expect(normalizeMerchant("STARBUCKS #4412")).toBe("starbucks");
  });

  it("strips digits, refs, and payment-prefix noise", () => {
    expect(normalizeMerchant("POS PURCHASE GRAB *1234 REF 998877")).toBe("grab");
  });

  it("keeps Thai merchant names", () => {
    expect(normalizeMerchant("ร้านกาแฟ 123")).toBe("ร้านกาแฟ");
  });
});

// ---------------------------------------------------------------------------
// categorize (merchant-map lookup)
// ---------------------------------------------------------------------------

describe("categorize", () => {
  const map: MerchantMap = { grab: { category: "เดินทาง", taxBucket: "none" } };

  it("returns the learned rule on a hit (ignoring ref-number noise)", () => {
    expect(categorize("GRAB *7781", map)).toEqual({
      category: "เดินทาง",
      taxBucket: "none",
    });
  });

  it("returns null for an unknown merchant (queued to ask Max)", () => {
    expect(categorize("SOME NEW SHOP", map)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dedupeTransactions
// ---------------------------------------------------------------------------

describe("dedupeTransactions", () => {
  it("drops incoming rows already present (overlapping statements)", () => {
    const existing = [tx({ date: "2026-06-01", amount: 250, description: "STARBUCKS #1" })];
    const incoming = [
      tx({ date: "2026-06-01", amount: 250, description: "STARBUCKS #2" }), // same after normalize
      tx({ date: "2026-06-02", amount: 99, description: "7-ELEVEN" }), // new
    ];
    const result = dedupeTransactions(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("7-ELEVEN");
  });

  it("dedupes duplicates within the same incoming batch", () => {
    const incoming = [
      tx({ date: "2026-06-02", amount: 99, description: "7-ELEVEN #1" }),
      tx({ date: "2026-06-02", amount: 99, description: "7-ELEVEN #2" }),
    ];
    expect(dedupeTransactions([], incoming)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

describe("summarize", () => {
  it("totals income/expense/net and groups by category", () => {
    const s = summarize([
      tx({ direction: "income", amount: 50000, category: "เงินเดือน" }),
      tx({ direction: "expense", amount: 300, category: "อาหาร" }),
      tx({ direction: "expense", amount: 200, category: "อาหาร" }),
      tx({ direction: "expense", amount: 1000, category: "ช้อปปิ้ง" }),
    ]);
    expect(s.income).toBe(50000);
    expect(s.expense).toBe(1500);
    expect(s.net).toBe(48500);
    expect(s.expenseByCategory["อาหาร"]).toBe(500);
    expect(s.incomeByCategory["เงินเดือน"]).toBe(50000);
  });
});

// ---------------------------------------------------------------------------
// Tax engine
// ---------------------------------------------------------------------------

describe("progressiveTax", () => {
  it("is zero up to the first bracket", () => {
    expect(progressiveTax(150_000)).toBe(0);
  });

  it("matches known bracket cumulatives", () => {
    expect(progressiveTax(300_000)).toBe(7_500);
    expect(progressiveTax(500_000)).toBe(27_500);
    expect(progressiveTax(840_000)).toBe(83_000);
  });
});

describe("sumDeductionBuckets", () => {
  it("merges transaction taxBuckets with manual entries", () => {
    const sums = sumDeductionBuckets(
      [
        tx({ direction: "expense", amount: 20000, taxBucket: "donation" }),
        tx({ direction: "expense", amount: 5000, taxBucket: "donation" }),
        tx({ direction: "expense", amount: 999, taxBucket: "none" }), // ignored
      ],
      { rmf: 100000 },
    );
    expect(sums.donation).toBe(25000);
    expect(sums.rmf).toBe(100000);
  });
});

describe("estimateTax", () => {
  const salaryMillion = [tx({ direction: "income", incomeType: "salary", amount: 1_000_000 })];

  it("computes taxable income and tax for a plain salary", () => {
    const est = estimateTax(salaryMillion, defaultTaxConfig());
    expect(est.income.salary).toBe(1_000_000);
    expect(est.expenseDeduction).toBe(100_000); // capped
    expect(est.allowances).toBe(60_000); // personal only
    expect(est.taxableIncome).toBe(840_000);
    expect(est.estimatedTax).toBe(83_000);
  });

  it("reflects RMF contributions in tax and remaining room", () => {
    const config = { ...defaultTaxConfig(), manualDeductions: { rmf: 100_000 } };
    const est = estimateTax(salaryMillion, config);
    expect(est.deductions).toBe(100_000);
    expect(est.taxableIncome).toBe(740_000);
    const rmfRoom = est.room.find((r) => r.bucket === "rmf")!;
    expect(rmfRoom.cap).toBe(300_000); // 30% of 1M, under the 500k statutory cap
    expect(rmfRoom.used).toBe(100_000);
    expect(rmfRoom.remaining).toBe(200_000);
  });
});

describe("incomeByType", () => {
  it("splits salary vs freelance vs other", () => {
    const b = incomeByType([
      tx({ direction: "income", incomeType: "salary", amount: 30000 }),
      tx({ direction: "income", incomeType: "freelance_40_6_8", amount: 12000 }),
      tx({ direction: "income", amount: 500 }), // untyped → other
      tx({ direction: "expense", amount: 999 }), // ignored
    ]);
    expect(b.salary).toBe(30000);
    expect(b.freelance).toBe(12000);
    expect(b.other).toBe(500);
    expect(b.total).toBe(42500);
  });
});
