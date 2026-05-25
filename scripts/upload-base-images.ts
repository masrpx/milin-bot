/**
 * One-time script: upload Milin's 10 base reference images to Vercel Blob.
 *
 * Usage:
 *   1. Put your images inside scripts/base-images/ (any .jpg/.jpeg/.png)
 *   2. Make sure BLOB_READ_WRITE_TOKEN is in .env.local
 *   3. npx tsx scripts/upload-base-images.ts
 *   4. Pick the best URL, add to .env.local:  MILIN_BASE_IMAGE_URL=<url>
 *   5. Add the same env var to Vercel Dashboard → Project → Settings → Env Vars
 */

import * as fs from "fs";
import * as path from "path";
import { put } from "@vercel/blob";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../.env.local") });

const BASE_IMAGES_DIR = path.join(__dirname, "base-images");

async function main() {
  if (!fs.existsSync(BASE_IMAGES_DIR)) {
    console.error(`❌ Directory not found: ${BASE_IMAGES_DIR}`);
    console.error("   Create it and add your images there, then re-run.");
    process.exit(1);
  }

  const files = fs
    .readdirSync(BASE_IMAGES_DIR)
    .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
    .sort();

  if (files.length === 0) {
    console.error(`❌ No .jpg/.png images found in ${BASE_IMAGES_DIR}`);
    process.exit(1);
  }

  console.log(`Uploading ${files.length} images to Vercel Blob...\n`);

  const urls: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    const filepath = path.join(BASE_IMAGES_DIR, filename);
    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === ".png" ? "image/png" : "image/jpeg";

    const buffer = fs.readFileSync(filepath);
    const blobPath = `milin-base/${(i + 1).toString().padStart(2, "0")}${ext}`;

    const blob = await put(blobPath, buffer, { access: "public", contentType });
    urls.push(blob.url);
    console.log(`[${i + 1}/${files.length}] ${filename}`);
    console.log(`         → ${blob.url}\n`);
  }

  console.log("✅ All uploaded!\n");
  console.log(
    "Pick the best image URL above, then add this to .env.local AND Vercel env vars:"
  );
  console.log(`\n   MILIN_BASE_IMAGE_URL=<chosen_url>\n`);
}

main().catch((err) => {
  console.error("Upload failed:", err);
  process.exit(1);
});
