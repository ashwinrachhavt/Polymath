import { describe, expect, it } from "vitest";
import { CAPTURE_TEMPLATES, DRAFT_TEMPLATE_KIND, DRAFT_TEMPLATES, draftBody, draftTitle } from "@/domains/knowledge/templates";

/*
 * "Turn it into anything" scaffolds: every template produces an honest
 * starter draft - named sections, bracketed slots for the owner, and the
 * capture quoted verbatim as source material the draft must stay true to.
 * The system invents no prose, so the tests pin exactly that shape. `todo` is
 * the exception by design: it starts from a phrase the owner typed, not a
 * capture, so it carries no source-material section and is never offered as a
 * capture conversion.
 *
 * Value: protects=a draft always carries its capture's words and never
 * fabricates content; fails_when=a template drops the source material,
 * invents sentences, or a title overflows; why_new=feature is new;
 * seam=pure functions; no_claim=the domain conversion transaction (covered
 * by tests/integration/capture-draft.test.ts).
 */

const material = "Launch review moved to Friday.\nBring the pricing doc.";

describe("the registry", () => {
  it("holds exactly these slugs, so no second name for one scaffold creeps back", () => {
    expect(DRAFT_TEMPLATES).toEqual(["email", "product-spec", "tech-spec", "issue", "todo"]);
  });

  it("offers every sourced template as a capture conversion, and never todo", () => {
    expect(CAPTURE_TEMPLATES).toEqual(["email", "product-spec", "tech-spec", "issue"]);
    expect(CAPTURE_TEMPLATES).not.toContain("todo");
    for (const template of DRAFT_TEMPLATES) {
      if (template !== "todo") expect(CAPTURE_TEMPLATES).toContain(template);
    }
  });
});

describe("draftBody", () => {
  it("quotes the capture verbatim in every template a capture can turn into", () => {
    for (const template of CAPTURE_TEMPLATES) {
      const body = draftBody(template, { firstLine: "Launch review moved to Friday.", material });
      expect(body).toContain("## Source material");
      expect(body).toContain("> Launch review moved to Friday.");
      expect(body).toContain("> Bring the pricing doc.");
      expect(body).toContain("nothing here was written for you");
    }
  });

  it("shapes a todo as its own task and notes, with no source material", () => {
    const body = draftBody("todo", { firstLine: "Call the dentist", material });
    expect(body).toContain("## Task");
    expect(body).toContain("Call the dentist");
    expect(body).toContain("## Notes");
    expect(body).toContain("[What done looks like.]");
    expect(body).not.toContain("## Source material");
    expect(body).not.toContain("> Launch review moved to Friday.");
    expect(body).not.toContain("nothing here was written for you");
  });

  it("shapes the email draft as To/Subject/body with owner slots", () => {
    const body = draftBody("email", { firstLine: "Launch review moved to Friday.", material });
    expect(body).toContain("**To:** [recipient]");
    expect(body).toContain("**Subject:** Launch review moved to Friday.");
  });

  it("shapes the product spec with problem/proposal/open questions", () => {
    const body = draftBody("product-spec", { firstLine: "Offline mode", material: "Offline mode" });
    expect(body).toContain("## Problem");
    expect(body).toContain("## Proposal");
    expect(body).toContain("## Open questions");
  });

  it("shapes the tech spec with context/design/risks", () => {
    const body = draftBody("tech-spec", { firstLine: "Queue retries", material: "Queue retries" });
    expect(body).toContain("## Context");
    expect(body).toContain("## Design");
    expect(body).toContain("## Risks");
  });
});

describe("draftTitle", () => {
  it("names the draft from the template and first line, truncated honestly", () => {
    expect(draftTitle("email", "Hello")).toBe("Email draft: Hello");
    const long = "x".repeat(200);
    const title = draftTitle("tech-spec", long);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("draft kinds", () => {
  it("lands every template on a kind the notebook editor opens", () => {
    for (const template of DRAFT_TEMPLATES) {
      expect(DRAFT_TEMPLATE_KIND[template]).toBe("note");
    }
  });
});
