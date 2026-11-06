import { describe, expect, it, vi } from "vitest";

// generate.ts opens the pool through @/lib/db at import time; the pure pieces
// under test here never query, so both handles are stubs.
vi.mock("@/lib/db", () => ({ db: {} }));

import {
  composeFactSuggestionPrompt,
  FACT_SUGGESTION_SYSTEM,
  FACT_SUGGESTION_TOPIC,
  normalizeFactKey,
  parseSuggestions,
  validateCandidates,
  type FactCandidate,
} from "@/domains/facts/generate";
import { pollFacts, selectFactPool } from "@/lib/poll-facts";

function candidate(overrides: Partial<FactCandidate> = {}): FactCandidate {
  return {
    topic: "science",
    text: "Sound travels about five seconds per kilometer in air, so counting after a lightning strike measures the storm's distance.",
    tags: ["sound", "motion"],
    ...overrides,
  };
}

describe("parseSuggestions", () => {
  it("parses a plain JSON array and trims text and tags", () => {
    const raw = JSON.stringify([
      { topic: "science", text: "  A fact here.  ", tags: [" TIME ", "scale"] },
      { topic: "philosophy", text: "Another one.", tags: ["mind"] },
    ]);
    const parsed = parseSuggestions(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ topic: "science", text: "A fact here.", tags: ["time", "scale"] });
  });

  it("strips markdown fences around the array", () => {
    const raw = "```json\n" + JSON.stringify([{ topic: "science", text: "A fact.", tags: [] }]) + "\n```";
    expect(parseSuggestions(raw)).toHaveLength(1);
  });

  it("recovers the array from prose around it", () => {
    const raw = 'Here you go:\n[{"topic":"science","text":"A fact.","tags":["math"]}] — hope these help!';
    expect(parseSuggestions(raw)).toHaveLength(1);
  });

  it("skips entries with wrong shapes instead of throwing", () => {
    const raw = JSON.stringify([
      null,
      42,
      { topic: "history", text: "Not a topic.", tags: [] },
      { topic: "science", text: 7, tags: [] },
      { topic: "science", text: "Valid.", tags: "not-an-array" },
      { topic: "science", text: "Valid.", tags: ["ok", 3] },
      { topic: "philosophy", text: "Valid.", tags: ["mind"] },
    ]);
    expect(parseSuggestions(raw)).toEqual([{ topic: "philosophy", text: "Valid.", tags: ["mind"] }]);
  });

  it("returns empty for no array, malformed JSON, or an empty reply", () => {
    expect(parseSuggestions("no json at all")).toEqual([]);
    expect(parseSuggestions("[{broken")).toEqual([]);
    expect(parseSuggestions('{"topic":"science"}')).toEqual([]);
    expect(parseSuggestions("")).toEqual([]);
  });
});

describe("validateCandidates", () => {
  const deckText = pollFacts.map((fact) => fact.text);

  it("keeps a good candidate", () => {
    const [kept] = validateCandidates({ candidates: [candidate()], deck: deckText, existing: new Set() });
    expect(kept?.text).toBe(candidate().text);
  });

  it("rejects lengths outside 80-260 and any exclamation mark", () => {
    const short = candidate({ text: "Too short." });
    const long = candidate({ text: "A".repeat(261) });
    const excited = candidate({ text: candidate().text.slice(0, 200) + "!" });
    const out = validateCandidates({ candidates: [short, long, excited], deck: deckText, existing: new Set() });
    expect(out).toEqual([]);
  });

  it("rejects anything overlapping the deck, case-insensitively, in either direction", () => {
    const exact = candidate({ text: pollFacts[0].text });
    const caseShifted = candidate({ text: pollFacts[0].text.toUpperCase() });
    // Deck line embedded inside a longer candidate: key contains the deck key.
    const wrapped = candidate({ text: `A framing thought first. ${pollFacts[5].text}` });
    const out = validateCandidates({ candidates: [exact, caseShifted, wrapped], deck: deckText, existing: new Set() });
    expect(out).toEqual([]);
  });

  it("rejects duplicates against existing keys and within the batch", () => {
    const text = candidate().text;
    const existing = new Set([normalizeFactKey(text)]);
    expect(validateCandidates({ candidates: [candidate()], deck: deckText, existing })).toEqual([]);
    const twice = validateCandidates({ candidates: [candidate(), candidate()], deck: deckText, existing: new Set() });
    expect(twice).toHaveLength(1);
  });

  it("caps inserts at 8 per run", () => {
    const texts = Array.from(
      { length: 11 },
      (_, i) => `Fact number ${i}: ${"A".repeat(120)} ${i * 7} meters, measured.`,
    );
    const candidates = texts.map((text) => candidate({ text }));
    const out = validateCandidates({ candidates, deck: deckText, existing: new Set() });
    expect(out).toHaveLength(8);
  });
});

describe("the prompt contract", () => {
  it("demands the split, the JSON shape, and the bans the validation enforces", () => {
    const system = FACT_SUGGESTION_SYSTEM;
    expect(system).toContain("4 science and 4 philosophy");
    expect(system).toContain("JSON array");
    expect(system.toLowerCase()).toContain("exclamation");
    expect(system.toLowerCase()).toContain("did you know");
    expect(system.toLowerCase()).toContain("productivity");
    expect(system).toContain("80 to 260 characters");
  });

  it("embeds deck facts as few-shot and as a rejection surface", () => {
    const prompt = composeFactSuggestionPrompt(
      [pollFacts[0].text],
      pollFacts.map((f) => f.text),
    );
    expect(prompt).toContain(pollFacts[0].text);
    expect(prompt.split(pollFacts[3].text).length).toBeGreaterThan(1);
  });

  it("registers under exactly one outbox topic", () => {
    expect(FACT_SUGGESTION_TOPIC).toBe("facts.suggestions_requested");
  });
});

describe("selectFactPool with extras", () => {
  const extra = [
    { id: "s1", kind: "science" as const, tags: ["time"], text: "An extra fact about time." },
    { id: "s2", kind: "philosophy" as const, tags: ["mind"], text: "An extra fact about the mind." },
  ];

  it("joins extras into the fallback deck", () => {
    const pool = selectFactPool([], extra);
    expect(pool).toHaveLength(pollFacts.length + 2);
    expect(pool.some((fact) => fact.id === "s1")).toBe(true);
  });

  it("lets a tagged extra widen the preferred pool", () => {
    // "time" alone in the curated deck yields a deep enough match already; add
    // a shallow topic the extras carry, and the pool should include them.
    const pool = selectFactPool(["time", "mind"], extra);
    expect(pool.some((fact) => fact.id === "s1")).toBe(true);
    expect(pool.some((fact) => fact.id === "s2")).toBe(true);
  });

  it("stays the plain deck when extras are absent or empty", () => {
    expect(selectFactPool([], [])).toEqual(pollFacts);
    expect(selectFactPool([], undefined)).toEqual(pollFacts);
  });
});
