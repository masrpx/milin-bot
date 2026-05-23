import { Octokit } from "@octokit/rest";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_OWNER!;
const REPO = process.env.GITHUB_REPO!;

async function getTree(): Promise<{ path: string; sha: string }[]> {
  const repoRes = await octokit.repos.get({ owner: OWNER, repo: REPO });
  const branch = repoRes.data.default_branch;
  const treeRes = await octokit.git.getTree({ owner: OWNER, repo: REPO, tree_sha: branch, recursive: "1" });
  return treeRes.data.tree
    .filter((f) => f.path?.startsWith("04 Resources/") && f.type === "blob")
    .map((f) => ({ path: f.path!, sha: f.sha! }));
}

async function moveFile(oldPath: string, newPath: string): Promise<void> {
  const res = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: oldPath });
  if (!("content" in res.data)) throw new Error(`Not a file: ${oldPath}`);
  const content = res.data.content;
  const sha = res.data.sha;

  // Create at new path
  await octokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path: newPath,
    message: `migrate: move ${oldPath} → ${newPath}`,
    content,
  });

  // Delete old path
  await octokit.repos.deleteFile({
    owner: OWNER, repo: REPO, path: oldPath,
    message: `migrate: remove ${oldPath} after move`,
    sha,
  });
}

async function main() {
  console.log(`Scanning 04 Resources in ${OWNER}/${REPO}...`);
  const files = await getTree();

  if (files.length === 0) {
    console.log("No files found in 04 Resources — nothing to do.");
    return;
  }

  console.log(`Found ${files.length} file(s) to move:\n`);
  files.forEach((f) => console.log(`  ${f.path}`));
  console.log();

  for (const file of files) {
    const newPath = file.path.replace(/^04 Resources/, "03 Resources");
    process.stdout.write(`Moving: ${file.path}\n    → ${newPath} ... `);
    try {
      await moveFile(file.path, newPath);
      console.log("✓");
    } catch (err) {
      console.log(`✗ ${err}`);
    }
  }

  console.log("\nDone.");
}

main().catch(console.error);
