import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Octokit so tests don't hit GitHub
// vi.hoisted ensures these refs are initialized before vi.mock factories run
// ---------------------------------------------------------------------------

const { mockGetContent, mockUpsertContent } = vi.hoisted(() => ({
  mockGetContent: vi.fn(),
  mockUpsertContent: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  // Must use regular function (not arrow) so `new Octokit()` works as constructor
  Octokit: vi.fn(function () {
    return {
      repos: {
        getContent: mockGetContent,
        createOrUpdateFileContents: mockUpsertContent,
      },
    };
  }),
}));

import { generateTodoId, type InboxItem } from "@/lib/todo";
import { handleTodoCapture } from "@/lib/handlers/todo-capture";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeJson(data: unknown): string {
  return Buffer.from(JSON.stringify(data), "utf-8").toString("base64");
}

function makeInboxItem(text: string): InboxItem {
  return { id: generateTodoId(), text, addedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// generateTodoId
// ---------------------------------------------------------------------------

describe("generateTodoId", () => {
  it("returns a non-empty string", () => {
    expect(typeof generateTodoId()).toBe("string");
    expect(generateTodoId().length).toBeGreaterThan(0);
  });

  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 20 }, generateTodoId));
    expect(ids.size).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// handleTodoCapture
// ---------------------------------------------------------------------------

describe("handleTodoCapture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertContent.mockResolvedValue({});
  });

  it("adds a new item to inbox when inbox is empty", async () => {
    mockGetContent.mockRejectedValue(new Error("Not Found")); // file doesn't exist yet
    const reply = await handleTodoCapture("buy protein");
    expect(reply).toContain("จดไว้แล้ว ✓");
    expect(mockUpsertContent).toHaveBeenCalledOnce();
    const written = JSON.parse(
      Buffer.from(mockUpsertContent.mock.calls[0][0].content, "base64").toString("utf-8")
    ) as InboxItem[];
    expect(written).toHaveLength(1);
    expect(written[0].text).toBe("buy protein");
  });

  it("adds a new item when inbox already has items", async () => {
    const existing: InboxItem[] = [makeInboxItem("existing task")];
    mockGetContent.mockResolvedValue({
      data: { content: encodeJson(existing), sha: "sha1" },
    });
    await handleTodoCapture("new task");
    const written = JSON.parse(
      Buffer.from(mockUpsertContent.mock.calls[0][0].content, "base64").toString("utf-8")
    ) as InboxItem[];
    expect(written).toHaveLength(2);
    expect(written[1].text).toBe("new task");
  });

  it("always accepts items regardless of count (no cap at capture time)", async () => {
    const existing: InboxItem[] = Array.from({ length: 15 }, (_, i) =>
      makeInboxItem(`task ${i + 1}`)
    );
    mockGetContent.mockResolvedValue({
      data: { content: encodeJson(existing), sha: "sha1" },
    });
    const reply = await handleTodoCapture("task 16");
    expect(reply).toContain("จดไว้แล้ว ✓");
    expect(mockUpsertContent).toHaveBeenCalledOnce();
  });
});
