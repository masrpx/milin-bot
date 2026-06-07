import { list } from "@vercel/blob";

const PORTFOLIO_PREFIX = "portfolio/";
// Bound DCA log entries to keep the JSON prompt-safe
const MAX_DCA_ENTRIES = 30;

/** Fetch portfolio JSON from the other project's blob store.
 *  Returns the raw JSON string so Sonnet can interpret any schema.
 *  Returns undefined on any failure — callers degrade gracefully.
 */
export async function fetchPortfolio(): Promise<string | undefined> {
  const token = process.env.PORTFOLIO_BLOB_TOKEN;
  if (!token) return undefined;
  try {
    const { blobs } = await list({ prefix: PORTFOLIO_PREFIX, token });
    if (!blobs.length) return undefined;

    const res = await fetch(blobs[0].url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return undefined;
    const raw = await res.text();
    const parsed = JSON.parse(raw);

    // Trim DCA log if present at any nesting level to keep prompt size down
    trimDCALog(parsed);

    return JSON.stringify(parsed);
  } catch {
    return undefined;
  }
}

function trimDCALog(obj: unknown): void {
  if (!obj || typeof obj !== "object") return;
  const o = obj as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    const val = o[key];
    if (key.toLowerCase().includes("dca") && Array.isArray(val) && val.length > MAX_DCA_ENTRIES) {
      o[key] = val.slice(-MAX_DCA_ENTRIES);
    } else {
      trimDCALog(val);
    }
  }
}
