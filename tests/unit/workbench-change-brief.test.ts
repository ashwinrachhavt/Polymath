// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CAPTURE_DISCLOSURE, RATIONALE_INFERRED, type ChangeBriefData } from "@/domains/agents/change-brief";
import { ChangeBriefPanel } from "@/components/polymath/workbench/change-brief-panel";

/*
 * Panel rendering: every section states its evidence tier, absences are
 * stated as absences, and the disclosure line is unconditional.
 *
 * value: protects=the brief's honesty contract on the rendered surface;
 * fails_when=a section renders a claim without its tier mark, an absence
 * renders as if data existed, or the disclosure line disappears;
 * seam=the panel with a hand-built ChangeBriefData (full, and sparse);
 * no_claim=the SQL that loads the data (integration) or capture itself.
 */

afterEach(cleanup);

function brief(over: Partial<ChangeBriefData>): ChangeBriefData {
  return {
    checkpoint: {
      id: "6557a1d2-0000-4000-8000-000000000001",
      repoUrl: "https://github.com/acme/app",
      baseCommitSha: "aaaaaaaaaaa00000000000000000000000000000a",
      commitSha: "bbbbbbbbbbb00000000000000000000000000000b",
      decisionNote: null,
      decisionStatus: "inferred",
      capturedAt: new Date("2026-11-02T00:00:00.000Z"),
    },
    project: null,
    areas: [{ area: "Other", paths: ["app.ts"] }],
    behavior: { added: [], removed: [], modified: ["app.ts"] },
    tests: null,
    diffText: "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-export const value = 'before';\n+export const value = 'after';\n",
    diffUnavailableReason: null,
    decisionLine: RATIONALE_INFERRED,
    tierCounts: { grounded: 3, inferred: 1, hypothesis: 0 },
    ...over,
  };
}

function renderBrief(data: ChangeBriefData) {
  return render(createElement(ChangeBriefPanel, { brief: data }));
}

function sectionText(container: HTMLElement, label: string): string {
  const heading = Array.from(container.querySelectorAll("h3")).find((n) => n.textContent === label);
  expect(heading, `${label} section missing`).toBeDefined();
  return heading!.parentElement!.textContent ?? "";
}

describe("change brief panel", () => {
  it("renders the full brief: outcome, areas, behavior, tests, decision", () => {
    const full = brief({
      checkpoint: {
        ...brief({}).checkpoint,
        decisionStatus: "recorded",
        decisionNote: "Ship behind the feature flag.",
      },
      project: { name: "Checkout rework", intendedOutcome: "Checkout completes without a second confirmation step." },
      tests: [
        { name: "checkout skips confirmation", ok: true, runAt: "2026-11-02T00:00:00.000Z" },
        { name: "checkout recalculates tax", ok: false, runAt: "2026-11-02T00:00:00.000Z" },
      ],
      decisionLine: "Decision recorded: ship behind the feature flag.",
    });
    const text = renderBrief(full).container.textContent ?? "";

    expect(text).toContain("Checkout completes without a second confirmation step.");
    expect(text).toContain("from project “Checkout rework”");
    expect(text).toContain("Other");
    expect(text).toContain("0 added · 0 removed · 1 modified in place");
    expect(text).toContain("1 passed · 1 failed");
    expect(text).toContain("checkout recalculates tax");
    expect(text).toContain("Decision recorded: ship behind the feature flag.");
    expect(text).toContain(CAPTURE_DISCLOSURE);
  });

  it("marks each section with the tier its claim stands on", () => {
    const full = brief({
      checkpoint: { ...brief({}).checkpoint, decisionStatus: "recorded", decisionNote: "note" },
      project: { name: "P", intendedOutcome: "outcome" },
      tests: [{ name: "t1", ok: true, runAt: "2026-11-02T00:00:00.000Z" }],
      decisionLine: "recorded note",
    });
    const { container } = renderBrief(full);
    expect(sectionText(container, "Requested outcome")).toContain("recorded");
    expect(sectionText(container, "Affected areas")).toContain("observed");
    expect(sectionText(container, "Behavior")).toContain("observed");
    expect(sectionText(container, "Tests")).toContain("verified");
    expect(sectionText(container, "Diff")).toContain("observed");
    expect(sectionText(container, "Decision")).toContain("recorded");
  });

  it("renders the inferred decision fallback verbatim with an inferred mark", () => {
    const { container } = renderBrief(brief({}));
    expect(container.textContent ?? "").toContain(RATIONALE_INFERRED);
    expect(sectionText(container, "Decision").toLowerCase()).toContain("inferred");
  });

  it("states absences as absences", () => {
    const { container } = renderBrief(brief({}));
    const text = container.textContent ?? "";
    expect(text).toContain("No project is linked to this run");
    expect(text).toContain("None provided");
    expect(text).toContain("Unchecked failures, if any, are unknown");
    // A missing outcome must not wear the recorded tier.
    expect(sectionText(container, "Requested outcome").toLowerCase()).not.toContain("recorded");
  });

  it("disclaims display truncation because the checkpoint holds the complete diff", () => {
    const { container } = renderBrief(brief({ diffText: "+ x\n".repeat(700) }));
    const text = container.textContent ?? "";
    expect(text).toContain("Display truncated at 600 of 700 lines");
    expect(text).toContain("The stored checkpoint holds the complete diff");
  });

  it("shows the evidence counts and the disclosure line on every render", () => {
    const { container } = renderBrief(brief({}));
    expect((container.textContent ?? "").replace(/\s+/g, " ")).toContain("3 grounded · 1 inferred · 0 hypotheses");
    expect(container.textContent).toContain(CAPTURE_DISCLOSURE);
  });
});
