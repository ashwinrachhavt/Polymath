/**
 * The assessor's bounded context (spec §4): a candidate reaches the
 * assessor's session only through these bounds — trigger text of 4000 chars,
 * at most eight ticket cards, 400-char messages. Bounding is the single
 * enforcement point: the brief, the read tool, and the Decide state all
 * render the bounded view, so no path can carry an unbounded prompt into eve.
 */
import type { ActorRef, ReportState, ThreadFacts, Ticket, TicketOutcome, Trigger } from "../core/model";
import { latestReport } from "../core/model";
import type { Candidate } from "../core/ports";

export const TRIGGER_TEXT_CAP = 4000;
export const TICKET_VIEW_LIMIT = 8;
export const MESSAGE_CAP = 400;

/** Cuts text to `max` characters, marking a cut with an ellipsis. */
export function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export interface BoundedTrigger {
  id: string;
  at: string;
  actor: ActorRef;
  human: boolean;
  addressed?: "mention" | "direct";
  /** Capped at `TRIGGER_TEXT_CAP`. */
  text: string;
}

export interface BoundedTicket {
  id: string;
  title: string;
  ended: boolean;
  outcome?: TicketOutcome;
  report?: { state: ReportState; summary: string; at: string };
  /** The request that started the ticket, capped at `MESSAGE_CAP`; empty when its text is no longer stored. */
  originText: string;
}

export interface BoundedCandidate {
  assessmentId: string;
  policyVersion: string;
  strength: Candidate["strength"];
  threadKey: string;
  thread: { source: string; id: string; facts: ThreadFacts };
  triggers: BoundedTrigger[];
  tickets: BoundedTicket[];
  /** Every ticket the candidate carried, including the ones the view dropped. */
  ticketTotal: number;
  droppedTickets: number;
}

/**
 * The bounded view of a candidate: triggers with capped text, and at most
 * `TICKET_VIEW_LIMIT` ticket cards — live tickets first, newest first, so the
 * work that can still be joined survives the cut — with an honest count of
 * what was dropped.
 */
export function boundCandidate(candidate: Candidate, triggerOf: (id: string) => Trigger | undefined): BoundedCandidate {
  const byRecency = (a: Ticket, b: Ticket): number => b.createdAt.localeCompare(a.createdAt);
  const live = candidate.tickets.filter((ticket) => !ticket.ended).sort(byRecency);
  const ended = candidate.tickets.filter((ticket) => ticket.ended).sort(byRecency);
  const view = [...live, ...ended].slice(0, TICKET_VIEW_LIMIT);

  return {
    assessmentId: candidate.assessmentId,
    policyVersion: candidate.policyVersion,
    strength: candidate.strength,
    threadKey: candidate.thread.key,
    thread: {
      source: candidate.thread.ref.source,
      id: candidate.thread.ref.id,
      facts: (candidate.thread.meta.facts as ThreadFacts | undefined) ?? {},
    },
    triggers: candidate.triggers.map((trigger) => ({
      id: trigger.id,
      at: trigger.at,
      actor: trigger.actor,
      human: trigger.human,
      ...(trigger.addressed ? { addressed: trigger.addressed } : {}),
      text: capText(trigger.text, TRIGGER_TEXT_CAP),
    })),
    tickets: view.map(boundedTicketOf(triggerOf)),
    ticketTotal: candidate.tickets.length,
    droppedTickets: candidate.tickets.length - view.length,
  };
}

const boundedTicketOf =
  (triggerOf: (id: string) => Trigger | undefined) =>
  (ticket: Ticket): BoundedTicket => {
    const report = latestReport(ticket);
    return {
      id: ticket.id,
      title: ticket.title,
      ended: !!ticket.ended,
      ...(ticket.ended ? { outcome: ticket.ended.outcome } : {}),
      ...(report
        ? { report: { state: report.state, summary: capText(report.summary, MESSAGE_CAP), at: report.at } }
        : {}),
      originText: capText(triggerOf(ticket.origin.triggerId)?.text ?? "", MESSAGE_CAP),
    };
  };
