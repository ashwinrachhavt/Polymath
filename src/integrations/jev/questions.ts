import type { JevChoiceQuestion, JevNoulQuestion } from "./client";

/*
 * The one home for every Jev question Polymath asks (vendor rule: question
 * wording, option names, and criteria live in a single auditable module).
 * JEV_QUESTIONS_VERSION lands in capture_proposals.prompt_version, so a
 * wording change is auditable per proposal - bump it whenever any wording,
 * option, or criterion below changes.
 *
 * Design rules (vendor guidance + ASH-272 spec): one judgment per question,
 * never an "or"-joined condition; criteria describe the confusable case;
 * every Choice is paired with a null-case Noul so "nothing fits" is a
 * probability, not a forced pick. Thresholds live in code (the classifier's
 * truth table), never in the wording.
 */

export const JEV_QUESTIONS_VERSION = "jev-q2";

/* ---- Capture triage (enrichment Tier 2) ---- */

export const CAPTURE_COMMITMENT: JevNoulQuestion = {
  type: "noul",
  instructions: "Does this capture record a commitment the person owes someone - something with an implied done-by?",
  criteria: {
    true: "A task, promise, request, deadline, or follow-up the owner is expected to complete; includes requests others made of them.",
    false: "Information, ideas, or receipts with nothing for the owner to do; a commitment owed BY someone else without an owner action.",
  },
};

export const CAPTURE_CONTACT: JevNoulQuestion = {
  type: "noul",
  // Wording refined from the ticket's draft ("contact details or an
  // introduction"): the vendor rule forbids or-joined conditions, and no
  // proposal has shipped with the draft wording, so the version stays q1.
  instructions: "Is this capture's subject a specific person the owner might want to reach?",
  criteria: {
    true: "A business card, signature block, vCard, contact details, or a message whose point is introducing one person to the owner.",
    false: "A person merely mentioned in passing, an author byline, or a company rather than an individual.",
  },
};

export const CAPTURE_REFERENCE: JevNoulQuestion = {
  type: "noul",
  instructions: "Is this a reference worth filing to read later - not a commitment, not a person?",
  criteria: {
    true: "An article, paper, link, quote, or idea the owner plausibly saved for its content.",
    false: "Something actionable, a person, or noise; saving it would not serve a future read.",
  },
};

export const CAPTURE_WORTHLESS: JevNoulQuestion = {
  type: "noul",
  instructions: "Is this capture worthless - spam, duplicate noise, or an accident?",
  criteria: {
    true: "Bulk marketing, spam, a misfire, or content-free noise the owner would delete on sight.",
    false: "Anything with plausible future value, even if low; when unsure, it is not worthless.",
  },
};

export const CAPTURE_PROJECT: JevNoulQuestion = {
  type: "noul",
  instructions: "Does anything in this capture name a specific existing project of the owner's?",
  criteria: {
    true: "A proper project name or unambiguous reference to one initiative the owner is running.",
    false: "A generic topic, a company name, or a project that belongs to someone else.",
  },
};

/** The domain Choice's options are the seeded L1 taxonomy slugs; descriptions are the seed's selection criteria. */
export function captureDomainQuestion(domains: ReadonlyArray<{ slug: string; description: string | null }>): JevChoiceQuestion {
  return {
    type: "choice",
    instructions: "Which knowledge domain does this capture belong to? Answer only when one option clearly fits.",
    criteria: Object.fromEntries(domains.map((d) => [d.slug, d.description ?? null])),
  };
}

/** The bundled capture question set: every judgment the triage truth table reads, in one paid request. */
export function captureQuestions(domains: ReadonlyArray<{ slug: string; description: string | null }>): Record<string, import("./client").JevQuestion> {
  return {
    commitment: CAPTURE_COMMITMENT,
    contact: CAPTURE_CONTACT,
    reference: CAPTURE_REFERENCE,
    worthless: CAPTURE_WORTHLESS,
    project: CAPTURE_PROJECT,
    domain: captureDomainQuestion(domains),
  };
}

/* ---- Document classification (extraction dual proposer) ---- */

export function documentTypeQuestion(documentTypes: readonly string[]): JevChoiceQuestion {
  return {
    type: "choice",
    instructions: "What kind of document is this? Answer only when one option clearly fits.",
    criteria: Object.fromEntries(documentTypes.map((t) => [t, null])),
  };
}

export const DOCUMENT_TYPE_FITS: JevNoulQuestion = {
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
