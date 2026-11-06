import type { JevChoiceQuestion, JevNoulQuestion } from "./client";

/*
 * The one home for every Jev question Polymath asks (vendor rule: question
 * wording, option names, and criteria live in a single auditable module).
 * JEV_QUESTIONS_VERSION stamps which wording a classification used - bump it
 * whenever any wording, option, or criterion below changes.
 *
 * Design rules (vendor guidance + ASH-272 spec): one judgment per question,
 * never an "or"-joined condition; criteria describe the confusable case;
 * every Choice is paired with a null-case Noul so "nothing fits" is a
 * probability, not a forced pick. Thresholds live in code (the classifier's
 * truth table), never in the wording.
 */

export const JEV_QUESTIONS_VERSION = "jev-q2";

/* ---- Capture classification (enrichment Tier 2) ---- */

/** The domain Choice's options are the seeded L1 taxonomy slugs; descriptions are the seed's selection criteria. */
function captureDomainQuestion(
  domains: ReadonlyArray<{ slug: string; description: string | null }>,
): JevChoiceQuestion {
  return {
    type: "choice",
    instructions: "Which knowledge domain does this capture belong to? Answer only when one option clearly fits.",
    criteria: Object.fromEntries(domains.map((d) => [d.slug, d.description ?? null])),
  };
}

/** The bundled capture question set: the domain classification, in one paid request. */
export function captureQuestions(
  domains: ReadonlyArray<{ slug: string; description: string | null }>,
): Record<string, import("./client").JevQuestion> {
  return {
    domain: captureDomainQuestion(domains),
  };
}

/* ---- Document classification (extraction dual proposer) ---- */

function documentTypeQuestion(documentTypes: readonly string[]): JevChoiceQuestion {
  return {
    type: "choice",
    instructions: "What kind of document is this? Answer only when one option clearly fits.",
    criteria: Object.fromEntries(documentTypes.map((t) => [t, null])),
  };
}

const DOCUMENT_TYPE_FITS: JevNoulQuestion = {
  type: "noul",
  instructions: "Is this document any of the listed business document types at all?",
  criteria: {
    true: "It really is one of the listed types (an invoice, receipt, agreement, resume, statement, letter, report, or form).",
    false: "Something else entirely - a note, an article, a manual - where any listed type would be a forced fit.",
  },
};

export function documentQuestions(documentTypes: readonly string[]): Record<string, import("./client").JevQuestion> {
  return { docType: documentTypeQuestion(documentTypes), docTypeFits: DOCUMENT_TYPE_FITS };
}
