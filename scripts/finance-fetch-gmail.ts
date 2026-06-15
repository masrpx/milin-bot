/**
 * Fetch statement PDFs from Gmail into ./statements/.
 *
 * Reuses the bot's Google OAuth refresh token (lib/calendar.ts getAccessToken).
 * The token must include the gmail.readonly scope — re-run
 * `tsx scripts/google-auth.ts` once to add it, then update GOOGLE_REFRESH_TOKEN
 * in .env.local.
 *
 * Usage:
 *   tsx scripts/finance-fetch-gmail.ts                 # default query (last 1y)
 *   tsx scripts/finance-fetch-gmail.ts 'from:scb.co.th newer_than:6m'
 *
 * After fetching, run `tsx scripts/finance-extract.ts` to turn the PDFs into text.
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { getAccessToken } from "../lib/calendar";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const STATEMENTS_DIR = path.resolve(process.cwd(), "statements");
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

// Only Max's two real statement senders:
//   KPLUS@kasikornbank.com              → "K PLUS" K-Credit Card statements
//   K-ElectronicDocument@kasikornbank.com → "K-eDocument" bank-account statements
// Everything else (K-eMailStatement, investment confirmations) is excluded.
const DEFAULT_QUERY =
  "from:(KPLUS@kasikornbank.com OR K-ElectronicDocument@kasikornbank.com) " +
  "has:attachment filename:pdf newer_than:1y";

// Leaflets / guides / summaries KBank attaches alongside the real statements.
// We only want the transaction PDFs: STM_SA* (savings) and KBGC_* (credit card).
// Tested against the sanitized filename (see safeName), so "T&C_..." → "T_C_...".
const FILENAME_DENYLIST = [
  /channel_bankuse/i,
  /T_C_/i, // "T&C" terms & conditions
  /terms/i, // TermsAndConditions_KeDocument_Service
  /คู่มือ/, // investment guides (RMF / Thai ESG)
  /เงื่อนไข/, // e-document service terms (Thai)
  /mutual_fund/i,
  /NCB/i, // credit-bureau yearly report
  /KBSS/i, // quarterly spending summary, not a transaction statement
];

interface GmailPart {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; data?: string };
  parts?: GmailPart[];
}

async function gmailGet(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${await res.text()}`);
  return res.json();
}

/** All message ids matching the query, across pages. */
async function searchMessageIds(query: string, token: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q: query, maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = (await gmailGet(`${GMAIL}/messages?${params}`, token)) as {
      messages?: { id: string }[];
      nextPageToken?: string;
    };
    for (const m of data.messages ?? []) ids.push(m.id);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

/** Recursively collect PDF attachment parts from a message payload. */
function collectPdfParts(part: GmailPart, out: GmailPart[] = []): GmailPart[] {
  const isPdf =
    part.mimeType === "application/pdf" || /\.pdf$/i.test(part.filename ?? "");
  if (isPdf && part.filename && part.body?.attachmentId) out.push(part);
  for (const child of part.parts ?? []) collectPdfParts(child, out);
  return out;
}

function isAllowed(filename: string): boolean {
  return !FILENAME_DENYLIST.some((re) => re.test(filename));
}

// Use the bank's own filename (it already encodes account + billing period and
// is stable across re-sends), so an identical statement emailed twice dedupes
// to one file via the existsSync check below.
function safeName(filename: string): string {
  return filename.replace(/[^\w.\-ก-๙]+/g, "_");
}

async function downloadAttachments(messageId: string, token: string): Promise<number> {
  const msg = (await gmailGet(
    `${GMAIL}/messages/${messageId}?format=full`,
    token,
  )) as { payload: GmailPart };

  let saved = 0;
  for (const part of collectPdfParts(msg.payload)) {
    const name = safeName(part.filename!);
    if (!isAllowed(name)) continue;
    const dest = path.join(STATEMENTS_DIR, name);
    if (fs.existsSync(dest)) {
      console.log(`· skip (exists) ${path.basename(dest)}`);
      continue;
    }
    const att = (await gmailGet(
      `${GMAIL}/messages/${messageId}/attachments/${part.body!.attachmentId}`,
      token,
    )) as { data: string };
    fs.writeFileSync(dest, Buffer.from(att.data, "base64url"));
    console.log(`✓ ${path.basename(dest)}`);
    saved++;
  }
  return saved;
}

async function main(): Promise<void> {
  const query = process.argv[2] || DEFAULT_QUERY;
  fs.mkdirSync(STATEMENTS_DIR, { recursive: true });

  const token = await getAccessToken();
  console.log(`Searching Gmail: ${query}\n`);
  const ids = await searchMessageIds(query, token);
  console.log(`${ids.length} matching emails\n`);

  let total = 0;
  for (const id of ids) {
    try {
      total += await downloadAttachments(id, token);
    } catch (err) {
      console.error(`✗ message ${id}: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone. Saved ${total} new PDF(s) to ${STATEMENTS_DIR}.`);
  console.log("Next: tsx scripts/finance-extract.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
