import { describe, expect, it } from "vitest";
import { DRAFT_TEMPLATES, DRAFT_TEMPLATE_KIND, DRAFT_TEMPLATE_LABEL, draftBody, draftTitle } from "@/domains/capture/draft-templates";

/*
 * ASH-285: the Linear-issue scaffold stays honest like every draft template -
 * a skeleton with bracketed slots and the source quoted verbatim, never
 * generated prose the owner must unlearn.
 */

describe("linear-issue draft template", () => {
  it("is a registered draft template with a notebook-editable kind", () => {
    expect(DRAFT_TEMPLATES).toContain("linear-issue");
    expect(DRAFT_TEMPLATE_LABEL["linear-issue"]).toBe("Linear issue");
    expect(DRAFT_TEMPLATE_KIND["linear-issue"]).toBe("note");
  });

  it("carries the issue shape: problem, proposal, acceptance criteria, out of scope", () => {
    const body = draftBody("linear-issue", { firstLine: "Backfill the missing journals", material: "The audit found gaps." });
    expect(body).toContain("# Backfill the missing journals");
    expect(body).toContain("## Problem");
    expect(body).toContain("## Proposal");
    expect(body).toContain("## Acceptance criteria");
    expect(body).toContain("- [ ]");
    expect(body).toContain("## Out of scope");
  });

  it("quotes the source verbatim so every criterion traces back", () => {
    const body = draftBody("linear-issue", { firstLine: "T", material: "Line one\nLine two" });
    expect(body).toContain("> Line one\n> Line two");
    expect(body).toContain("Starter draft from a capture");
  });

  it("titles like every other draft", () => {
    expect(draftTitle("linear-issue", "Backfill journals")).toBe("Linear issue: Backfill journals");
  });
});
