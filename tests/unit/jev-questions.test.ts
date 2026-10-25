import { describe, expect, it } from "vitest";
import { SEED_TAXONOMY } from "@/domains/knowledge/taxonomy";
import { captureQuestions, documentQuestions, JEV_QUESTIONS_VERSION } from "@/integrations/jev/questions";

/*
 * The question-set contract (ASH-272): every question asks one judgment,
 * the domain Choice options are exactly the seeded L1 slugs, the version
 * constant exists for proposal provenance, and each Choice is paired with a
 * null-case Noul so "nothing fits" is a probability, not a forced pick.
 */

describe("jev questions", () => {
  it("exports the provenance version", () => {
    expect(JEV_QUESTIONS_VERSION).toBe("jev-q1");
  });

  it("bundles exactly the six capture judgments", () => {
    const q = captureQuestions([]);
    expect(Object.keys(q).sort()).toEqual(["commitment", "contact", "domain", "project", "reference", "worthless"]);
  });

  it("the domain Choice options are the seeded L1 taxonomy slugs", () => {
    const l1 = SEED_TAXONOMY.filter((n) => n.level === 1);
    const q = captureQuestions(l1);
    const domain = q.domain;
    expect(domain.type).toBe("choice");
    if (domain.type !== "choice") return;
    expect(Object.keys(domain.criteria)).toEqual(l1.map((n) => n.slug));
    expect(l1).toHaveLength(10);
  });

  it("the document questions pair the type Choice with the null-case Noul", () => {
    const q = documentQuestions(["invoice", "receipt"]);
    expect(q.docType.type).toBe("choice");
    expect(q.docTypeFits.type).toBe("noul");
    if (q.docType.type !== "choice") return;
    expect(Object.keys(q.docType.criteria)).toEqual(["invoice", "receipt"]);
  });

  it("every noul question asks a single yes/no judgment", () => {
    // The vendor rule (one judgment per question, no or-joined conditions)
    // is a wording-review discipline; what a test can pin is the shape:
    // exactly one question, ending in one question mark.
    const q = captureQuestions([]);
    for (const question of Object.values(q)) {
      if (question.type !== "noul") continue;
      expect(question.instructions.split("?")).toHaveLength(2);
      expect(question.criteria?.true).toBeTruthy();
      expect(question.criteria?.false).toBeTruthy();
    }
  });
});
