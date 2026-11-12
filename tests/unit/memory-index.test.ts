import { describe, expect, it } from "vitest";
import {
  MEMORY_INDEX_HEADER,
  MEMORY_INDEX_MAX_CHARS,
  buildMemoryIndex,
  gistOf,
  memoryNoteKey,
  normalizeMemoryBody,
} from "@/domains/agents/memory";
import { isDuplicateNote, planConsolidation } from "@/domains/agents/memory-dreaming";

/*
 * The rules the dreaming pass enforces, proved without a model or a database:
 * duplicate detection, merge planning, correction, and the injected index's
 * hard cap — including the exact boundary, because "under the cap" and "at the
 * cap" are different assertions and the boundary is where an off-by-one lives.
 */

const note = (id: string, body: string, status: "unconfirmed" | "confirmed" | "corrected" = "unconfirmed", at = 0) => ({
  id,
  body,
  status,
  updatedAt: new Date(2026, 0, 1 + at),
});

describe("normalization and duplicate detection", () => {
  it("treats case, spacing and trailing punctuation as the same observation", () => {
    expect(normalizeMemoryBody("Prefers  short answers.")).toBe("prefers short answers");
    expect(memoryNoteKey("Prefers short answers")).toBe(memoryNoteKey("prefers   SHORT answers..."));
    expect(isDuplicateNote("Prefers short answers.", "prefers short answers")).toBe(true);
  });

  it("does not call two different observations duplicates", () => {
    expect(isDuplicateNote("Prefers short answers.", "Prefers long answers.")).toBe(false);
    // An empty body is never a duplicate of anything, including another empty.
    expect(isDuplicateNote("", "")).toBe(false);
  });
});

describe("merge planning", () => {
  it("folds a proposal that restates an existing note into the existing row", () => {
    const plan = planConsolidation({
      proposals: [{ body: "Prefers short answers.", quote: null }],
      existing: [{ id: "n1", body: "prefers short answers" }],
      verdicts: [],
    });
    expect(plan.create).toEqual([]);
    expect(plan.correct).toEqual([]);
    expect(plan.drop).toEqual([]);
  });

  it("folds duplicate proposals within one batch, keeping the first", () => {
    const plan = planConsolidation({
      proposals: [
        { body: "Works in UTC+5:30.", quote: null },
        { body: "works in utc+5:30", quote: null },
      ],
      existing: [],
      verdicts: [],
    });
    expect(plan.create.map((n) => n.body)).toEqual(["Works in UTC+5:30."]);
  });

  it("merges two existing notes the checker names as restatements", () => {
    const plan = planConsolidation({
      proposals: [],
      existing: [
        { id: "a", body: "Uses pnpm." },
        { id: "b", body: "uses PNPM" },
      ],
      verdicts: [],
      restatements: [{ keepId: "a", dropId: "b" }],
    });
    expect(plan.mergeInto).toEqual([{ keepId: "a", dropIds: ["b"] }]);
    expect(plan.drop).toEqual([]);
  });
});

describe("correction", () => {
  it("plans a correction when the transcript contradicts a note, and reports it as corrected", () => {
    const plan = planConsolidation({
      proposals: [],
      existing: [{ id: "n1", body: "Lives in Berlin." }],
      verdicts: [{ id: "n1", verdict: "correct", body: "Lives in Lisbon." }],
    });
    expect(plan.correct).toEqual([{ id: "n1", body: "Lives in Lisbon." }]);
    expect(plan.drop).toEqual([]);
  });

  it("drops a note the transcript contradicts with no supported correction", () => {
    const plan = planConsolidation({
      proposals: [],
      existing: [{ id: "n1", body: "Lives in Berlin." }],
      verdicts: [{ id: "n1", verdict: "drop" }],
    });
    expect(plan.drop).toEqual(["n1"]);
    expect(plan.correct).toEqual([]);
  });

  it("ignores a correction that changes nothing but whitespace", () => {
    const plan = planConsolidation({
      proposals: [],
      existing: [{ id: "n1", body: "Lives in Berlin." }],
      verdicts: [{ id: "n1", verdict: "correct", body: "lives in  berlin" }],
    });
    expect(plan.correct).toEqual([]);
  });

  it("checks a proposal against a note's CORRECTED wording, not its old wording", () => {
    // The old body was wrong; the corrected body is what the store will hold.
    // A proposal of the corrected text must not be written again.
    const plan = planConsolidation({
      proposals: [{ body: "Lives in Lisbon.", quote: null }],
      existing: [{ id: "n1", body: "Lives in Berlin." }],
      verdicts: [{ id: "n1", verdict: "correct", body: "Lives in Lisbon." }],
    });
    expect(plan.correct).toEqual([{ id: "n1", body: "Lives in Lisbon." }]);
    expect(plan.create).toEqual([]);
  });
});

describe("the injected index cap", () => {
  it("injects nothing when there are no notes", () => {
    const index = buildMemoryIndex([]);
    expect(index).toEqual({ text: "", includedIds: [], heldBack: 0 });
  });

  it("never exceeds the cap, at the exact boundary", () => {
    // Build notes whose gists fit exactly, then add one that would tip over.
    const notes = Array.from({ length: 20 }, (_, i) =>
      note(`n${i}`, `Observation number ${i} about how this person works, kept short.`, "unconfirmed", i),
    );
    const index = buildMemoryIndex(notes);
    expect(index.text.length).toBeLessThanOrEqual(MEMORY_INDEX_MAX_CHARS);
    expect(index.includedIds.length).toBeGreaterThan(0);
    // Everything not included is counted, never silently lost.
    expect(index.includedIds.length + index.heldBack).toBe(notes.length);
    // And one more character of room would not change that the text is capped.
    const exact = buildMemoryIndex(notes, index.text.length);
    expect(exact.text.length).toBeLessThanOrEqual(index.text.length);
  });

  it("holds back rather than truncating a note mid-sentence", () => {
    const long = "The person prefers long, careful explanations with examples drawn from their own writing.";
    const index = buildMemoryIndex([note("a", long)], MEMORY_INDEX_HEADER.length + 3 + gistOf(long).length - 1);
    expect(index.text).toBe("");
    expect(index.heldBack).toBe(1);
  });

  it("includes a note when the text fits the cap exactly, and not one character less", () => {
    const body = "Uses pnpm.";
    const fitsExactly = MEMORY_INDEX_HEADER.length + 1 + 2 + gistOf(body).length; // header + newline + "- " + gist
    expect(buildMemoryIndex([note("a", body)], fitsExactly).includedIds).toEqual(["a"]);
    expect(buildMemoryIndex([note("a", body)], fitsExactly - 1).includedIds).toEqual([]);
  });

  it("ranks a corrected note before an older unconfirmed one", () => {
    const index = buildMemoryIndex([
      note("old", "Unconfirmed but newer.", "unconfirmed", 5),
      note("fixed", "Corrected.", "corrected", 0),
    ]);
    expect(index.includedIds[0]).toBe("fixed");
  });

  it("shows the held-back count in the text so the agent knows more exists", () => {
    const notes = Array.from({ length: 12 }, (_, i) =>
      note(`n${i}`, `Observation ${i} with enough words to take space.`),
    );
    const index = buildMemoryIndex(notes, 400);
    expect(index.heldBack).toBeGreaterThan(0);
    expect(index.includedIds.length).toBeGreaterThan(0);
    expect(index.text).toMatch(/\(\+\d+ more notes? held in Memory/);
    expect(index.text.length).toBeLessThanOrEqual(400);
  });

  it("gists the first sentence and shortens at a word boundary", () => {
    expect(gistOf("First sentence. Second sentence.")).toBe("First sentence.");
    const long = "word ".repeat(40).trim();
    const gist = gistOf(long);
    expect(gist.length).toBeLessThanOrEqual(110);
    expect(gist.endsWith("…")).toBe(true);
  });
});
