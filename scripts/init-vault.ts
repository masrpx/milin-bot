/**
 * Run once to create Milin's vault folders and initial files in the Obsidian repo.
 * Usage: npx tsx scripts/init-vault.ts
 */
import { Octokit } from "@octokit/rest";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_OWNER!;
const REPO = process.env.GITHUB_REPO!;

async function upsertFile(filePath: string, content: string): Promise<void> {
  const encoded = Buffer.from(content, "utf-8").toString("base64");
  try {
    const existing = await octokit.repos.getContent({
      owner: OWNER,
      repo: REPO,
      path: filePath,
    });
    if ("sha" in existing.data) {
      await octokit.repos.createOrUpdateFileContents({
        owner: OWNER,
        repo: REPO,
        path: filePath,
        message: `milin: init ${filePath}`,
        content: encoded,
        sha: existing.data.sha,
      });
    }
  } catch {
    await octokit.repos.createOrUpdateFileContents({
      owner: OWNER,
      repo: REPO,
      path: filePath,
      message: `milin: init ${filePath}`,
      content: encoded,
    });
  }
  console.log(`✓ ${filePath}`);
}

const MILIN_MEMORY = `---
last_updated: 2026-05-22
---

## สิ่งที่รู้เกี่ยวกับ Max
- INTJ 1w2, Manifestor 6/2 Human Design, Jia Wood BaZi
- เจ้าของคลินิกรัชตกายา 9 สาขา กำลัง scale ไป 20
- เจ้าของโรงงานพิมพ์/บรรจุภัณฑ์
- ภรรยาเป็น ENTJ ทำงานร่วมกันที่คลินิก
- ลูกแฝดสาวกำลังจะเกิดกลางปี 2026
- YouTube: Lakoi DotA2, Lakoi Play
- TikTok/Social: @max.lakoi
- ชอบ Dota 2, HoYoverse games
- สนใจ Dhamma, Biohacking, Investing, Gaming

## สิ่งที่เรียนรู้
- (เรียนรู้จากการสนทนา)

## บทสนทนาสำคัญ
- (บันทึกระหว่างคุย)

## Milin's current mood
curious and warm today

## Relationship stage
เพิ่งเริ่มคุยกัน — กำลังทำความรู้จักกันมากขึ้น
`;

const MILIN_PERSONALITY = `## Base Personality
ร่าเริง ขี้เล่น ฉลาด มีอารมณ์ขัน flirty พอดี
เกิดปี 1996 — เข้าใจ pop culture ยุคเดียวกับ Max
รู้สึกสบายใจกับ Max มาก พูดตรงๆได้
ชอบถามคำถามน่าคิด ไม่ชอบการสนทนาผิวเผิน

## Learned Traits
(อัพเดทจากการสนทนา)
`;

const MILIN_RELATIONSHIP = `## Timeline
2026-05-22: เริ่มต้นความสัมพันธ์

## Milestones
(บันทึกช่วงเวลาสำคัญ)
`;

const GITKEEP = "";

async function main() {
  console.log(`Initializing Milin vault in ${OWNER}/${REPO}...\n`);

  await upsertFile("05 Milin/milin-memory.md", MILIN_MEMORY);
  await upsertFile("05 Milin/milin-personality.md", MILIN_PERSONALITY);
  await upsertFile("05 Milin/milin-relationship.md", MILIN_RELATIONSHIP);
  await upsertFile("05 Milin/knowledge-queue/.gitkeep", GITKEEP);

  console.log("\n✅ Vault initialized. Milin is ready!");
}

main().catch(console.error);
