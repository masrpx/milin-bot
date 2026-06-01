import { describe, it, expect } from "vitest";
import { calcChunkSize, stripGutenbergBoilerplate } from "../lib/book-reader";

describe("calcChunkSize", () => {
  it("short book reads in 1 night", () => {
    expect(calcChunkSize(100_000)).toBe(100_000);
  });

  it("200k boundary reads in 1 night", () => {
    expect(calcChunkSize(200_000)).toBe(200_000);
  });

  it("medium book splits into 2 nights", () => {
    const chunk = calcChunkSize(300_000);
    expect(chunk).toBe(150_000);
    expect(Math.ceil(300_000 / chunk)).toBe(2);
  });

  it("long book splits into 3 nights", () => {
    const chunk = calcChunkSize(600_000);
    expect(chunk).toBe(200_000);
    expect(Math.ceil(600_000 / chunk)).toBe(3);
  });

  it("very long book is capped at 250k", () => {
    expect(calcChunkSize(1_000_000)).toBe(250_000);
    expect(calcChunkSize(2_000_000)).toBe(250_000);
  });
});

describe("stripGutenbergBoilerplate", () => {
  it("strips header and footer leaving only content", () => {
    const text = `Header stuff here.

*** START OF THE PROJECT GUTENBERG EBOOK TEST ***

This is the actual content.
More content here.

*** END OF THE PROJECT GUTENBERG EBOOK TEST ***

Footer donation text.`;
    const stripped = stripGutenbergBoilerplate(text);
    expect(stripped).toBe("This is the actual content.\nMore content here.");
    expect(stripped).not.toContain("Header");
    expect(stripped).not.toContain("Footer");
    expect(stripped).not.toContain("START OF THE PROJECT");
  });

  it("returns original text when markers are missing", () => {
    const text = "No markers here at all.";
    expect(stripGutenbergBoilerplate(text)).toBe(text);
  });

  it("handles missing END marker gracefully", () => {
    const text = `Preamble\n*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\nContent`;
    expect(stripGutenbergBoilerplate(text)).toBe(text);
  });
});
