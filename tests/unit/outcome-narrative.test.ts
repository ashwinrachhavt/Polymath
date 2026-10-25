import { describe, expect, it } from "vitest";
import { composeOutcomeNarrative, narrativeToNoteContent } from "@/domains/work/outcome-narrative";

const base = { start: "2026-10-19", end: "2026-10-25" };
const session = (over: Partial<Parameters<typeof composeOutcomeNarrative>[0]["sessions"][number]> = {}) => ({
  endedAt: "2026-10-20T18:00:00.000Z",
  minutes: 25,
  taskTitle: "Draft the roadmap",
  subject: null,
  outcome: "Outlined three quarters of work",
  ...over,
});

describe("composeOutcomeNarrative (ASH-280)", () => {
  it("returns nothing for an empty week", () => {
    expect(composeOutcomeNarrative({ ...base, sessions: [], stones: [] })).toBeNull();
  });

  it("restates the owner's own sentences with counts and no score, points or streak", () => {
    const n = composeOutcomeNarrative({
      ...base,
      sessions: [session(), session({ endedAt: "2026-10-21T18:00:00.000Z", minutes: 40, taskTitle: null, subject: "Reading", outcome: "Finished chapter 4" })],
      stones: [{ label: "Quartz", note: null }, { label: "Quartz", note: null }],
    })!;
    expect(n.title).toBe("Week of Oct 19 to Oct 25");
    expect(n.markdown).toContain("finished 2 focus sessions (65 minutes in all) and earned 2 stones");
    expect(n.markdown).toContain("- Draft the roadmap: Outlined three quarters of work");
    expect(n.markdown).toContain("- Reading: Finished chapter 4");
    expect(n.markdown).toContain("Stones: 2 Quartz.");
    expect(n.markdown).not.toMatch(/streak|points|score/i);
  });

  it("uses singular forms and is honest when no outcome sentence was recorded", () => {
    const n = composeOutcomeNarrative({ ...base, sessions: [session({ minutes: 1, outcome: null })], stones: [] })!;
    expect(n.markdown).toContain("finished 1 focus session (1 minute in all)");
    expect(n.markdown).toContain("No outcome sentence was recorded on these sessions.");
    expect(n.markdown).not.toContain("In your own words");
  });

  it("does not repeat a stone note that already appears as a session outcome", () => {
    const n = composeOutcomeNarrative({ ...base, sessions: [session()], stones: [{ label: "Quartz", note: "Outlined three quarters of work" }, { label: "Quartz", note: "Shipped the fix" }] })!;
    expect(n.markdown.match(/Outlined three quarters of work/g)).toHaveLength(1);
    expect(n.markdown).toContain("- Shipped the fix");
  });

  it("orders outcomes by time and caps the list with an honest remainder", () => {
    const sessions = Array.from({ length: 11 }, (_, i) => session({ endedAt: `2026-10-2${i % 5}T1${i % 10}:00:00.000Z`, outcome: `Outcome ${i}`, taskTitle: null }));
    const n = composeOutcomeNarrative({ ...base, sessions, stones: [] })!;
    expect(n.markdown.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(9);
    expect(n.markdown).toContain("- and 3 more outcomes");
  });

  it("collapses whitespace in recorded sentences and builds plain editor content", () => {
    const n = composeOutcomeNarrative({ ...base, sessions: [session({ taskTitle: null, outcome: "  two\n\nlines  " })], stones: [] })!;
    expect(n.markdown).toContain("- two lines");
    const doc = narrativeToNoteContent(n) as { type: string; content: Array<{ type: string; content: Array<{ text: string }> }> };
    expect(doc.type).toBe("doc");
    expect(doc.content.every((p) => p.type === "paragraph" && p.content[0].text.length > 0)).toBe(true);
    expect(n.plainText).not.toMatch(/^- /m);
  });
});
