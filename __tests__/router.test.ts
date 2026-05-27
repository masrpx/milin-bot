import { vi, describe, it, expect, beforeEach } from "vitest";
import type { MilinMemory } from "@/lib/vault";

// ---------------------------------------------------------------------------
// Mock all handler modules — each returns its own name so tests can assert
// which handler fired without hitting real network/LLM calls
// ---------------------------------------------------------------------------

vi.mock("@/lib/handlers/approve", () => ({
  isApproveCommand: vi.fn(),
  handleApprove: vi.fn().mockResolvedValue("approve"),
}));

vi.mock("@/lib/handlers/calendar", () => ({
  hasPendingColorReply: vi.fn(),
  isPendingCalendarConfirm: vi.fn(),
  handleColorReply: vi.fn().mockResolvedValue("colorReply"),
  handleCalendarConfirm: vi.fn().mockResolvedValue("calendarConfirm"),
  handleCalendar: vi.fn().mockResolvedValue("calendar"),
}));

vi.mock("@/lib/handlers/capture", () => ({
  handleCapture: vi.fn().mockResolvedValue("capture"),
}));

vi.mock("@/lib/handlers/article", () => ({
  handleArticle: vi.fn().mockResolvedValue("article"),
}));

vi.mock("@/lib/handlers/conversation", () => ({
  handleConversation: vi.fn().mockResolvedValue("conversation"),
}));

vi.mock("@/lib/handlers/photo-request", () => ({
  handlePhotoRequest: vi.fn().mockResolvedValue(undefined),
}));

// Vault updateMilinMemory — called fire-and-forget for stale pendingAction cleanup
vi.mock("@/lib/vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vault")>();
  return { ...actual, updateMilinMemory: vi.fn().mockResolvedValue(undefined) };
});

// ---------------------------------------------------------------------------
// Import routeMessage AFTER mocks are registered
// ---------------------------------------------------------------------------

import { routeMessage } from "@/lib/router";
import * as approveHandler from "@/lib/handlers/approve";
import * as calendarHandler from "@/lib/handlers/calendar";
import * as captureHandler from "@/lib/handlers/capture";
import * as articleHandler from "@/lib/handlers/article";
import * as conversationHandler from "@/lib/handlers/conversation";
import * as photoHandler from "@/lib/handlers/photo-request";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPLY_TOKEN = "tok-123";

function makeMemory(overrides: Partial<MilinMemory> = {}): MilinMemory {
  return {
    lastUpdated: new Date().toISOString(),
    aboutMax: [],
    learnedPreferences: [],
    topicsAsked: [],
    importantConversations: [],
    currentMood: "curious",
    relationshipStage: "สนิทกันมาก",
    recentMessages: [],
    ...overrides,
  };
}

const FUTURE_EXPIRY = new Date(Date.now() + 5 * 60 * 1000).toISOString();

const memoryWithCreatePending = makeMemory({
  pendingAction: {
    type: "create",
    eventTitle: "นัดหมอ",
    expiresAt: FUTURE_EXPIRY,
  },
});

const memoryWithDeletePending = makeMemory({
  pendingAction: {
    type: "delete",
    eventId: "abc",
    eventTitle: "นัดหมอ",
    expiresAt: FUTURE_EXPIRY,
  },
});

const plainMemory = makeMemory();

// Classifier stub: always returns "chat" unless overridden per test
const chatClassifier = vi.fn().mockResolvedValue("chat");
const calendarClassifier = vi.fn().mockResolvedValue("calendar");
const photoClassifier = vi.fn().mockResolvedValue("photo_request");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("routeMessage — priority table", () => {
  beforeEach(() => {
    vi.mocked(approveHandler.isApproveCommand).mockReturnValue(false);
    vi.mocked(calendarHandler.hasPendingColorReply).mockReturnValue(false);
    vi.mocked(calendarHandler.isPendingCalendarConfirm).mockReturnValue(false);
  });

  // Priority 1
  it("Priority 1 — approve command fires handleApprove", async () => {
    vi.mocked(approveHandler.isApproveCommand).mockReturnValue(true);
    const result = await routeMessage("ok ทั้งหมด", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("approve");
  });

  // Priority 2
  it("Priority 2 — pending color reply fires handleColorReply", async () => {
    vi.mocked(calendarHandler.hasPendingColorReply).mockReturnValue(true);
    // handleColorReply returns non-empty string → stops here
    vi.mocked(calendarHandler.handleColorReply).mockResolvedValue("colorReply");
    const result = await routeMessage("แดง", REPLY_TOKEN, memoryWithCreatePending, chatClassifier);
    expect(result).toBe("colorReply");
  });

  it("Priority 2 — empty color reply falls through to conversation", async () => {
    vi.mocked(calendarHandler.hasPendingColorReply).mockReturnValue(true);
    vi.mocked(calendarHandler.handleColorReply).mockResolvedValue(""); // expired
    const result = await routeMessage("แดง", REPLY_TOKEN, memoryWithCreatePending, chatClassifier);
    expect(result).toBe("conversation");
  });

  // Priority 3
  it("Priority 3 — ยืนยัน with valid pending fires handleCalendarConfirm", async () => {
    vi.mocked(calendarHandler.isPendingCalendarConfirm).mockReturnValue(true);
    vi.mocked(calendarHandler.handleCalendarConfirm).mockResolvedValue("calendarConfirm");
    const result = await routeMessage("ยืนยัน", REPLY_TOKEN, memoryWithDeletePending, chatClassifier);
    expect(result).toBe("calendarConfirm");
  });

  it("Priority 3 — empty confirm reply falls through to conversation", async () => {
    vi.mocked(calendarHandler.isPendingCalendarConfirm).mockReturnValue(true);
    vi.mocked(calendarHandler.handleCalendarConfirm).mockResolvedValue(""); // expired
    const result = await routeMessage("ยืนยัน", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("conversation");
  });

  // Priority 4
  it("Priority 4 — จด: prefix fires handleCapture (not article, even if long)", async () => {
    const longCapture = "จด: " + "x".repeat(600);
    const result = await routeMessage(longCapture, REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("capture");
    expect(vi.mocked(articleHandler.handleArticle)).not.toHaveBeenCalled();
  });

  // Priority 5
  it("Priority 5 — URL fires handleArticle", async () => {
    const result = await routeMessage("https://example.com/article", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("article");
  });

  it("Priority 5 — long text (>500 chars) fires handleArticle", async () => {
    const longText = "a".repeat(501);
    const result = await routeMessage(longText, REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("article");
  });

  // Priority 6 — calendar
  it("Priority 6 — classifier returns calendar → handleCalendar", async () => {
    const result = await routeMessage("นัดหมอพรุ่งนี้", REPLY_TOKEN, plainMemory, calendarClassifier);
    expect(result).toBe("calendar");
  });

  // Priority 6 — photo_request
  it("Priority 6 — classifier returns photo_request → handlePhotoRequest, returns ''", async () => {
    const result = await routeMessage("ส่งรูปหน่อย", REPLY_TOKEN, plainMemory, photoClassifier);
    expect(result).toBe("");
    expect(vi.mocked(photoHandler.handlePhotoRequest)).toHaveBeenCalledWith(
      REPLY_TOKEN,
      plainMemory
    );
  });

  // Priority 7
  it("Priority 7 — classifier returns chat → handleConversation", async () => {
    const result = await routeMessage("สวัสดี", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("conversation");
  });

  // Capture beats classifier
  it("จด: fires capture even when classifier would return calendar", async () => {
    const result = await routeMessage("จด: นัดหมอพรุ่งนี้", REPLY_TOKEN, plainMemory, calendarClassifier);
    expect(result).toBe("capture");
  });
});
