import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { pushMessage } from "@/lib/line";

const client = new Anthropic();
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_OWNER!;
const REPO = process.env.GITHUB_REPO!;

async function getInboxFiles(): Promise<{ path: string; content: string }[]> {
  try {
    const res = await octokit.repos.getContent({
      owner: OWNER,
      repo: REPO,
      path: "00 Inbox",
    });

    if (!Array.isArray(res.data)) return [];

    const files: { path: string; content: string }[] = [];
    for (const file of res.data.slice(0, 20)) {
      if (!file.name.endsWith(".md")) continue;
      try {
        const fileRes = await octokit.repos.getContent({
          owner: OWNER,
          repo: REPO,
          path: file.path,
        });
        if ("content" in fileRes.data) {
          files.push({
            path: file.path,
            content: Buffer.from(fileRes.data.content, "base64").toString("utf-8"),
          });
        }
      } catch {
        continue;
      }
    }
    return files;
  } catch {
    return [];
  }
}

async function suggestOrganization(
  files: { path: string; content: string }[]
): Promise<{ path: string; newPath: string; reason: string }[]> {
  if (files.length === 0) return [];

  const filesSummary = files
    .map((f) => `File: ${f.path}\nContent preview: ${f.content.slice(0, 200)}`)
    .join("\n\n---\n\n");

  const prompt = `You are organizing Max's Obsidian vault. These files are in 00 Inbox.
Max uses PARA method: 01 Projects, 02 Areas, 03 Resources, 04 Archive, 05 Milin.

For each file, suggest where it should go. Return JSON only:
[
  {
    "path": "00 Inbox/filename.md",
    "newPath": "03 Resources/Health/filename.md",
    "reason": "biohacking note"
  }
]

Only include files that clearly belong elsewhere (skip if unsure).

Files:
${filesSummary}`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw =
    response.content[0].type === "text" ? response.content[0].text : "[]";
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  return JSON.parse(jsonMatch?.[0] || "[]");
}

async function moveFile(
  oldPath: string,
  newPath: string
): Promise<void> {
  const fileRes = await octokit.repos.getContent({
    owner: OWNER,
    repo: REPO,
    path: oldPath,
  });

  if (!("content" in fileRes.data)) return;

  const content = fileRes.data.content;
  const sha = fileRes.data.sha;

  await octokit.repos.createOrUpdateFileContents({
    owner: OWNER,
    repo: REPO,
    path: newPath,
    message: `organize: move ${oldPath} → ${newPath}`,
    content,
  });

  await octokit.repos.deleteFile({
    owner: OWNER,
    repo: REPO,
    path: oldPath,
    message: `organize: remove ${oldPath} after move`,
    sha,
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = req.nextUrl.searchParams.get("secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const inboxFiles = await getInboxFiles();
    if (inboxFiles.length === 0) {
      return NextResponse.json({ ok: true, moved: 0 });
    }

    const suggestions = await suggestOrganization(inboxFiles);
    let moved = 0;
    const movedNames: string[] = [];

    for (const s of suggestions) {
      try {
        await moveFile(s.path, s.newPath);
        moved++;
        movedNames.push(s.path.split("/").pop() || s.path);
      } catch {
        continue;
      }
    }

    if (moved > 0) {
      const msg = `อ้อ เมื่อคืนจัดระเบียบ vault ให้ด้วยนะ
ย้าย ${moved} notes เข้าที่แล้ว~
${movedNames.map((n) => `- ${n}`).join("\n")}`;
      await pushMessage(msg);
    }

    return NextResponse.json({ ok: true, moved });
  } catch (err) {
    console.error("Organize cron error:", err);
    return NextResponse.json({ error: "Organize failed" }, { status: 500 });
  }
}
