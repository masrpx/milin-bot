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

const CHARACTER_ANCHOR = `A beautiful young woman, 22–24 years old, half-Korean half-American, with long flowing dark hair, expressive eyes, refined youthful features, natural skin texture, and a warm confident charm.`;

const BASE_PROMPT = `Create a realistic candid photo of this exact person in [SCENE], wearing [OUTFIT], with a [MOOD] expression. She looks confident, graceful, and quietly alluring — relaxed body language, soft expressive gaze, natural posture.

${CHARACTER_ANCHOR}

Use a flattering but natural camera angle, slightly off-center composition, realistic skin texture, natural facial details, and soft warm lighting. The lighting should feel believable — daylight from windows, outdoor sunlight, warm indoor light, street lights, or cafe ambience.

The image should feel natural, spontaneous, and slightly imperfect — like a real moment captured with a phone or mirrorless camera. Include mild grain, slight softness, natural shadows, and uneven framing.

Sometimes show her actively taking the selfie — arm extended toward the camera, front-camera angle slightly above eye level, as if caught mid-snap.

Avoid overly perfect AI beauty, plastic skin, exaggerated posing, or heavy retouching. Keep her clearly recognizable while preserving natural imperfections and authentic body language.

Style: ultra-realistic, candid photography, natural phone-camera quality, tasteful and intimate, soft warm light, imperfect realism, refined and confident mood.`;

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
      outfits: ["casual summer dress", "oversized white shirt"],
    },
    {
      en: "hotel balcony after waking up", th: "ตื่นนอนมายืนอยู่ที่ระเบียงโรงแรม",
      outfits: ["cozy oversized T-shirt and shorts", "lightweight cardigan over a simple top"],
    },
    {
      en: "morning gym session", th: "ออกกำลังกายยามเช้า",
      outfits: ["sports bra and shorts", "sporty yoga set"],
    },
    {
      en: "beachside breakfast table", th: "นั่งกินอาหารเช้าริมทะเล",
      outfits: ["casual summer dress", "casual fitted top with loose shorts"],
    },
    {
      en: "casual mirror selfie before going out", th: "เซลฟี่หน้ากระจกก่อนออกไปข้างนอก",
      outfits: ["casual summer dress", "casual fitted top with loose shorts"],
    },
  ],
  moods: [
    "sleepy soft smile",
    "playful and fresh",
    "naturally happy",
    "dreamy gaze",
    "casual confidence",
  ],
};

const AFTERNOON_POOL: TimePool = {
  scenes: [
    {
      en: "outdoor brunch cafe", th: "นั่งบรันช์คาเฟ่กลางแจ้ง",
      outfits: ["casual summer dress", "casual romper"],
    },
    {
      en: "rooftop terrace cafe", th: "นั่งเล่นอยู่บนดาดฟ้า",
      outfits: ["casual romper", "elegant casual blouse with shorts"],
    },
    {
      en: "city street walk", th: "เดินเล่นอยู่กลางเมือง",
      outfits: ["casual tank top and jeans", "casual summer dress"],
    },
    {
      en: "gym break selfie", th: "หยุดพักระหว่างออกกำลังกาย",
      outfits: ["sports bra and shorts", "athletic crop top with shorts"],
    },
    {
      en: "sitting in a parked car during golden hour", th: "นั่งอยู่ในรถช่วงแสงทอง",
      outfits: ["casual tank top and jeans", "casual summer dress"],
    },
  ],
  moods: [
    "playful smirk",
    "warm smile",
    "carefree energy",
    "light teasing smile",
    "naturally candid",
  ],
};

const NIGHT_POOL: TimePool = {
  scenes: [
    {
      en: "rooftop dinner at night", th: "ออกไปดินเนอร์บนดาดฟ้า",
      outfits: ["elegant midi dress", "stylish evening blouse"],
    },
    {
      en: "hotel room sofa, city lights through the window at night", th: "นั่งเล่นในโรงแรม วิวเมืองตอนกลางคืน",
      outfits: ["elegant midi dress", "long-sleeve dress"],
    },
    {
      en: "elegant restaurant table", th: "ออกไปกินข้าวที่ร้านหรู",
      outfits: ["elegant midi dress", "black blazer outfit"],
    },
    {
      en: "quiet apartment balcony at night, city view", th: "นั่งอยู่บนระเบียงตอนกลางคืน",
      outfits: ["oversized t-shirt and casual pants", "cozy knit top with cardigan"],
    },
    {
      en: "late night gym session", th: "ออกกำลังกายตอนดึก",
      outfits: ["sports bra and shorts", "sporty crop top with leggings"],
    },
  ],
  moods: [
    "quiet confidence",
    "gentle smile",
    "calm and elegant",
    "confident gaze",
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
    .replaceAll("[SCENE]",  scene.en)
    .replaceAll("[OUTFIT]", outfit)
    .replaceAll("[MOOD]",   mood);

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
