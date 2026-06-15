/**
 * Local statement → text extractor (the mechanical half of the ingestion
 * workbench). Reads every PDF in ./statements/, decrypts password-protected
 * ones, and writes a plain-text sibling file (<name>.txt) next to each.
 *
 * The intelligent half — turning that text into categorized transactions and
 * writing them to the vault — is done by Claude in-session, not here.
 *
 * Usage:
 *   tsx scripts/finance-extract.ts              # all PDFs in ./statements/
 *   tsx scripts/finance-extract.ts '_26[0-9]{4}\.pdf$|[A-Z]{3}26_'   # filter by regex
 *
 * Passwords (Thai e-statements): set STATEMENT_PASSWORDS in .env.local as a
 * comma-separated list; each PDF is tried against them in order.
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const STATEMENTS_DIR = path.resolve(process.cwd(), "statements");

function passwordCandidates(): string[] {
  const raw = process.env.STATEMENT_PASSWORDS ?? "";
  // "" first so unencrypted PDFs open without a password.
  return ["", ...raw.split(",").map((p) => p.trim()).filter(Boolean)];
}

async function extractWithPassword(data: Uint8Array, password: string): Promise<string> {
  const loadingTask = pdfjs.getDocument({ data, password, useSystemFonts: true });
  const doc = await loadingTask.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    const lines: string[] = [];
    for (const item of content.items as { str: string; hasEOL?: boolean }[]) {
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      } else {
        line += " ";
      }
    }
    if (line.trim()) lines.push(line);
    pages.push(lines.join("\n"));
  }
  await loadingTask.destroy();
  return pages.join("\n\n--- page break ---\n\n");
}

function isPasswordError(err: unknown): boolean {
  return (err as { name?: string })?.name === "PasswordException";
}

async function extractPdf(filePath: string): Promise<string> {
  // pdfjs transfers the underlying buffer to its worker, so give each attempt a
  // fresh copy of the bytes.
  const bytes = fs.readFileSync(filePath);
  for (const password of passwordCandidates()) {
    try {
      return await extractWithPassword(new Uint8Array(bytes), password);
    } catch (err) {
      if (isPasswordError(err)) continue; // try the next candidate
      throw err;
    }
  }
  throw new Error(
    `Could not unlock ${path.basename(filePath)} — add its password to STATEMENT_PASSWORDS in .env.local`,
  );
}

async function main(): Promise<void> {
  if (!fs.existsSync(STATEMENTS_DIR)) {
    fs.mkdirSync(STATEMENTS_DIR, { recursive: true });
    console.log(`Created ${STATEMENTS_DIR}. Drop your statement PDFs in there and re-run.`);
    return;
  }

  // Optional regex arg: only extract PDFs whose filename matches (e.g. one year).
  const filter = process.argv[2] ? new RegExp(process.argv[2], "i") : null;

  const pdfs = fs
    .readdirSync(STATEMENTS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .filter((f) => !filter || filter.test(f));

  if (pdfs.length === 0) {
    const scope = filter ? ` matching ${filter}` : "";
    console.log(`No PDFs${scope} in ${STATEMENTS_DIR}.`);
    return;
  }

  for (const pdf of pdfs) {
    const pdfPath = path.join(STATEMENTS_DIR, pdf);
    const txtPath = pdfPath.replace(/\.pdf$/i, ".txt");
    try {
      const text = await extractPdf(pdfPath);
      fs.writeFileSync(txtPath, text, "utf-8");
      console.log(`✓ ${pdf} → ${path.basename(txtPath)} (${text.length} chars)`);
    } catch (err) {
      console.error(`✗ ${pdf}: ${(err as Error).message}`);
    }
  }

  console.log("\nDone. Open the .txt files (or ask Claude to read them) to categorize transactions.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
