import { describe, expect, it } from "vitest";
import {
  deriveBrokenLinks,
  findingDedupeKey,
  nextStatus,
  TidyTransitionError,
  type TidyEvent,
  type TidyKind,
  type TidyStatus,
} from "@/domains/knowledge/tidy";
import { parseIdeaVerdict } from "@/integrations/zettels/extractor";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const DOC = "00000000-0000-4000-8000-0000000000d0";

describe("parseIdeaVerdict", () => {
  it("reads same and distinct with no reason", () => {
    expect(parseIdeaVerdict('{"verdict":"same"}')).toEqual({ verdict: "same" });
    expect(parseIdeaVerdict('{"verdict":"distinct","reason":"ignored"}')).toEqual({ verdict: "distinct" });
  });

  it("keeps a contradiction's reason, trimmed and bounded", () => {
    expect(parseIdeaVerdict('{"verdict":"contradicts","reason":"  One says daily, one weekly. "}')).toEqual({
      verdict: "contradicts",
      reason: "One says daily, one weekly.",
    });
    const long = parseIdeaVerdict(JSON.stringify({ verdict: "contradicts", reason: "x".repeat(1000) }));
    expect(long.verdict === "contradicts" && long.reason.length).toBe(300);
  });

  it("refuses a contradiction without a reason, an unknown verdict, and non-JSON", () => {
    expect(() => parseIdeaVerdict('{"verdict":"contradicts"}')).toThrow("unreadable");
    expect(() => parseIdeaVerdict('{"verdict":"contradicts","reason":"   "}')).toThrow("unreadable");
    expect(() => parseIdeaVerdict('{"sameIdea":true}')).toThrow("unreadable");
    expect(() => parseIdeaVerdict("same")).toThrow("unreadable");
  });
});

describe("findingDedupeKey", () => {
  it("gives a pair one key whichever order or kind it was judged in", () => {
    const disagreement = findingDedupeKey({ kind: "disagreement", subjectId: A, otherId: B, detail: { reason: "r" } });
    const reversed = findingDedupeKey({ kind: "disagreement", subjectId: B, otherId: A, detail: { reason: "r" } });
    const duplicate = findingDedupeKey({ kind: "duplicate", subjectId: B, otherId: A, detail: { distance: 0.01 } });
    expect(disagreement).toBe(`pair:${A}:${B}`);
    expect(reversed).toBe(disagreement);
    expect(duplicate).toBe(disagreement);
  });

  it("keys single-subject kinds by subject and what makes them distinct", () => {
    expect(findingDedupeKey({ kind: "unlinked", subjectId: A, otherId: null, detail: {} })).toBe(`unlinked:${A}`);
    expect(
      findingDedupeKey({
        kind: "source_changed",
        subjectId: A,
        otherId: null,
        detail: { documentId: DOC, cause: "archived" },
      }),
    ).toBe(
      findingDedupeKey({
        kind: "source_changed",
        subjectId: A,
        otherId: null,
        detail: { documentId: DOC, cause: "re_read" },
      }),
    );
    expect(
      findingDedupeKey({ kind: "broken_link", subjectId: A, otherId: null, detail: { linkTitle: " Rent Timing " } }),
    ).toBe(`broken_link:${A}:rent timing`);
  });
});

describe("nextStatus", () => {
  const legal: Array<[TidyKind, TidyStatus, TidyEvent, TidyStatus]> = [
    ["disagreement", "open", "resolve", "resolved"],
    ["disagreement", "open", "dismiss", "dismissed"],
    ["duplicate", "open", "dismiss", "dismissed"],
    ["unlinked", "open", "clear", "cleared"],
    ["broken_link", "cleared", "reopen", "open"],
    ["source_changed", "open", "dismiss", "dismissed"],
  ];
  it.each(legal)("%s: %s --%s--> %s", (kind, status, event, to) => {
    expect(nextStatus({ kind, status }, event)).toBe(to);
  });

  const illegal: Array<[TidyKind, TidyStatus, TidyEvent]> = [
    ["disagreement", "resolved", "dismiss"],
    ["disagreement", "dismissed", "resolve"],
    ["unlinked", "dismissed", "reopen"],
    ["unlinked", "resolved", "reopen"],
    ["unlinked", "open", "reopen"],
    ["unlinked", "cleared", "dismiss"],
    ["unlinked", "open", "resolve"],
    ["duplicate", "open", "resolve"],
    ["disagreement", "open", "clear"],
    ["duplicate", "cleared", "reopen"],
  ];
  it.each(illegal)("%s: %s refuses %s", (kind, status, event) => {
    expect(() => nextStatus({ kind, status }, event)).toThrow(TidyTransitionError);
  });
});

describe("deriveBrokenLinks", () => {
  it("flags only titles no live note or idea carries, case-insensitively", () => {
    const found = deriveBrokenLinks(
      [
        { subjectId: A, titles: ["Rent timing", "Missing idea"] },
        { subjectId: B, titles: ["RENT TIMING"] },
      ],
      new Set(["rent timing"]),
    );
    expect(found).toEqual([
      { kind: "broken_link", subjectId: A, otherId: null, detail: { linkTitle: "Missing idea" } },
    ]);
  });
});
