import { describe, expect, it } from "vitest";
import {
  composeExplainer,
  diffPaths,
  verifiedParts,
  type ExplainerParts,
} from "@/domains/understanding/explainer-format";
import { deriveLevel } from "@/domains/understanding/known";

/*
 * Value: protects=an explainer never points a reader at code the diff did not
 * touch, reads in Litt's order (background, intuition, the changes as a story,
 * risks), and a concept the person already got right is not explained again;
 * fails_when=a made-up file survives as a `path:line` reference, the sections
 * come out in another order, concept names collide by letter case, or a
 * concept answered correctly last time reads as shaky; seam=the pure format
 * and level functions; no_claim=what the model writes or the database.
 */

const DIFF = [
  "diff --git a/src/queue/retry.ts b/src/queue/retry.ts",
  "index 111..222 100644",
  "--- a/src/queue/retry.ts",
  "+++ b/src/queue/retry.ts",
  "@@ -10,3 +10,5 @@ export function retry() {",
  "+  budget -= 1;",
  "diff --git a/docs/queue.md b/docs/queue.md",
  "--- a/docs/queue.md",
  "+++ b/docs/queue.md",
  "@@ -1 +1,2 @@",
  "+Retries are capped.",
].join("\n");

const PARTS: ExplainerParts = {
  title: "Cap queue retries",
  background: "The queue replays failed jobs.",
  intuition: "A job that always fails should stop costing money.",
  changes: [
    {
      title: "Spend a budget per retry",
      story: "Each retry now spends one unit of a budget.",
      refs: [
        { path: "src/queue/retry.ts", line: 11 },
        { path: "src/queue/invented.ts", line: 3 },
        { path: "docs/queue.md" },
        { path: "src/queue/retry.ts", line: -4 },
      ],
    },
  ],
  risks: ["A job that fails once, rarely, now has less room to recover."],
  concepts: ["Retry budget", "retry budget", "  Idempotent   writes ", ""],
};

describe("diffPaths", () => {
  it("names each file the diff touches by its new path", () => {
    expect([...diffPaths(DIFF)].sort()).toEqual(["docs/queue.md", "src/queue/retry.ts"]);
  });
});

describe("verifiedParts", () => {
  it("drops references the diff does not support and counts them", () => {
    const { parts, droppedRefs } = verifiedParts(PARTS, diffPaths(DIFF));
    expect(parts.changes[0].refs).toEqual([{ path: "src/queue/retry.ts", line: 11 }, { path: "docs/queue.md" }]);
    expect(droppedRefs).toBe(2);
  });

  it("stores concepts trimmed, single-spaced, deduplicated by letter case and without blanks", () => {
    expect(verifiedParts(PARTS, diffPaths(DIFF)).parts.concepts).toEqual(["Retry budget", "Idempotent writes"]);
  });
});

describe("composeExplainer", () => {
  const text = composeExplainer(verifiedParts(PARTS, diffPaths(DIFF)).parts, {
    repo: "acme/queue",
    commit: "abcdef0123456789",
    range: "main..HEAD",
  });

  it("reads background, intuition, the story, then risks and concepts", () => {
    const order = [
      "## Background",
      "## Intuition",
      "## What changed, in order",
      "## Risks and what to watch",
      "## Concepts",
    ];
    expect(order.map((heading) => text.indexOf(heading))).toEqual(
      [...order.map((heading) => text.indexOf(heading))].sort((a, b) => a - b),
    );
    expect(order.every((heading) => text.includes(heading))).toBe(true);
  });

  it("names the repository, the short commit and the range, and cites files as path:line", () => {
    expect(text).toContain("*acme/queue at abcdef0 (main..HEAD)*");
    expect(text).toContain("Where: `src/queue/retry.ts:11`, `docs/queue.md`");
    expect(text).not.toContain("invented.ts");
  });
});

describe("deriveLevel", () => {
  it("follows the most recent answer, and an unaided correct answer always counts", () => {
    expect(deriveLevel({ correct: 1, missed: 2, lastCorrect: true, unaidedCorrect: 0 })).toBe("known");
    expect(deriveLevel({ correct: 2, missed: 1, lastCorrect: false, unaidedCorrect: 0 })).toBe("shaky");
    expect(deriveLevel({ correct: 0, missed: 1, lastCorrect: false, unaidedCorrect: 1 })).toBe("known");
    expect(deriveLevel({ correct: 0, missed: 0, lastCorrect: null, unaidedCorrect: 0 })).toBe("unassessed");
  });
});
