import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_OWNER!;
const REPO = process.env.GITHUB_REPO!;

export const NDN_CAP = 10;
const INBOX_PATH = "05 Milin/todo-inbox.json";
const NDN_PATH = "05 Milin/todo-ndn.json";
const NVDN_PATH = "05 Milin/todo-nvdn.json";
const NDN_EXPIRY_DAYS = 7;

export interface InboxItem {
  id: string;
  text: string;
  addedAt: string; // ISO
}

export interface NDNItem {
  id: string;
  text: string;
  addedAt: string; // ISO
}

export interface NVDNItem {
  id: string;
  text: string;
  archivedAt: string; // ISO
}

export function generateTodoId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

/** Returns items + sha so callers can write back without an extra read. */
async function readJsonFile<T>(path: string): Promise<{ items: T[]; sha?: string }> {
  try {
    const res = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path });
    if (!("content" in res.data)) return { items: [] };
    const raw = Buffer.from(res.data.content, "base64").toString("utf-8");
    return { items: JSON.parse(raw) as T[], sha: res.data.sha };
  } catch {
    return { items: [] };
  }
}

async function writeJsonFile<T>(path: string, items: T[], sha?: string): Promise<void> {
  const content = Buffer.from(JSON.stringify(items, null, 2), "utf-8").toString("base64");
  await octokit.repos.createOrUpdateFileContents({
    owner: OWNER,
    repo: REPO,
    path,
    message: `milin: update ${path.split("/").pop()}`,
    content,
    ...(sha ? { sha } : {}),
  });
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export async function getInbox(): Promise<{ items: InboxItem[]; sha?: string }> {
  return readJsonFile<InboxItem>(INBOX_PATH);
}

export async function saveInbox(items: InboxItem[], sha?: string): Promise<void> {
  const resolvedSha = sha ?? (await readJsonFile<InboxItem>(INBOX_PATH)).sha;
  await writeJsonFile(INBOX_PATH, items, resolvedSha);
}

// ---------------------------------------------------------------------------
// NDN (Not Doing Now)
// ---------------------------------------------------------------------------

export async function getNDN(): Promise<{ items: NDNItem[]; sha?: string }> {
  return readJsonFile<NDNItem>(NDN_PATH);
}

export async function saveNDN(items: NDNItem[], sha?: string): Promise<void> {
  const resolvedSha = sha ?? (await readJsonFile<NDNItem>(NDN_PATH)).sha;
  await writeJsonFile(NDN_PATH, items, resolvedSha);
}

// ---------------------------------------------------------------------------
// NVDN (Never Doing Now)
// ---------------------------------------------------------------------------

export async function getNVDN(): Promise<{ items: NVDNItem[]; sha?: string }> {
  return readJsonFile<NVDNItem>(NVDN_PATH);
}

export async function saveNVDN(items: NVDNItem[], sha?: string): Promise<void> {
  const resolvedSha = sha ?? (await readJsonFile<NVDNItem>(NVDN_PATH)).sha;
  await writeJsonFile(NVDN_PATH, items, resolvedSha);
}

// ---------------------------------------------------------------------------
// Auto-expire: moves NDN items older than NDN_EXPIRY_DAYS to NVDN.
// Returns the titles of expired items (empty array if none).
// Called by the morning cron.
// ---------------------------------------------------------------------------

export async function expireStaleNDN(): Promise<string[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - NDN_EXPIRY_DAYS);

  const { items: ndnItems, sha: ndnSha } = await getNDN();
  const expired = ndnItems.filter((item) => new Date(item.addedAt) < cutoff);
  if (expired.length === 0) return [];

  const { items: nvdnItems, sha: nvdnSha } = await getNVDN();
  const now = new Date().toISOString();
  const newNvdn: NVDNItem[] = [
    ...nvdnItems,
    ...expired.map((item) => ({ id: item.id, text: item.text, archivedAt: now })),
  ];
  const newNdn = ndnItems.filter((item) => new Date(item.addedAt) >= cutoff);

  await Promise.all([saveNDN(newNdn, ndnSha), saveNVDN(newNvdn, nvdnSha)]);
  return expired.map((item) => item.text);
}
