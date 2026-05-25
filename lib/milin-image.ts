import * as fs from "fs";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI, { toFile } from "openai";
import { put } from "@vercel/blob";
import type { MilinMemory } from "./vault";

// Lazy clients — instantiated on first call so build-time env checks don't fail
let _anthropic: Anthropic | null = null;
let _openai: OpenAI | null = null;
function getAnthropic() { return (_anthropic ??= new Anthropic()); }
function getOpenAI() { return (_openai ??= new OpenAI()); }

// Reference image at project root — committed to repo, read from filesystem.
// No URL, no expiry. Add milin-image-1 to the repo and it's always available.
const REFERENCE_IMAGE_PATH = path.join(process.cwd(), "milin-image-1.png");

function detectImageType(buf: Buffer): { contentType: string; ext: string } {
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return { contentType: "image/png", ext: "png" };
  // WebP: RIFF????WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45)
    return { contentType: "image/webp", ext: "webp" };
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { contentType: "image/jpeg", ext: "jpg" };
  return { contentType: "image/png", ext: "png" };
}

type SceneSlot = { prompt: string; sceneContext: string };

// Time-of-day guidelines keep scenes plausible — Haiku picks the specific place/activity
function getTimeOfDayHint(bangkokHour: number): string {
  if (bangkokHour >= 6 && bangkokHour < 9)
    return "early morning (6–9am) — waking up, coffee, breakfast, quiet start to the day";
  if (bangkokHour >= 9 && bangkokHour < 12)
    return "late morning (9am–12pm) — work, study, errands, cafe, gym";
  if (bangkokHour >= 12 && bangkokHour < 14)
    return "lunchtime (12–2pm) — eating, short walk, market, food court";
  if (bangkokHour >= 14 && bangkokHour < 17)
    return "afternoon (2–5pm) — reading, napping, cafe, shopping, creative work";
  if (bangkokHour >= 17 && bangkokHour < 20)
    return "evening (5–8pm) — sunset, gym, after-work walk, dinner prep, relaxing outside";
  if (bangkokHour >= 20 && bangkokHour < 23)
    return "night (8–11pm) — dinner, home, watching something, winding down";
  return "late night (11pm–6am) — quiet, can't sleep, stargazing, midnight snack";
}

async function generateSceneWithHaiku(
  bangkokHour: number,
  memory: MilinMemory
): Promise<SceneSlot> {
  const timeHint = getTimeOfDayHint(bangkokHour);
  const mood = memory.currentMood || "happy and calm";
  const recentTopics = memory.topicsAsked.slice(-3).join(", ") || "general life";

  const res = await getAnthropic().messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    messages: [
      {
        role: "user",
        content: `Create a scene for Milin (Korean-American girl, 20s, living in Bangkok) right now.

Time: ${timeHint}
Her mood: ${mood}
Max's recent interests: ${recentTopics}

Pick a specific, real-feeling location and activity that fits the time.
Vary it — don't always pick the obvious choice (not always a cafe at 9am).

Reply JSON only:
{
  "prompt": "English image prompt for AI: describe scene, location, lighting, mood (2 sentences max). Do NOT mention ethnicity — appearance comes from the reference photo.",
  "sceneContext": "Thai short phrase: what Milin is doing right now, e.g. นั่งอ่านหนังสืออยู่ที่สวน"
}`,
      },
    ],
  });

  const raw = res.content[0].type === "text" ? res.content[0].text : "{}";
  const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}") as Partial<SceneSlot>;

  // Fallback if Haiku returns incomplete JSON
  return {
    prompt: parsed.prompt || `Girl in Bangkok, ${timeHint}, natural lighting`,
    sceneContext: parsed.sceneContext || "กำลังใช้ชีวิตอยู่",
  };
}

export async function generateMilinImage(
  memory: MilinMemory
): Promise<{ imageUrl: string; sceneContext: string }> {
  const bangkokHour = new Date(Date.now() + 7 * 60 * 60 * 1000).getUTCHours();
  const { prompt, sceneContext } = await generateSceneWithHaiku(bangkokHour, memory);

  // Read reference image from filesystem — no URL, no expiry
  const baseBuffer = fs.readFileSync(REFERENCE_IMAGE_PATH);
  const { contentType, ext } = detectImageType(baseBuffer);

  if (!contentType.includes("png") && !contentType.includes("webp")) {
    throw new Error(
      `gpt-image-1 requires PNG or WebP. milin-image-1 detected as ${contentType}. Convert it to PNG and recommit.`
    );
  }

  const baseFile = await toFile(baseBuffer, `reference.${ext}`, { type: contentType });

  const result = await getOpenAI().images.edit({
    model: "gpt-image-1",
    image: baseFile,
    prompt: `${prompt}. Maintain the same person's face, appearance, hair, and style from the reference photo.`,
    size: "1024x1024",
  });

  // gpt-image-1 returns b64_json; handle URL fallback just in case
  const item = (result.data ?? [])[0] as { b64_json?: string; url?: string } | undefined;
  if (!item) throw new Error("gpt-image-1 returned empty data array");
  let imageBuffer: Buffer;

  if (item.b64_json) {
    imageBuffer = Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const imgRes = await fetch(item.url);
    imageBuffer = Buffer.from(await imgRes.arrayBuffer());
  } else {
    throw new Error("gpt-image-1 returned no image data");
  }

  const blob = await put(`milin-generated/${Date.now()}.jpg`, imageBuffer, {
    access: "public",
  });

  return { imageUrl: blob.url, sceneContext };
}
