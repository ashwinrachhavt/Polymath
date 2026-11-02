import { describe, expect, it } from "vitest";
import { ZETTEL_MAX_SECTIONS, ZETTEL_SECTION_MAX_CHARS, splitSections } from "@/domains/knowledge/zettel-chunking";

// ~3,300 characters per section, so twelve of them comfortably clear 30,000.
const heading = (n: number) => `## Section ${n}\n\n${"Body text. ".repeat(300)}\n`;

describe("splitSections", () => {
  it("reads a 30,000-character document in full with no section over the cap", () => {
    const text = Array.from({ length: 12 }, (_, i) => heading(i)).join("\n");
    expect(text.length).toBeGreaterThanOrEqual(30_000);
    const { sections, readChars, unreadChars } = splitSections(text);
    expect(unreadChars).toBe(0);
    expect(readChars).toBe(text.length);
    expect(Math.max(...sections.map((s) => s.text.length))).toBeLessThanOrEqual(ZETTEL_SECTION_MAX_CHARS);
  });

  it("reports unread characters instead of silently dropping sections", () => {
    const text = Array.from({ length: ZETTEL_MAX_SECTIONS + 4 }, (_, i) => heading(i)).join("\n");
    const { sections, readChars, unreadChars, unreadSections } = splitSections(text);
    expect(sections.length).toBe(ZETTEL_MAX_SECTIONS);
    expect(unreadChars).toBeGreaterThan(0);
    expect(unreadSections).toBe(4);
    // Every character is either read or explicitly reported; none vanishes.
    expect(readChars + unreadChars).toBe(text.length);
  });

  it("splits an unheaded document on paragraph boundaries", () => {
    const text = Array.from({ length: 40 }, () => "Paragraph body sentence.".repeat(60)).join("\n\n");
    const { sections } = splitSections(text);
    expect(sections.length).toBeGreaterThan(1);
    expect(Math.max(...sections.map((s) => s.text.length))).toBeLessThanOrEqual(ZETTEL_SECTION_MAX_CHARS);
  });
});
