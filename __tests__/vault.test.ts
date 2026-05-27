import { describe, it, expect } from "vitest";
import { parseMilinMemory, getDateOffset } from "@/lib/vault";

// ---------------------------------------------------------------------------
// Full markdown fixture — covers every section the parser touches
// ---------------------------------------------------------------------------
const FULL_MARKDOWN = `---
last_updated: 2026-05-27T00:00:00.000Z
---

## สิ่งที่รู้เกี่ยวกับ Max
- Max ทำงานด้าน PropTech
- Max ชอบ biohacking

## สิ่งที่เรียนรู้
- Max ชอบกาแฟดำ
- Max ไม่ชอบ small talk

## หัวข้อที่ Max สนใจ
- Longevity
- AI

## บทสนทนาสำคัญ
- 2026-05-01: คุยเรื่องงาน
- 2026-05-02: ถามเรื่อง sleep apnea

## Milin's current mood
playful and curious

## Relationship stage
สนิทกันมาก

## Recent Messages
\`\`\`json
[{"role":"user","content":"สวัสดี"},{"role":"assistant","content":"สวัสดีจ้า~"}]
\`\`\`

## Milin's Recent Activity
ส่งรูปไปตอนเช้า

## Pending Action
{"type":"delete","eventId":"abc123","eventTitle":"นัดหมอ","expiresAt":"2099-01-01T00:00:00.000Z"}
`;

describe("parseMilinMemory", () => {
  it("parses aboutMax list correctly", () => {
    const m = parseMilinMemory(FULL_MARKDOWN);
    expect(m.aboutMax).toEqual(["Max ทำงานด้าน PropTech", "Max ชอบ biohacking"]);
  });

  it("parses learnedPreferences list correctly", () => {
    const m = parseMilinMemory(FULL_MARKDOWN);
    expect(m.learnedPreferences).toEqual(["Max ชอบกาแฟดำ", "Max ไม่ชอบ small talk"]);
  });

  it("parses topicsAsked list correctly", () => {
    const m = parseMilinMemory(FULL_MARKDOWN);
    expect(m.topicsAsked).toEqual(["Longevity", "AI"]);
  });

  it("parses importantConversations with date + summary", () => {
    const m = parseMilinMemory(FULL_MARKDOWN);
    expect(m.importantConversations).toEqual([
      { date: "2026-05-01", summary: "คุยเรื่องงาน" },
      { date: "2026-05-02", summary: "ถามเรื่อง sleep apnea" },
    ]);
  });

  it("parses currentMood", () => {
    const m = parseMilinMemory(FULL_MARKDOWN);
    expect(m.currentMood).toBe("playful and curious");
  });

  it("auto-evolves relationshipStage from conversation count (2 convos → เพิ่งเริ่มคุยกัน)", () => {
    const m = parseMilinMemory(FULL_MARKDOWN);
    // 2 conversations → < 5 threshold
    expect(m.relationshipStage).toBe("เพิ่งเริ่มคุยกัน");
  });

  it("parses recentMessages JSON block", () => {
    const m = parseMilinMemory(FULL_MARKDOWN);
    expect(m.recentMessages).toEqual([
      { role: "user", content: "สวัสดี" },
      { role: "assistant", content: "สวัสดีจ้า~" },
    ]);
  });

  it("parses milinActivity", () => {
    const m = parseMilinMemory(FULL_MARKDOWN);
    expect(m.milinActivity).toBe("ส่งรูปไปตอนเช้า");
  });

  it("parses pendingAction JSON", () => {
    const m = parseMilinMemory(FULL_MARKDOWN);
    expect(m.pendingAction).toMatchObject({
      type: "delete",
      eventId: "abc123",
      eventTitle: "นัดหมอ",
    });
  });
});

// ---------------------------------------------------------------------------
// Edge cases — missing / malformed sections
// ---------------------------------------------------------------------------
describe("parseMilinMemory — edge cases", () => {
  it("returns empty arrays for missing list sections", () => {
    const minimal = `## Milin's current mood\ncurious\n## Relationship stage\nสนิทกันมาก\n## บทสนทนาสำคัญ\n`;
    const m = parseMilinMemory(minimal);
    expect(m.aboutMax).toEqual([]);
    expect(m.learnedPreferences).toEqual([]);
    expect(m.topicsAsked).toEqual([]);
    expect(m.importantConversations).toEqual([]);
  });

  it("defaults currentMood when section is missing", () => {
    const m = parseMilinMemory("## Relationship stage\ntest\n");
    expect(m.currentMood).toBe("curious and warm");
  });

  it("returns undefined pendingAction for malformed JSON", () => {
    const bad = `## Pending Action\nnot-valid-json\n`;
    const m = parseMilinMemory(bad);
    expect(m.pendingAction).toBeUndefined();
  });

  it("returns empty recentMessages for malformed JSON block", () => {
    const bad = `## Recent Messages\n\`\`\`json\n{broken\n\`\`\`\n`;
    const m = parseMilinMemory(bad);
    expect(m.recentMessages).toEqual([]);
  });

  it("returns undefined milinActivity when section is absent", () => {
    const m = parseMilinMemory("## Milin's current mood\nhappy\n");
    expect(m.milinActivity).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getDateOffset
// ---------------------------------------------------------------------------
describe("getDateOffset", () => {
  it("returns today's date as YYYY-MM-DD for offset 0", () => {
    const result = getDateOffset(0);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Must equal today's actual date
    const expected = new Date().toISOString().split("T")[0];
    expect(result).toBe(expected);
  });

  it("returns yesterday's date for offset -1", () => {
    const result = getDateOffset(-1);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(result).toBe(yesterday.toISOString().split("T")[0]);
  });
});
