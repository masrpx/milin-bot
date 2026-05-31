import { vi, describe, it, expect, beforeEach } from "vitest";
import type { MilinMemory } from "@/lib/vault";

// ---------------------------------------------------------------------------
// Mock all handler modules — each returns its own name so tests can assert
// which handler fired without hitting real network/LLM calls
// ---------------------------------------------------------------------------

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

vi.mock("@/lib/handlers/todo-capture", () => ({
  handleTodoCapture: vi.fn().mockResolvedValue("todo-capture"),
}));

vi.mock("@/lib/handlers/ndn", () => ({
  isPendingRescheduleConfirm: vi.fn().mockReturnValue(false),
  confirmReschedule: vi.fn().mockResolvedValue(""),
  handleNDN: vi.fn().mockResolvedValue("ndn"),
}));

vi.mock("@/lib/handlers/nvdn", () => ({
  isPendingNVDNMore: vi.fn().mockReturnValue(false),
  handleNVDN: vi.fn().mockResolvedValue("nvdn"),
}));

vi.mock("@/lib/handlers/todo-classify", () => ({
  isPendingTodoClassify: vi.fn().mockReturnValue(false),
  handleTodoClassify: vi.fn().mockResolvedValue("todo-classify"),
  handleInboxQuery: vi.fn().mockResolvedValue("inbox-query"),
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
import * as calendarHandler from "@/lib/handlers/calendar";
import * as captureHandler from "@/lib/handlers/capture";
import * as articleHandler from "@/lib/handlers/article";
import * as conversationHandler from "@/lib/handlers/conversation";
import * as photoHandler from "@/lib/handlers/photo-request";
import * as todoCapture from "@/lib/handlers/todo-capture";
import * as ndnHandler from "@/lib/handlers/ndn";
import * as nvdnHandler from "@/lib/handlers/nvdn";
import * as todoClassify from "@/lib/handlers/todo-classify";

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
    vi.mocked(calendarHandler.hasPendingColorReply).mockReturnValue(false);
    vi.mocked(calendarHandler.isPendingCalendarConfirm).mockReturnValue(false);
    vi.mocked(ndnHandler.isPendingRescheduleConfirm).mockReturnValue(false);
    vi.mocked(nvdnHandler.isPendingNVDNMore).mockReturnValue(false);
    vi.mocked(todoClassify.isPendingTodoClassify).mockReturnValue(false);
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

  // cap: todo capture
  it("cap: routes to handleTodoCapture, not article (even if long)", async () => {
    vi.mocked(articleHandler.handleArticle).mockClear();
    const longCapture = "cap: " + "x".repeat(600);
    const result = await routeMessage(longCapture, REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("todo-capture");
    expect(vi.mocked(articleHandler.handleArticle)).not.toHaveBeenCalled();
  });

  it("cap: strips prefix before passing text to handleTodoCapture", async () => {
    await routeMessage("cap: buy protein", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(vi.mocked(todoCapture.handleTodoCapture)).toHaveBeenCalledWith("buy protein");
  });

  // NDN routing
  it("ndn alone routes to handleNDN", async () => {
    const result = await routeMessage("ndn", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("ndn");
  });

  it("ndn 1 ลบ routes to handleNDN", async () => {
    const result = await routeMessage("ndn 1 ลบ", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("ndn");
  });

  it("reschedule routes to handleNDN", async () => {
    const result = await routeMessage("reschedule meeting", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("ndn");
  });

  // NVDN routing
  it("milin nvdn keyword routes to handleNVDN", async () => {
    const result = await routeMessage("milin nvdn finance", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("nvdn");
  });

  it("nvdn alone routes to handleNVDN", async () => {
    const result = await routeMessage("nvdn", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("nvdn");
  });

  it("more routes to handleNVDN when nvdn_paginate is pending", async () => {
    vi.mocked(nvdnHandler.isPendingNVDNMore).mockReturnValueOnce(true);
    const result = await routeMessage("more", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("nvdn");
  });

  it("cap: and จด: don't conflict", async () => {
    const captureResult = await routeMessage("จด: some note", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(captureResult).toBe("capture");
  });

  it("inbox keyword routes to handleInboxQuery", async () => {
    const result = await routeMessage("ขอดู inbox วันนี้หน่อย", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("inbox-query");
  });

  it("pending todo_classify routes to handleTodoClassify", async () => {
    vi.mocked(todoClassify.isPendingTodoClassify).mockReturnValueOnce(true);
    const result = await routeMessage("1 ndn, 2 nvdn", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("todo-classify");
  });

  it("ndn still works while todo_classify is pending", async () => {
    vi.mocked(todoClassify.isPendingTodoClassify).mockReturnValue(true);
    const result = await routeMessage("ndn", REPLY_TOKEN, plainMemory, chatClassifier);
    expect(result).toBe("ndn"); // specific command takes priority over classify
  });
});
