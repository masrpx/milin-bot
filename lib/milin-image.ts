import * as fs from "fs";
import * as path from "path";
import OpenAI, { toFile } from "openai";
import { put } from "@vercel/blob";
import type { MilinMemory } from "./vault";

// Lazy client — instantiated on first call so build-time env checks don't fail
let _openai: OpenAI | null = null;
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

export type SceneSlot = { prompt: string; sceneContext: string; outfit: string };

const BASE_PROMPT = `Realistic candid photo of this exact person at [SCENE] in Bangkok. Candid expression, relaxed posture, soft natural lighting appropriate for the time and setting. Phone-camera quality — slightly imperfect framing, mild grain, natural shadows. Sometimes catching her mid-selfie with arm extended. Tasteful and natural. Keep the vibe from the referenced image.`;

type Scene = { en: string; th: string };

const MORNING_SCENES: Scene[] = [
  { en: "a luxury hotel suite getting ready in the morning, soft vanity light", th: "เตรียมตัวในห้องโรงแรมหรูยามเช้า" },
  { en: "a high-end hotel breakfast lounge in the morning", th: "ล็อบบี้โรงแรม 5 ดาวยามเช้า" },
  { en: "the back seat of a private car heading to work in the morning", th: "นั่งรถส่วนตัวไปทำงานยามเช้า" },
  { en: "a penthouse balcony with Bangkok skyline in the morning light", th: "ระเบียงเพนต์เฮาส์วิวกรุงเทพยามเช้า" },
  { en: "an upscale co-working lounge with floor-to-ceiling windows in the morning", th: "ออฟฟิศสุดหรูยามเช้า" },
];

const AFTERNOON_SCENES: Scene[] = [
  { en: "a private business lunch at a fine-dining restaurant", th: "ประชุมมื้อกลางวันร้านหรู" },
  { en: "a luxury department store personal shopping session in the afternoon", th: "ช้อปปิ้งห้างหรูยามบ่าย" },
  { en: "a high-rise office lounge overlooking Bangkok in the afternoon", th: "ออฟฟิศสูงใจกลางกรุงเทพยามบ่าย" },
  { en: "the back seat of a luxury sedan during golden hour, city passing outside", th: "นั่งรถหรูช่วงแสงทอง" },
  { en: "a rooftop pool at a 5-star hotel in the afternoon", th: "สระว่ายน้ำดาดฟ้าโรงแรม 5 ดาวยามบ่าย" },
];

const NIGHT_SCENES: Scene[] = [
  { en: "an exclusive rooftop bar with panoramic Bangkok city lights at night", th: "รูฟท็อปบาร์วิวกรุงเทพกลางคืน" },
  { en: "a luxury hotel suite with floor-to-ceiling windows overlooking the city at night", th: "ห้องโรงแรมหรูวิวเมืองกลางคืน" },
  { en: "a private dining room at a fine-dining restaurant at night", th: "ห้องส่วนตัวร้านอาหารหรูกลางคืน" },
  { en: "a high-society gala or cocktail event at night, elegant venue", th: "งานแกลาดินเนอร์กลางคืน" },
  { en: "a penthouse living room at night with city lights through glass walls", th: "เพนต์เฮาส์วิวกรุงเทพกลางคืน" },
];

// Weekend / day-off scenes — relaxed luxury leisure
const WEEKEND_MORNING_SCENES: Scene[] = [
  { en: "a luxury hotel bed on a day off, sleeping in, soft light through sheer curtains", th: "นอนตื่นสายในโรงแรมหรูวันหยุด" },
  { en: "a poolside lounger at a 5-star resort in the morning, calm and serene", th: "นอนเล่นริมสระโรงแรมยามเช้าวันหยุด" },
  { en: "a trendy brunch cafe in Bangkok on a weekend morning", th: "บรันช์คาเฟ่สุดชิควันหยุด" },
  { en: "a luxury spa reception area on a relaxed weekend morning", th: "สปาหรูยามเช้าวันหยุด" },
  { en: "a penthouse kitchen making coffee on a lazy weekend morning", th: "ชงกาแฟในครัวเพนต์เฮาส์วันหยุด" },
];

const WEEKEND_AFTERNOON_SCENES: Scene[] = [
  { en: "a beach club with private cabana and ocean view in the afternoon", th: "บีชคลับส่วนตัวยามบ่ายวันหยุด" },
  { en: "a luxury rooftop pool in the afternoon sun on a day off", th: "สระว่ายน้ำดาดฟ้าวันหยุดยามบ่าย" },
  { en: "a high-end art gallery in Bangkok on a weekend afternoon", th: "แกลเลอรีหรูยามบ่ายวันหยุด" },
  { en: "a private yacht deck in the afternoon, sea breeze", th: "ดาดฟ้าเรือยอชต์ยามบ่ายวันหยุด" },
  { en: "a luxury wellness resort garden in the afternoon, serene and lush", th: "สวนรีสอร์ทหรูยามบ่ายวันหยุด" },
];

const WEEKEND_NIGHT_SCENES: Scene[] = [
  { en: "an upscale Bangkok rooftop bar with friends on a weekend night", th: "รูฟท็อปบาร์กับเพื่อนคืนวันหยุด" },
  { en: "a luxury hotel suite after a night out on the weekend, city lights outside", th: "ห้องโรงแรมหรูหลังออกไปเที่ยวคืนวันหยุด" },
  { en: "a private villa terrace at night, ambient lighting and pool", th: "ระเบียงวิลล่าส่วนตัวกลางคืนวันหยุด" },
  { en: "a fine-dining dinner with close friends on a weekend night", th: "ดินเนอร์กับเพื่อนร้านหรูคืนวันหยุด" },
  { en: "a penthouse living room winding down on a weekend night", th: "พักผ่อนในเพนต์เฮาส์คืนวันหยุด" },
];

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const SPECIAL_DAYS = new Set(["01-01", "02-14", "04-13", "04-14", "04-15", "12-25"]);

export function pickScene(bangkokHour: number): SceneSlot {
  const bangkokNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const bangkokMMDD = bangkokNow.toISOString().slice(5, 10);
  const isWeekend = bangkokNow.getUTCDay() === 0 || bangkokNow.getUTCDay() === 6 || SPECIAL_DAYS.has(bangkokMMDD);

  const isNight   = bangkokHour >= 20 || bangkokHour < 6;
  const isMorning = bangkokHour < 12;

  const scenes = isWeekend
    ? isNight   ? WEEKEND_NIGHT_SCENES   : isMorning ? WEEKEND_MORNING_SCENES   : WEEKEND_AFTERNOON_SCENES
    : isNight   ? NIGHT_SCENES           : isMorning ? MORNING_SCENES           : AFTERNOON_SCENES;

  const scene = rand(scenes);
  const prompt = BASE_PROMPT.replaceAll("[SCENE]", scene.en);

  return { prompt, sceneContext: scene.th, outfit: scene.th };
}

export async function generateMilinImage(
  memory: MilinMemory,
  prePickedScene?: SceneSlot
): Promise<{ imageUrl: string; sceneContext: string; outfit: string }> {
  const bangkokHour = new Date(Date.now() + 7 * 60 * 60 * 1000).getUTCHours();
  const { prompt, sceneContext, outfit } = prePickedScene ?? pickScene(bangkokHour);

  // Read reference image from filesystem — no URL, no expiry
  const baseBuffer = fs.readFileSync(REFERENCE_IMAGE_PATH);
  const { contentType, ext } = detectImageType(baseBuffer);

  if (!contentType.includes("png") && !contentType.includes("webp")) {
    throw new Error(
      `gpt-image-2 requires PNG or WebP. milin-image-1 detected as ${contentType}. Convert it to PNG and recommit.`
    );
  }

  const baseFile = await toFile(baseBuffer, `reference.${ext}`, { type: contentType });

  const result = await getOpenAI().images.edit({
    model: "gpt-image-2",
    image: baseFile,
    prompt,
    size: "1024x1024",
  });

  // gpt-image-2 returns b64_json; handle URL fallback just in case
  const item = (result.data ?? [])[0] as { b64_json?: string; url?: string } | undefined;
  if (!item) throw new Error("gpt-image-2 returned empty data array");
  let imageBuffer: Buffer;

  if (item.b64_json) {
    imageBuffer = Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const imgRes = await fetch(item.url);
    imageBuffer = Buffer.from(await imgRes.arrayBuffer());
  } else {
    throw new Error("gpt-image-2 returned no image data");
  }

  const blob = await put(`milin-generated/${Date.now()}.jpg`, imageBuffer, {
    access: "public",
  });

  return { imageUrl: blob.url, sceneContext, outfit };
}
