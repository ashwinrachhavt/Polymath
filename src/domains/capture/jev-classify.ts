/*
 * The capture triage truth table (ASH-272): pure decision code that turns
 * one bundled Jev judgment set into capture_proposals rows. Judgments from
 * Jev, decisions in code - every threshold lives here, never in question
 * wording, and the rationale string is built from the judgments themselves
 * ("commitment 0.86; domain finance") so the inbox shows why and how sure.
 *
 * Deviation from the ticket's truth table, reported per its rule 4: the
 * project Noul answers yes/no only - it cannot NAME the project, so a
 * projectId cannot be "resolved by code from the named project". v1 records
 * `projectHint: true` in the payload instead; naming the project needs a
 * future Choice question over the workspace's projects.
 */

export const TRIAGE_YES = 0.7;
export const TRIAGE_NO = 0.3;
export const PROJECT_YES = 0.8;
export const DOMAIN_MIN_TOP_PROBABILITY = 0.5;

export type CaptureTriageAnswers = {
  commitment: number;
  contact: number;
  reference: number;
  worthless: number;
  project: number;
  /** The domain Choice answer; null when the adapter could not ask it. */
  domain: { choice: string; topProbability: number } | null;
};

export type CaptureTriageProposal = {
  kind: "task" | "contact" | "note" | "discard";
  payload: Record<string, unknown>;
  rationale: string;
  /** The gating probability as reported, or "low" for the review-band fallback. */
  confidence: string;
};

export type CaptureTriage = {
  proposals: CaptureTriageProposal[];
  /** The L1 taxonomy slug, or null when the Choice was weak or absent - never an invented label. */
  domainSlug: string | null;
};

const pct = (p: number) => p.toFixed(2);
const inBand = (p: number) => p > TRIAGE_NO && p < TRIAGE_YES;

export function triageCapture(answers: CaptureTriageAnswers): CaptureTriage {
  const domainSlug =
    answers.domain && answers.domain.topProbability >= DOMAIN_MIN_TOP_PROBABILITY
      ? answers.domain.choice
      : null;
  const domainNote = domainSlug ? `; domain ${domainSlug}` : "";
  const gating = (judgment: string, p: number) => `${judgment} ${pct(p)}${domainNote}`;

  let proposal: CaptureTriageProposal;
  if (answers.commitment >= TRIAGE_YES) {
    const projectHint = answers.project >= PROJECT_YES;
    proposal = {
      kind: "task",
      payload: projectHint ? { projectHint: true } : {},
      rationale: gating("commitment", answers.commitment) + (projectHint ? `; project ${pct(answers.project)}` : ""),
      confidence: pct(answers.commitment),
    };
  } else if (answers.contact >= TRIAGE_YES) {
    proposal = {
      kind: "contact",
      payload: {},
      rationale: gating("contact", answers.contact),
      confidence: pct(answers.contact),
    };
  } else if (answers.worthless >= TRIAGE_YES) {
    // Never an auto-discard: a proposal the owner confirms.
    proposal = {
      kind: "discard",
      payload: {},
      rationale: gating("worthless", answers.worthless),
      confidence: pct(answers.worthless),
    };
  } else if (answers.project >= PROJECT_YES) {
    proposal = {
      kind: "note",
      payload: { projectHint: true },
      rationale: `project ${pct(answers.project)}${domainNote}`,
      confidence: pct(answers.project),
    };
  } else if (answers.reference >= TRIAGE_YES) {
    proposal = {
      kind: "note",
      payload: {},
      rationale: gating("reference", answers.reference),
      confidence: pct(answers.reference),
    };
  } else {
    // Every judgment said no, or something sat in the 0.3-0.7 review band:
    // file as a note flagged for review, never an auto-applied label.
    const banded = [answers.commitment, answers.contact, answers.reference, answers.worthless, answers.project]
      .some(inBand);
    proposal = {
      kind: "note",
      payload: { review: true },
      rationale: banded
        ? `uncertain (commitment ${pct(answers.commitment)}, contact ${pct(answers.contact)}, reference ${pct(answers.reference)}, worthless ${pct(answers.worthless)})${domainNote}`
        : `no judgment cleared ${pct(TRIAGE_YES)}${domainNote}`,
      confidence: "low",
    };
  }
  return { proposals: [proposal], domainSlug };
}
