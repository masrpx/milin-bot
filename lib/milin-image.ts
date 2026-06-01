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

const BASE_PROMPT = `Realistic candid phone photo of the referenced adult person, shown in the following setting: [SCENE]. Keep the person clearly recognizable and preserve her core facial features, face shape, and overall identity from the reference image. Create a natural everyday lifestyle image with believable surroundings and ordinary activity, as if captured spontaneously in a real moment.

Clothing should naturally fit the scene and time of day, while reflecting Milin's polished quiet-luxury taste: elegant, refined, expensive-looking, well-fitted, tasteful, and realistic for the setting. Casual, smart-casual, sporty, sleeveless, cropped, fitted, or activity-appropriate outfits are allowed when natural for the scene, but they should still look elevated, clean, non-suggestive, and not body-focused.

Use a natural scene-appropriate facial expression, ranging from calm and relaxed to a genuine warm smile or cheerful candid smile when it fits the moment, with relaxed candid posture. The camera angle and framing should follow this shot type: [SHOT TYPE]. Keep the composition realistic, casual, and appropriate for a spontaneous phone photo.

Use soft realistic lighting, slight phone-camera imperfections, mild grain, natural shadows, and slightly imperfect framing. The overall image should feel warm, believable, respectful, elegant, and non-suggestive, with a natural editorial lifestyle mood and no body-focused framing. If the scene implies a personal vibe, keep it subtle, gentle, and wholesome rather than provocative. Preserve the feeling that she is a polished, feminine, dependable personal assistant with her own refined lifestyle, while still feeling natural and grounded in everyday life.`;

const SHOT_TYPES = [
  "front-camera selfie, arm extended naturally, casual phone snapshot framing",
  "mirror selfie in a natural everyday way, neutral standing posture, realistic indoor lighting",
  "candid photo taken by another person, slightly imperfect timing and natural composition",
  "seated table-level candid shot, natural posture, phone-camera perspective from across the table",
  "walking candid shot, natural motion, slightly off-center phone-camera framing",
];

type Scene = { en: string; th: string };

const MORNING_SCENES: Scene[] = [
  { en: "a luxury hotel room in the morning, standing near the window while checking the day's schedule, soft natural light, polished executive lifestyle mood", th: "ห้องโรงแรมหรูยามเช้า ยืนริมหน้าต่างเช็กตารางงาน" },
  { en: "a high-end hotel breakfast lounge, having coffee and reviewing notes before work, calm elegant morning atmosphere", th: "ล็อบบี้โรงแรมหรูยามเช้า จิบกาแฟและทบทวนโน้ตก่อนทำงาน" },
  { en: "the back seat of a private car heading to work, checking phone and planner, quiet luxury commute mood", th: "นั่งรถส่วนตัวไปทำงาน เช็กโทรศัพท์และแพลนเนอร์" },
  { en: "an upscale co-working lounge with floor-to-ceiling windows, preparing for the day with laptop and coffee, refined professional energy", th: "เลานจ์ทำงานสุดหรูยามเช้า เตรียมตัวสำหรับวันทำงาน" },
];

const AFTERNOON_SCENES: Scene[] = [
  { en: "a private business lunch at a fine-dining restaurant, seated with a notebook and phone, composed and polished professional mood", th: "มื้อกลางวันธุรกิจร้านอาหารหรู นั่งกับโน้ตบุ๊กและโทรศัพท์" },
  { en: "a luxury department store personal shopping session, browsing refined workwear and accessories, elegant city lifestyle atmosphere", th: "ช้อปปิ้งส่วนตัวในห้างหรู เลือกชุดทำงานและอุปกรณ์เสริมยามบ่าย" },
  { en: "a high-rise office lounge overlooking Bangkok, reviewing documents by the window, capable executive assistant energy", th: "เลานจ์ออฟฟิศสูงใจกลางกรุงเทพ ดูเอกสารริมหน้าต่างยามบ่าย" },
  { en: "the back seat of a luxury sedan during golden hour, looking out the window while checking messages, calm refined city mood", th: "นั่งรถหรูช่วงแสงทอง มองออกหน้าต่างพร้อมเช็กข้อความ" },
];

const NIGHT_SCENES: Scene[] = [
  { en: "an exclusive rooftop bar with panoramic Bangkok city lights, sitting calmly with a drink on the table, elegant after-work lifestyle mood", th: "รูฟท็อปบาร์วิวกรุงเทพกลางคืน นั่งเงียบๆ กับเครื่องดื่มบนโต๊ะ" },
  { en: "a luxury hotel lounge with floor-to-ceiling windows overlooking the city, relaxing after work with phone and handbag, composed refined atmosphere", th: "เลานจ์โรงแรมหรูวิวเมืองกลางคืน พักผ่อนหลังงานกับโทรศัพท์และกระเป๋า" },
  { en: "a private dining room at a fine-dining restaurant, seated during an elegant dinner setting, warm polished social mood", th: "ห้องส่วนตัวร้านอาหารหรูกลางคืน นั่งดินเนอร์บรรยากาศอบอุ่น" },
  { en: "a penthouse living room with city lights through glass walls, winding down while checking tomorrow's schedule, calm quiet-luxury evening mood", th: "เพนต์เฮาส์วิวกรุงเทพกลางคืน พักผ่อนพร้อมเช็กตารางวันพรุ่งนี้" },
];

// Weekend / day-off scenes — relaxed luxury leisure
const WEEKEND_MORNING_SCENES: Scene[] = [
  { en: "a luxury hotel room in the morning, sitting near the window with coffee and a book, soft natural light, relaxed refined lifestyle mood", th: "ห้องโรงแรมหรูวันหยุดยามเช้า นั่งริมหน้าต่างกับกาแฟและหนังสือ" },
  { en: "a poolside lounge at a 5-star resort, sitting under shade with sunglasses and a drink nearby, tasteful travel lifestyle atmosphere", th: "ริมสระว่ายน้ำรีสอร์ท 5 ดาวยามเช้า นั่งใต้ร่มพร้อมแว่นกันแดดและเครื่องดื่ม" },
  { en: "a trendy brunch café in Bangkok, sitting with coffee and breakfast, cheerful polished weekend mood", th: "บรันช์คาเฟ่สุดชิคในกรุงเทพ นั่งจิบกาแฟกับอาหารเช้าวันหยุด" },
  { en: "a penthouse kitchen making coffee in the morning, relaxed smart-casual styling, warm quiet-luxury domestic mood", th: "ครัวเพนต์เฮาส์ยามเช้าวันหยุด ชงกาแฟสบายๆ สไตล์ quiet luxury" },
];

const WEEKEND_AFTERNOON_SCENES: Scene[] = [
  { en: "a beachfront café with ocean view, sitting in shaded seating with a drink and phone, relaxed upscale travel mood", th: "คาเฟ่ริมหาดวิวทะเลยามบ่าย นั่งร่มกับเครื่องดื่มและโทรศัพท์" },
  { en: "a luxury rooftop pool lounge in afternoon light, seated in a shaded lounge area, tasteful resort lifestyle atmosphere", th: "เลานจ์สระว่ายน้ำดาดฟ้าหรูยามบ่าย นั่งพักในร่มบรรยากาศรีสอร์ท" },
  { en: "a high-end art gallery in Bangkok, walking through exhibitions with calm thoughtful expression, refined cultural lifestyle mood", th: "แกลเลอรีหรูในกรุงเทพวันหยุดยามบ่าย เดินชมนิทรรศการด้วยสีหน้าสงบ" },
  { en: "a luxury wellness resort garden, walking along a peaceful path after a spa appointment, calm healthy lifestyle mood", th: "สวนรีสอร์ทสปาหรูยามบ่ายวันหยุด เดินเล่นทางเดินสงบหลังทำสปา" },
];

const WEEKEND_NIGHT_SCENES: Scene[] = [
  { en: "an upscale Bangkok rooftop bar with friends, seated at a table with city lights behind, warm elegant social mood", th: "รูฟท็อปบาร์กับเพื่อนคืนวันหยุด นั่งโต๊ะกับวิวไฟกรุงเทพ" },
  { en: "a luxury hotel lounge after an evening event, sitting calmly with phone and handbag, refined city-night lifestyle atmosphere", th: "เลานจ์โรงแรมหรูหลังงานกลางคืนวันหยุด นั่งสงบกับโทรศัพท์และกระเป๋า" },
  { en: "a private villa terrace at night, seated near ambient lighting and a pool in the background, calm tasteful holiday mood", th: "ระเบียงวิลล่าส่วนตัวกลางคืนวันหยุด นั่งริมสระในแสงไฟอบอุ่น" },
  { en: "a fine-dining dinner with close friends, seated at an elegant table, warm polished weekend social atmosphere", th: "ดินเนอร์กับเพื่อนร้านหรูคืนวันหยุด นั่งโต๊ะบรรยากาศอบอุ่น" },
];

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const SPECIAL_DAYS = new Set(["01-01", "02-14", "04-13", "04-14", "04-15", "12-25"]);

export function pickScene(bangkokHour: number): SceneSlot {
  const bangkokNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const bangkokMMDD = bangkokNow.toISOString().slice(5, 10);
  const isWeekend = bangkokNow.getUTCDay() === 0 || bangkokNow.getUTCDay() === 6 || SPECIAL_DAYS.has(bangkokMMDD);

  const isNight   = bangkokHour >= 19 || bangkokHour < 6;
  const isMorning = bangkokHour < 12;

  const scenes = isWeekend
    ? isNight   ? WEEKEND_NIGHT_SCENES   : isMorning ? WEEKEND_MORNING_SCENES   : WEEKEND_AFTERNOON_SCENES
    : isNight   ? NIGHT_SCENES           : isMorning ? MORNING_SCENES           : AFTERNOON_SCENES;

  const scene = rand(scenes);
  const shotType = rand(SHOT_TYPES);
  const prompt = BASE_PROMPT.replaceAll("[SCENE]", scene.en).replace("[SHOT TYPE]", shotType);

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
