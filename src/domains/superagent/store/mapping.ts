/**
 * Pure mappers between the core aggregates and the store's rows.
 *
 * Timestamps are ISO strings on the aggregates and timestamptz columns here:
 * Dates going in, `toISOString` coming out. Nested domain documents (refs,
 * actors, mandates, bases, inputs, dispositions) ride in jsonb untouched —
 * Postgres never interprets them. No I/O, so the mappers unit-test in
 * milliseconds and the repositories stay thin.
 */
import type {
  Assessment,
  Decision,
  Follow,
  Mandate,
  Ticket,
  TicketEndBy,
  TicketOutcome,
  TicketRun,
  TicketRunState,
  Trigger,
  WorkThread,
} from "../core/model";
import type { Reason } from "../core/reasons";
import { latestRun } from "../core/model";
import type {
  TicketRunRow,
  WorkDecisionRow,
  WorkSubscriptionRow,
  WorkThreadRow,
  WorkTicketRow,
  WorkTriggerRow,
} from "./schema";

const toIso = (value: Date | null | undefined): string | undefined => value?.toISOString();
const fromDate = (value: string | undefined): Date | null => (value === undefined ? null : new Date(value));

/** Drops keys whose value is undefined, so a round trip keeps the aggregate's shape. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/* ------------------------------------------------------------------ */
/* Triggers                                                            */
/* ------------------------------------------------------------------ */

export function rowToTrigger(row: WorkTriggerRow): Trigger {
  return defined({
    id: row.id,
    source: row.source,
    threads: row.threads,
    actor: row.actor,
    human: row.human,
    addressed: (row.addressed as Trigger["addressed"]) ?? undefined,
    at: toIso(row.at)!,
    text: row.text,
    channel: row.channel ?? undefined,
    url: row.url ?? undefined,
    meta: row.meta,
  });
}

/* ------------------------------------------------------------------ */
/* WorkThreads                                                         */
/* ------------------------------------------------------------------ */

export type ThreadSubscriptionRow = Pick<WorkSubscriptionRow, "ticketId" | "kind">;

/** Folds a thread row and its subscription projection back into the aggregate. */
export function rowToThread(row: WorkThreadRow, subscriptions: ThreadSubscriptionRow[]): WorkThread {
  const subscribed = subscriptions.filter((item) => item.kind === "subscription").map((item) => item.ticketId);
  const context = subscriptions.filter((item) => item.kind === "context").map((item) => item.ticketId);
  return defined({
    key: row.key,
    ref: row.ref,
    createdAt: toIso(row.createdAt)!,
    lastAt: toIso(row.lastAt),
    subscriptions: subscribed,
    // An empty projection and an absent context are the same state to every
    // reader (`context?.includes(...)`), so the store normalizes both to absent.
    context: context.length > 0 ? context : undefined,
    correlated: row.correlated,
    pending: row.pending,
    evaluating: row.evaluating ?? undefined,
    expired: row.expired ?? undefined,
    meta: row.meta,
  });
}

/* ------------------------------------------------------------------ */
/* Assessments (the evaluating mirror)                                 */
/* ------------------------------------------------------------------ */

export function assessmentColumns(assessment: Assessment): {
  id: string;
  threadKey: string;
  triggerIds: string[];
  primaryTriggerId: string | null;
  strength: string;
  actor: Assessment["actor"];
  basis: Assessment["basis"];
  policyVersion: string;
  startedAt: Date;
  deadline: Date;
  deliveredAt: Date | null;
  pausedAt: Date | null;
} {
  return {
    id: assessment.id,
    threadKey: assessment.threadKey,
    triggerIds: assessment.triggerIds,
    primaryTriggerId: assessment.primary ?? null,
    strength: assessment.strength,
    actor: assessment.actor,
    basis: assessment.basis,
    policyVersion: assessment.policyVersion,
    startedAt: new Date(assessment.startedAt),
    deadline: new Date(assessment.deadline),
    deliveredAt: fromDate(assessment.delivered),
    pausedAt: fromDate(assessment.pausedAt),
  };
}

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

export function rowToDecision(row: WorkDecisionRow): Decision {
  return defined({
    id: row.id,
    assessmentId: row.assessmentId,
    threadKey: row.threadKey,
    triggerIds: row.triggerIds,
    policyVersion: row.policyVersion,
    at: toIso(row.at)!,
    kind: row.kind as Decision["kind"],
    reason: row.reason as Reason[],
    strength: row.strength as Decision["strength"],
    ticketId: row.ticketId ?? undefined,
    mandate: (row.mandate as Mandate | null) ?? undefined,
    audit: row.audit ?? undefined,
    dismissed: row.dismissed || undefined,
  });
}

/* ------------------------------------------------------------------ */
/* Tickets and their runs                                              */
/* ------------------------------------------------------------------ */

function rowToTicketRun(row: TicketRunRow): TicketRun {
  return defined({
    id: row.id,
    state: row.state as TicketRun["state"],
    createdAt: toIso(row.createdAt)!,
    startedAt: toIso(row.startedAt),
    endedAt: toIso(row.endedAt),
    endedReason: row.endedReason ?? undefined,
    report: row.report ?? undefined,
    deliveredAt: toIso(row.deliveredAt),
    idleAt: toIso(row.idleAt),
  });
}

/** Folds a ticket row and its run rows (ordered oldest first) back into the aggregate. */
export function rowToTicket(row: WorkTicketRow, runs: TicketRunRow[]): Ticket {
  return defined({
    id: row.id,
    title: row.title,
    decisionId: row.decisionId,
    mandate: row.mandate,
    channels: row.channels,
    ended:
      row.endedAt === null
        ? undefined
        : {
            at: toIso(row.endedAt)!,
            by: row.endedBy as TicketEndBy,
            outcome: row.endedOutcome as TicketOutcome,
            reason: row.endedReason ?? undefined,
          },
    attention: row.attention ?? undefined,
    runs: runs.map(rowToTicketRun),
    inputs: row.inputs,
    undelivered: row.undelivered,
    follows: (row.follows as Follow[] | null) ?? undefined,
    answers: row.answers ?? undefined,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
    origin: row.origin,
    execution: row.execution ?? undefined,
    delivery: row.delivery ?? undefined,
  });
}

/** The latest run's state — what the work_tickets.is_active generated column reads. */
export const latestRunState = (ticket: Ticket): TicketRunState | null => latestRun(ticket)?.state ?? null;
