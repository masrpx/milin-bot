import { describe, it, expect } from "vitest";
import { buildMilinSystemPrompt, buildMemoryExtractPrompt } from "@/lib/milin-prompt";
import type { MilinMemory } from "@/lib/vault";

const BASE_MEMORY: MilinMemory = {
  lastUpdated: "2026-05-27T00:00:00.000Z",
  aboutMax: ["Max ทำงานด้าน PropTech", "Max ชอบ Biohacking"],
  learnedPreferences: ["Max ชอบกาแฟดำ"],
  topicsAsked: ["Longevity", "AI"],
  importantConversations: [
    { date: "2026-05-01", summary: "คุยเรื่องงาน" },
  ],
  currentMood: "playful and flirty",
  relationshipStage: "สนิทกันมาก",
  recentMessages: [],
  milinActivity: "ส่งรูปชุดว่ายน้ำตอนเช้า",
};

describe("buildMilinSystemPrompt", () => {
  it("contains Milin identity header", () => {
    const prompt = buildMilinSystemPrompt(BASE_MEMORY);
    expect(prompt).toContain("คุณคือ Milin");
  });

  it("contains conversation rules section", () => {
    const prompt = buildMilinSystemPrompt(BASE_MEMORY);
    expect(prompt).toContain("## กฎการสนทนา");
  });

  it("contains flirty personality marker", () => {
    const prompt = buildMilinSystemPrompt(BASE_MEMORY);
    expect(prompt).toContain("flirty");
  });

  it("injects aboutMax facts", () => {
    const prompt = buildMilinSystemPrompt(BASE_MEMORY);
    expect(prompt).toContain("Max ทำงานด้าน PropTech");
  });

  it("injects currentMood", () => {
    const prompt = buildMilinSystemPrompt(BASE_MEMORY);
    expect(prompt).toContain("playful and flirty");
  });

  it("injects milinActivity when present", () => {
    const prompt = buildMilinSystemPrompt(BASE_MEMORY);
    expect(prompt).toContain("ส่งรูปชุดว่ายน้ำตอนเช้า");
  });

  it("shows fallback when milinActivity is absent", () => {
    const prompt = buildMilinSystemPrompt({ ...BASE_MEMORY, milinActivity: undefined });
    expect(prompt).toContain("ยังไม่ได้ส่งข้อความหาก่อน");
  });

  it("injects vaultContext when provided", () => {
    const prompt = buildMilinSystemPrompt(BASE_MEMORY, "## vault-note.md\nsome content");
    expect(prompt).toContain("some content");
  });

  it("shows vault fallback when vaultContext is absent", () => {
    const prompt = buildMilinSystemPrompt(BASE_MEMORY);
    expect(prompt).toContain("(ไม่มีข้อมูลเพิ่มเติม)");
  });

  it("injects relationshipStage", () => {
    const prompt = buildMilinSystemPrompt(BASE_MEMORY);
    expect(prompt).toContain("สนิทกันมาก");
  });
});

describe("buildMemoryExtractPrompt", () => {
  it("contains the user message", () => {
    const p = buildMemoryExtractPrompt("สวัสดีตอนเช้า", "สวัสดีจ้า~");
    expect(p).toContain("สวัสดีตอนเช้า");
  });

  it("contains the ai response", () => {
    const p = buildMemoryExtractPrompt("hi", "สวัสดีจ้า~");
    expect(p).toContain("สวัสดีจ้า~");
  });

  it("includes topicAsked field when wasVaultQuery is true", () => {
    const p = buildMemoryExtractPrompt("อธิบาย Longevity", "...", true);
    expect(p).toContain("topicAsked");
  });

  it("omits topicAsked field when wasVaultQuery is false", () => {
    const p = buildMemoryExtractPrompt("สวัสดี", "สวัสดีจ้า~", false);
    expect(p).not.toContain("topicAsked");
  });
});
