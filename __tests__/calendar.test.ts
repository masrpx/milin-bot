import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mock refs before any vi.mock factories run
// ---------------------------------------------------------------------------

const { mockCreate, mockCreateEvent } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockCreateEvent: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  // Regular function so `new Anthropic()` works as a constructor
  default: vi.fn(function () {
    return { messages: { create: mockCreate } };
  }),
}));

vi.mock("@/lib/calendar", () => ({
  getEvents: vi.fn().mockResolvedValue([]),
  createEvent: mockCreateEvent,
  deleteEvent: vi.fn(),
  updateEvent: vi.fn(),
  findFreeSlots: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/vault", () => ({
  updateMilinMemory: vi.fn(),
}));

import { handleCalendar } from "@/lib/handlers/calendar";
import type { MilinMemory } from "@/lib/vault";

const emptyMemory: MilinMemory = {} as MilinMemory;

function stubParsedIntent(json: object) {
  mockCreate.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify(json) }],
  });
}

describe("handleCalendar — bulk_create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateEvent.mockResolvedValue(undefined);
  });

  it("creates all events and returns a summary when all succeed", async () => {
    stubParsedIntent({
      intent: "bulk_create",
      events: [
        { title: "ประชุม branch manager", startISO: "2026-06-08T14:00:00+07:00", endISO: "2026-06-08T15:00:00+07:00", colorId: 5 },
        { title: "ประชุม branch manager", startISO: "2026-06-15T14:00:00+07:00", endISO: "2026-06-15T15:00:00+07:00", colorId: 5 },
        { title: "ประชุม branch manager", startISO: "2026-06-22T14:30:00+07:00", endISO: "2026-06-22T15:30:00+07:00", colorId: 5 },
      ],
    });

    const reply = await handleCalendar("bulk test", emptyMemory);

    expect(mockCreateEvent).toHaveBeenCalledTimes(3);
    expect(reply).toContain("3 นัด");
    expect(reply).toContain("ประชุม branch manager");
    expect(reply).toContain("📅");
    expect(reply).toContain("14:00–15:00");
    expect(reply).toContain("14:30–15:30");
  });

  it("reports partial success when some events fail", async () => {
    stubParsedIntent({
      intent: "bulk_create",
      events: [
        { title: "Test", startISO: "2026-07-08T14:00:00+07:00", endISO: "2026-07-08T15:00:00+07:00", colorId: 5 },
        { title: "Test", startISO: "2026-07-15T14:00:00+07:00", endISO: "2026-07-15T15:00:00+07:00", colorId: 5 },
      ],
    });
    mockCreateEvent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Calendar API error"));

    const reply = await handleCalendar("bulk test", emptyMemory);

    expect(mockCreateEvent).toHaveBeenCalledTimes(2);
    expect(reply).toContain("ล้มเหลว 1 นัด");
    expect(reply).toContain("ได้ 1 นัด");
  });

  it("returns error message when all events fail", async () => {
    stubParsedIntent({
      intent: "bulk_create",
      events: [
        { title: "Test", startISO: "2026-08-07T14:00:00+07:00", endISO: "2026-08-07T15:00:00+07:00", colorId: 5 },
      ],
    });
    mockCreateEvent.mockRejectedValue(new Error("fail"));

    const reply = await handleCalendar("bulk test", emptyMemory);

    expect(reply).toContain("ไม่สำเร็จ");
  });

  it("returns error message for empty events array", async () => {
    stubParsedIntent({ intent: "bulk_create", events: [] });

    const reply = await handleCalendar("bulk test", emptyMemory);

    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(reply).toContain("ไม่เข้าใจ");
  });
});
