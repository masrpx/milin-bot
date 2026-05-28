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

export type SceneSlot = { prompt: string; sceneContext: string; outfit: string };

const BASE_PROMPT = `Create a realistic casual selfie or candid photo of the specified person in [SCENE], wearing [OUTFIT], with a [MOOD] expression.

The image should feel natural, spontaneous, and slightly imperfect, like a real everyday moment captured quickly with a phone camera. Keep the person clearly recognizable, but avoid making the image look like a professional photoshoot, influencer post, or AI-generated beauty portrait.

Use natural facial details, slightly messy hair, relaxed posture, authentic body language, and imperfect framing. Include subtle imperfections such as slight motion blur, mild grain, uneven lighting, soft focus in some areas, or casual awkward camera angles.

Sometimes show the person actively taking the selfie — arm extended toward the camera, front-camera angle slightly above eye level, as if caught mid-snap.

The lighting should feel natural and believable — daylight from windows, outdoor sunlight, warm indoor lighting, street lights, cafe ambience, etc. The composition should feel human and unplanned, as if someone casually took the photo during a normal moment.

Style: photorealistic, candid photography, natural phone-camera quality, imperfect realism, everyday atmosphere, handheld selfie feel, no beauty filter, no heavy retouching, authentic and believable.`;

type Scene = {
  en: string;
  th: string;
  outfits: string[];
};

type TimePool = {
  scenes: Scene[];
  moods: string[];
};

const MORNING_POOL: TimePool = {
  scenes: [
    {
      en: "sunlit cafe window seat", th: "นั่งอยู่ที่คาเฟ่แสงแดดยามเช้า",
      outfits: ["lightweight cardigan over a simple top", "casual summer dress", "oversized white shirt"],
    },
    {
      en: "hotel balcony after waking up", th: "ตื่นนอนมายืนอยู่ที่ระเบียงโรงแรม",
      outfits: ["cozy oversized T-shirt and shorts", "cozy crew-neck knit sweater", "lightweight cardigan over a simple top"],
    },
    {
      en: "morning walk in the park", th: "เดินเล่นอยู่ในสวนยามเช้า",
      outfits: ["sporty yoga set", "casual fitted top with loose shorts", "cozy oversized T-shirt and shorts"],
    },
    {
      en: "kitchen making coffee", th: "ชงกาแฟอยู่ในครัว",
      outfits: ["oversized white shirt", "cozy oversized T-shirt and shorts", "cozy crew-neck knit sweater"],
    },
    {
      en: "beachside breakfast table", th: "นั่งกินอาหารเช้าริมทะเล",
      outfits: ["casual summer dress", "casual fitted top with loose shorts", "lightweight cardigan over a simple top"],
    },
    {
      en: "casual mirror selfie before going out", th: "เซลฟี่หน้ากระจกก่อนออกไปข้างนอก",
      outfits: ["casual summer dress", "lightweight cardigan over a simple top", "casual fitted top with loose shorts"],
    },
    {
      en: "reading near a bedroom window", th: "อ่านหนังสืออยู่ริมหน้าต่าง",
      outfits: ["cozy crew-neck knit sweater", "oversized white shirt", "cozy oversized T-shirt and shorts"],
    },
  ],
  moods: [
    "sleepy soft smile",
    "relaxed morning face",
    "playful and fresh",
    "cozy and calm",
    "naturally happy",
    "dreamy gaze",
    "casual confidence",
  ],
};

const AFTERNOON_POOL: TimePool = {
  scenes: [
    {
      en: "outdoor brunch cafe", th: "นั่งบรันช์คาเฟ่กลางแจ้ง",
      outfits: ["casual summer dress", "casual romper", "elegant casual blouse with shorts"],
    },
    {
      en: "shopping mall mirror selfie", th: "เซลฟี่หน้ากระจกในห้าง",
      outfits: ["casual tank top and jeans", "denim jacket over simple top", "elegant casual blouse with shorts"],
    },
    {
      en: "rooftop terrace cafe", th: "นั่งเล่นอยู่บนดาดฟ้า",
      outfits: ["casual summer dress", "casual romper", "elegant casual blouse with shorts"],
    },
    {
      en: "bookstore cafe corner", th: "นั่งอยู่ในร้านหนังสือ",
      outfits: ["casual tank top and jeans", "denim jacket over simple top", "casual romper"],
    },
    {
      en: "city street walk", th: "เดินเล่นอยู่กลางเมือง",
      outfits: ["casual tank top and jeans", "denim jacket over simple top", "casual summer dress"],
    },
    {
      en: "gym break selfie", th: "หยุดพักระหว่างออกกำลังกาย",
      outfits: ["sporty matching workout set", "sporty tank top with leggings", "athletic crop top with shorts"],
    },
    {
      en: "sitting in a parked car during golden hour", th: "นั่งอยู่ในรถช่วงแสงทอง",
      outfits: ["casual tank top and jeans", "denim jacket over simple top", "casual summer dress"],
    },
  ],
  moods: [
    "playful smirk",
    "warm smile",
    "carefree energy",
    "relaxed and confident",
    "thoughtful but soft",
    "light teasing smile",
    "naturally candid",
  ],
};

const NIGHT_POOL: TimePool = {
  scenes: [
    {
      en: "rooftop dinner at night", th: "ออกไปดินเนอร์บนดาดฟ้า",
      outfits: ["black blazer outfit", "elegant midi dress", "stylish evening blouse"],
    },
    {
      en: "luxury hotel mirror selfie", th: "เซลฟี่หน้ากระจกในโรงแรมหรู",
      outfits: ["elegant midi dress", "black blazer outfit", "long-sleeve dress"],
    },
    {
      en: "soft-lit apartment living room", th: "นั่งเล่นอยู่ในห้องนั่งเล่น",
      outfits: ["soft loungewear set", "cozy knit top with cardigan", "super casual t-shirt"],
    },
    {
      en: "late-night convenience store stop", th: "แวะร้านสะดวกซื้อดึกๆ",
      outfits: ["super casual t-shirt", "cozy knit top with cardigan", "soft loungewear set"],
    },
    {
      en: "evening city lights background", th: "ถ่ายรูปหน้าวิวเมืองตอนกลางคืน",
      outfits: ["elegant midi dress", "black blazer outfit", "stylish evening blouse"],
    },
    {
      en: "elegant restaurant table", th: "ออกไปกินข้าวที่ร้านหรู",
      outfits: ["elegant midi dress", "black blazer outfit", "long-sleeve dress"],
    },
    {
      en: "quiet balcony at night", th: "นั่งอยู่บนระเบียงตอนกลางคืน",
      outfits: ["soft loungewear set", "cozy knit top with cardigan", "super casual t-shirt"],
    },
  ],
  moods: [
    "quiet confidence",
    "gentle smile",
    "calm and elegant",
    "confident gaze",
    "relaxed evening mood",
    "mysterious expression",
    "gentle playful look",
  ],
};

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function pickScene(bangkokHour: number): SceneSlot {
  const pool =
    bangkokHour >= 20 || bangkokHour < 6 ? NIGHT_POOL :
    bangkokHour < 12                      ? MORNING_POOL :
                                            AFTERNOON_POOL;

  const scene  = rand(pool.scenes);
  const outfit = rand(scene.outfits);
  const mood   = rand(pool.moods);

  const prompt = BASE_PROMPT
    .replace("[SCENE]",  scene.en)
    .replace("[OUTFIT]", outfit)
    .replace("[MOOD]",   mood);

  return { prompt, sceneContext: scene.th, outfit };
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
    prompt: `${prompt}. Maintain the same person's face, appearance, hair, and style from the reference photo.`,
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
