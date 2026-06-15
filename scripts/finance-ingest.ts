/**
 * Commit tool: reads statements/ingest-draft.json (produced by Claude Code
 * in-session) and writes the transactions + merchant map to the vault.
 *
 * Extraction is done by Claude Code directly — no Anthropic API call here.
 *
 * Usage:
 *   tsx scripts/finance-ingest.ts            # dry run: show what would be written
 *   tsx scripts/finance-ingest.ts --commit   # write to vault
 */
import "./_env"; // must precede lib/finance (reads env at module load)
import * as fs from "fs";
import * as path from "path";
import {
  getTransactions,
  saveTransactions,
  getMerchantMap,
  saveMerchantMap,
  dedupeTransactions,
  type Transaction,
  type MerchantMap,
} from "../lib/finance";

const STATEMENTS_DIR = path.resolve(process.cwd(), "statements");
const DRAFT_PATH = path.join(STATEMENTS_DIR, "ingest-draft.json");

interface Draft {
  generatedAt: string;
  transactions: Transaction[];
  merchantMap?: MerchantMap;
}

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");

  if (!fs.existsSync(DRAFT_PATH)) {
    console.error("statements/ingest-draft.json not found. Ask Claude Code to extract transactions first.");
    process.exit(1);
  }

  const draft = JSON.parse(fs.readFileSync(DRAFT_PATH, "utf-8")) as Draft;
  const incoming = draft.transactions ?? [];
  const incomingMap: MerchantMap = draft.merchantMap ?? {};

  if (incoming.length === 0) {
    console.log("Draft has 0 transactions — nothing to do.");
    return;
  }

  const { items: existing, sha: txSha } = await getTransactions();
  const { map: existingMap, sha: mapSha } = await getMerchantMap();
  const fresh = dedupeTransactions(existing, incoming);

  const mergedMap: MerchantMap = { ...existingMap, ...incomingMap };

  const income = fresh.filter((t) => t.direction === "income").reduce((s, t) => s + t.amount, 0);
  const expense = fresh.filter((t) => t.direction === "expense").reduce((s, t) => s + t.amount, 0);

  console.log(`Draft: ${incoming.length} transactions (generated ${draft.generatedAt})`);
  console.log(`New after dedup: ${fresh.length} (${existing.length} already in vault)`);
  console.log(`Income ${income.toLocaleString("th-TH")} | Expense ${expense.toLocaleString("th-TH")} THB`);
  console.log(`Merchant map: ${Object.keys(existingMap).length} existing + ${Object.keys(incomingMap).length} new = ${Object.keys(mergedMap).length} total`);

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to save to vault.");
    return;
  }

  await saveTransactions([...existing, ...fresh], txSha);
  await saveMerchantMap(mergedMap, mapSha);
  console.log(`\n✓ Wrote ${fresh.length} transactions + ${Object.keys(mergedMap).length} merchant rules to vault.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
