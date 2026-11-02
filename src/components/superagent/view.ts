/**
 * The panel's pure view over the core aggregates: the ported stage table
 * (docs/003, first matching row wins) turned into the words the panel shows,
 * and the grouping every count reads from.
 *
 * Count honesty is structural here, not a convention: the Overview renders
 * `group.tickets.length` beside a link to the Tickets view filtered by the
 * same group key, and that view renders the same `TicketView[]` this module
 * produced. One classification, two surfaces, one number.
 */
import { latestReport, type Mandate, type Ticket, type Strength } from "@/domains/superagent/core/model";
import { ticketStage, type TicketStage } from "@/domains/superagent/core/stage";

/** The panel's one-per-stage keys, in the stage table's own order (first matching row wins). */
export type StageKey =
  | "person-delivery"
  | "person-answer"
  | "person-review"
  | "person-blocked"
  | "person-failed"
  | "working-queued"
  | "working"
  | "idle"
  | "ended";

/** The stage table, ported as the panel's vocabulary (spec §5). */
export const STAGE_META: Readonly<Record<StageKey, { label: string; waitingOn: "person" | "system" }>> = {
  "person-delivery": { label: "Delivery failing", waitingOn: "person" },
  "person-answer": { label: "Question for you", waitingOn: "person" },
  "person-review": { label: "Ready for review", waitingOn: "person" },
  "person-blocked": { label: "Blocked", waitingOn: "person" },
  "person-failed": { label: "Failed", waitingOn: "person" },
  "working-queued": { label: "Queued", waitingOn: "system" },
  working: { label: "Working", waitingOn: "system" },
  idle: { label: "Idle", waitingOn: "person" },
  ended: { label: "Ended", waitingOn: "system" },
};

export const STAGE_ORDER: readonly StageKey[] = [
  "person-delivery",
  "person-answer",
  "person-review",
  "person-blocked",
  "person-failed",
  "working-queued",
  "working",
  "idle",
  "ended",
];

export const isStageKey = (value: string): value is StageKey => Object.hasOwn(STAGE_META, value);

/** The stage table's key for one classification; exhaustive over the core union. */
export function stageKeyOf(stage: TicketStage): StageKey {
  switch (stage.stage) {
    case "person":
      return `person-${stage.action}`;
    case "working":
      return stage.action === "queued" ? "working-queued" : "working";
    case "idle":
      return "idle";
    case "ended":
      return "ended";
  }
}

/** What a ticket shows in a list row, all derived from the aggregate. */
export type TicketView = {
  id: string;
  title: string;
  stageKey: StageKey;
  strength: Strength;
  updatedAt: string;
  /** The latest report's summary, when the ticket made one. */
  reportSummary: string | null;
  /** What the ticket is authorized to do, as the drill-down reads it. */
  procedure: string;
};

/** One stage's slice of the tickets, with the label and waiting-on the panel shows. */
export type StageGroup = {
  key: StageKey;
  label: string;
  waitingOn: "person" | "system";
  tickets: TicketView[];
};

/** The drill-down's procedure text: what the mandate authorizes and under what basis. */
export function mandateProcedure(mandate: Mandate): string {
  const basis = mandate.basis;
  const addressed = "addressed" in basis && basis.addressed ? `, addressed by ${basis.addressed}` : "";
  const observation = "observation" in basis && basis.observation ? ` under ${basis.observation.mode} mode` : "";
  let admitted: string;
  switch (basis.via) {
    case "addressed":
      admitted = `a listed sender addressing the agent${addressed}`;
      break;
    case "followup":
      admitted = "a message on a WorkThread the ticket subscribes to";
      break;
    case "admission":
      admitted = `the receiving scope's ${basis.cell} cell${observation}`;
      break;
    case "listed":
      admitted = `a listed sender${addressed}${observation}`;
      break;
    case "bot":
      admitted = `a listed bot's message${addressed}, an inferred candidate at most`;
      break;
    default: {
      const _exhaustive: never = basis;
      admitted = String(_exhaustive);
    }
  }
  return [
    `Scope: ${mandate.scope}`,
    `Authorized by ${admitted}.`,
    `Strength: ${mandate.strength}. Policy ${mandate.policyVersion.slice(0, 12)}.`,
  ].join("\n");
}

function toView(ticket: Ticket): TicketView {
  const stage = ticketStage(ticket);
  return {
    id: ticket.id,
    title: ticket.title,
    stageKey: stageKeyOf(stage),
    strength: ticket.mandate.strength,
    updatedAt: ticket.updatedAt,
    reportSummary: latestReport(ticket)?.summary ?? null,
    procedure: mandateProcedure(ticket.mandate),
  };
}

/**
 * Classifies tickets into stage groups in the stage table's order; tickets
 * keep the newest-first order their caller gave them. Ended tickets group
 * last so the live stages read first.
 */
export function superviseTickets(tickets: Ticket[]): StageGroup[] {
  const byKey = new Map<StageKey, TicketView[]>();
  for (const ticket of tickets) {
    const view = toView(ticket);
    const list = byKey.get(view.stageKey) ?? [];
    list.push(view);
    byKey.set(view.stageKey, list);
  }
  return STAGE_ORDER.flatMap((key) => (byKey.has(key) ? [{ key, ...STAGE_META[key], tickets: byKey.get(key)! }] : []));
}
