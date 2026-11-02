/**
 * The assessor's side of the two-judge seam: what one Mercury Decide call
 * sees, asks, and answers. The combination rule lives in
 * `../decide/record` (`resolveAssessmentDecision` — the shipped decision
 * record); this module renders the bounded, stored-meta state the call
 * evaluates, phrases the typed admit question, and maps an escalation onto
 * the domain's reason codes. Pure — no client, no store.
 */
import type { Reason } from "../core/reasons";
import type { AssessmentDecisionRecord } from "../decide/record";
import type { DecideRequest, DecideResponse, DecideState, JsonValue } from "../decide/types";
import type { BoundedCandidate } from "./bounds";

/** The key of the binary admit question the assessor asks Mercury Decide. */
export const DECIDE_ADMIT_QUESTION = "admit";

/** A JSON round-trip: stored domain values are JSON at rest, but their types say `unknown`. */
const toJsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue;

/** Pull the admit probability out of a Decide response, refusing an untyped or misshapen answer. */
export function admitProbabilityOf(response: DecideResponse): number {
  const answer = response.answers[DECIDE_ADMIT_QUESTION];
  if (!answer || answer.type !== "noul") throw new Error("the Decide response carries no binary admit answer");
  return answer.probability;
}

/**
 * The bounded, stored-meta state one Decide call evaluates. Everything in it
 * is domain state — thread facts, trigger audit cards, ticket cards, and the
 * capped message texts — so a calibration reads the same state the judgment
 * read, and only what the bounds allowed into the session.
 */
export function decideState(bounded: BoundedCandidate): DecideState {
  return {
    candidate: { strength: bounded.strength, policyVersion: bounded.policyVersion },
    thread: { key: bounded.threadKey, facts: toJsonValue(bounded.thread.facts) as { [key: string]: JsonValue } },
    messages: bounded.triggers.map((trigger) => ({
      id: trigger.id,
      at: trigger.at,
      actor: `${trigger.actor.source}:${trigger.actor.id}`,
      from: trigger.human ? "person" : "automated",
      ...(trigger.addressed ? { addressed: trigger.addressed } : {}),
      text: trigger.text,
    })),
    tickets: bounded.tickets.map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      state: ticket.ended ? `ended (${ticket.outcome ?? "unknown"})` : "open",
      ...(ticket.report ? { latestReport: `${ticket.report.state} — ${ticket.report.summary}` } : {}),
      ...(ticket.originText ? { requestThatStartedIt: ticket.originText } : {}),
    })),
  };
}

/** The one typed question a calibration asks, over the bounded state. */
export function decideRequest(bounded: BoundedCandidate): DecideRequest {
  return {
    state: decideState(bounded),
    questions: {
      [DECIDE_ADMIT_QUESTION]: {
        type: "noul",
        instructions:
          "Should the agent take this candidate on as work now, judging only from this stored state? A request a ticket already covers, or work you cannot scope, is a no.",
        criteria: {
          true: "The candidate is admissible work for the agent: worth a ticket, not already covered.",
          false:
            "The candidate should not become work: not a request to the agent, already covered by a ticket, or unscopeable.",
        },
      },
    },
  };
}

/**
 * The domain reasons for a record's escalation, so the panel renders why the
 * two judges parted, with the probability and threshold that decided it.
 */
export function escalationReasonOf(record: AssessmentDecisionRecord, admitThreshold: number): Reason[] {
  const probability = record.decide?.admitProbability;
  switch (record.final.escalation) {
    case "belowThreshold":
      return [
        {
          code: "decideBelowThreshold",
          values: { probability: String(probability ?? ""), threshold: String(admitThreshold) },
        },
      ];
    case "disagreement":
      return [
        {
          code: "decideDisagreement",
          values: { probability: String(probability ?? ""), threshold: String(admitThreshold) },
        },
      ];
    default:
      return [];
  }
}
