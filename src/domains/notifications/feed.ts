import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { listRecentRuns } from "@/domains/agents/queries";
import { getOpenQuestion } from "@/domains/agents/run-context";
import { listWorkspaceActivity, projectSummary } from "@/domains/audit/queries";
import { listHomeQueue } from "@/domains/home/queue";
import { db } from "@/lib/db";
import { agentQuestions, agentRuns, runState } from "@/domains/agents/schema";

/*
 * What needs the owner, in one place: the decisions queue that used to be the
 * front door, the agent runs still working, and the workspace audit trail.
 *
 * Three kinds, deliberately not merged into one ranked list: a decision is a
 * blocking question, a run is work in flight, an audit row is a record of
 * something that already happened. Ranking them against each other would put
 * "created a task" above "an agent is waiting for approval". They are the
 * panel's tabs, and the badge counts what still needs action.
 */

export type NotificationKind = "decision" | "run" | "audit";

export type Notification = {
  id: string;
  kind: NotificationKind;
  /** The one line the owner reads. */
  title: string;
  /** What it means or does, when the title alone is not enough. */
  detail: string | null;
  at: Date;
  /** Where acting on it happens. */
  href: string | null;
  /** Only what still needs the owner carries a signal; history never does. */
  needsAction: boolean;
  /** Short status word, the same vocabulary the owned surface uses. */
  state: string;
  /** For a decision: what one tap binds. */
  decision?:
    | { kind: "agent"; proposalId: string; revisionId: string; version: number; expired: boolean }
    | { kind: "capture"; proposalId: string };
};

export type NotificationFeed = {
  items: Notification[];
  /** Per kind, so a tab can show its own count without re-reading. */
  counts: Record<NotificationKind, number>;
  /** Decisions + runs: the number on the trigger. Audit history never counts. */
  needsAction: number;
};

/**
 * A run's objective is whatever the run was started with, and for the
 * onboarding interview that is the entire system prompt. The panel shows a
 * label, not a prompt, so a known objective maps to plain words and anything
 * else is cut to its first line.
 */
const OBJECTIVE_LABELS: Record<string, string> = {
  "onboarding-interview v1": "Onboarding interview",
};

/** One line, at most 120 characters — the cap the panel can clamp further. */
function clampTitle(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function runLabel(objective: string): string {
  const first = objective.split("\n")[0].trim();
  const known = OBJECTIVE_LABELS[first];
  if (known) return known;
  return clampTitle(first) || "Agent run";
}

/**
 * A run's title prefers the summary the agent wrote for it — the agent_runs
 * column that existed for exactly this and was never read — and falls back to
 * the objective's first line, for a run with no summary yet and for the
 * onboarding interview, whose objective is a system prompt.
 */
export function runTitle(summary: string | null, objective: string): string {
  const line = summary?.trim();
  if (line) return clampTitle(line);
  return runLabel(objective);
}

const RUN_ACTION_STATE_LIST = ["queued", "running", "waiting_input", "waiting_approval"] as const;
const RUN_ACTION_STATES = new Set<string>(RUN_ACTION_STATE_LIST);
const FEED_LIMIT = 40;

const RUN_STATE_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting_input: "Waiting on you",
  waiting_approval: "Waiting on your approval",
  succeeded: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * The whole feed for one workspace. Bounded and parallel: the decisions queue,
 * the in-flight runs and the recent audit trail are independent reads.
 */
export async function listNotifications(
  auth: { workspaceId: string },
  options: { limit?: number } = {},
): Promise<NotificationFeed> {
  const limit = options.limit ?? FEED_LIMIT;
  const [decisions, runs, activity] = await Promise.all([
    listHomeQueue(auth.workspaceId),
    listRecentRuns(auth.workspaceId, limit),
    listWorkspaceActivity(auth as Parameters<typeof listWorkspaceActivity>[0], { limit }),
  ]);

  const decisionItems: Notification[] = decisions.map((card) => ({
    id: card.id,
    kind: "decision",
    title: card.title,
    detail: card.effect,
    at: card.createdAt,
    href: card.href,
    needsAction: true,
    state: card.decision.kind === "agent" && card.decision.expired ? "Expired" : "Waiting on you",
    decision:
      card.decision.kind === "agent"
        ? {
            kind: "agent",
            proposalId: card.id,
            revisionId: card.decision.revisionId,
            version: card.decision.version,
            expired: card.decision.expired,
          }
        : { kind: "capture", proposalId: card.id },
  }));

  const runItems: Notification[] = runs.map((run) => ({
    id: run.id,
    kind: "run",
    title: runLabel(run.objective),
    detail: run.error ?? run.summary ?? null,
    at: run.createdAt,
    href: `/polymath/${run.id}`,
    needsAction: RUN_ACTION_STATES.has(run.state),
    state: RUN_STATE_LABEL[run.state] ?? run.state,
  }));

  const auditItems: Notification[] = activity.map((row, index) => ({
    // Activity rows carry no id: action + time + index is stable within one
    // read, which is all a list key needs.
    id: `${row.action}:${row.createdAt.toISOString()}:${index}`,
    kind: "audit",
    title: projectSummary(row.action, row.summary),
    detail: `${row.actorKind === "agent" ? "Agent" : row.actorKind === "system" ? "System" : "You"} · ${row.subjectType}`,
    at: row.createdAt,
    href: "/activity",
    needsAction: false,
    state: row.action,
  }));

  // What needs the owner leads, then recency. Sorting the three kinds purely
  // by time buried a running run under two dozen audit rows about things that
  // had already happened - which is the failure this panel exists to fix.
  //
  // Decisions are NOT re-sorted among themselves: listHomeQueue already ranked
  // them (what expires, then what risks more, then what is newest), and
  // re-ordering by time alone would put a capture read above an external write
  // just for being newer. The rank order is the queue's own opinion and it
  // survives into the panel.
  const decisionOrder = new Map(decisionItems.map((item, index) => [item.id, index]));
  const items = [...decisionItems, ...runItems, ...auditItems].sort((a, b) => {
    if (a.needsAction !== b.needsAction) return a.needsAction ? -1 : 1;
    const rankA = decisionOrder.get(a.id);
    const rankB = decisionOrder.get(b.id);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    return b.at.getTime() - a.at.getTime();
  });

  return {
    items: items.slice(0, limit),
    counts: {
      decision: decisionItems.length,
      run: runItems.length,
      audit: auditItems.length,
    },
    needsAction:
      decisionItems.filter((item) => item.state !== "Expired").length +
      runItems.filter((item) => item.needsAction).length,
  };
}

/**
 * Runs still in flight, for a count read that does not pay for the audit scan.
 */
export async function countRunsInFlight(workspaceId: string): Promise<number> {
  const rows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workspaceId, workspaceId),
        inArray(agentRuns.state, [...RUN_ACTION_STATE_LIST]),
        // The question card owns a suspended run, so the run leaves the count
        // with its question — count and cards must agree.
        notExists(
          db
            .select({ one: sql`1` })
            .from(agentQuestions)
            .where(and(eq(agentQuestions.runId, agentRuns.id), eq(agentQuestions.state, "open"))),
        ),
      ),
    );
  return rows.length;
}

/*
 * The triage seam — the classified feed the rebuilt panel consumes (spec:
 * Notifications Zero-Hop Triage, §1). Same sources as listNotifications with
 * three differences: an item is one of three native kinds (question, decision,
 * run) instead of four flattened rows; audit rows are absent, because their
 * home is /activity and their synthetic per-read ids cannot back selection;
 * and a run's title prefers the summary the agent wrote for it.
 */

/** The panel's tabs: what needs the owner, what is working, what already happened. */
export type TriageTab = "inbox" | "inFlight" | "activity";

export type RunState = (typeof runState.enumValues)[number];

/** Where a run sits for triage: still working, failed, or finished. */
export type TriageRunPhase = "active" | "failed" | "done";

// A cancelled run finished without failing: nothing to read or fix, so it is
// history (Activity), not Inbox. waiting_approval stays in flight — its
// blocking proposal already surfaces in the Inbox as a decision card.
const RUN_FAILED_STATES = new Set<RunState>(["failed"]);
const RUN_DONE_STATES = new Set<RunState>(["succeeded", "cancelled"]);

export function classifyRunState(state: RunState): TriageRunPhase {
  if (RUN_FAILED_STATES.has(state)) return "failed";
  if (RUN_DONE_STATES.has(state)) return "done";
  return "active";
}

export type TriageItem =
  | {
      kind: "question";
      /** The agent_questions row — the CAS target of reply and dismiss. */
      id: string;
      runId: string;
      questionText: string;
      /** The specific missing input the agent supplied, when it did. */
      context: string | null;
      askedAt: Date;
      href: string;
    }
  | {
      kind: "decision";
      /** The proposal id, action or capture alike. */
      id: string;
      title: string;
      /** The exact effect approving has. */
      detail: string | null;
      href: string;
      at: Date;
      /** What one tap binds: an action approval binds the exact revision (CAS). */
      decision:
        { decisionType: "action"; revisionId: string; version: number; expired: boolean } | { decisionType: "capture" };
    }
  | {
      kind: "run";
      /** Equals runId, so every kind keys the same way. */
      id: string;
      runId: string;
      runState: RunState;
      /** The run surface's own word for the state, from RUN_STATE_LABEL. */
      stateLabel: string;
      title: string;
      /** The redacted failure detail; only failed runs carry one today. */
      detail: string | null;
      href: string;
      at: Date;
    };

export type TriageFeed = {
  items: TriageItem[];
  /** Per tab, so a tab header shows its own count without re-reading. */
  counts: Record<TriageTab, number>;
};

/** Which tab owns an item — the seam's classification, pinned by tests. */
export function triageTab(item: TriageItem): TriageTab {
  switch (item.kind) {
    case "question":
    case "decision":
      return "inbox";
    case "run":
      switch (item.runState) {
        case "failed":
          return "inbox";
        case "succeeded":
        case "cancelled":
          return "activity";
        case "queued":
        case "running":
        case "waiting_input":
        case "waiting_approval":
          return "inFlight";
        default: {
          const _exhaustive: never = item.runState;
          return _exhaustive;
        }
      }
  }
}

/**
 * The whole triage feed for one workspace. Bounded and parallel: the decisions
 * queue, the recent runs and the in-flight count are independent reads, and
 * only suspended runs pay for a question join. Audit rows are not read at all.
 */
export async function listTriageFeed(
  auth: { workspaceId: string },
  options: { limit?: number } = {},
): Promise<TriageFeed> {
  const limit = options.limit ?? FEED_LIMIT;
  const [decisions, runs, inFlight] = await Promise.all([
    listHomeQueue(auth.workspaceId),
    listRecentRuns(auth.workspaceId, limit),
    countRunsInFlight(auth.workspaceId),
  ]);

  // A question exists only where a run suspended on one. The join is the
  // per-run getter the run page reads, so the panel and the page can never
  // disagree about whether a question is still open.
  const waiting = runs.filter((run) => run.state === "waiting_input");
  const openQuestions = new Map<string, NonNullable<Awaited<ReturnType<typeof getOpenQuestion>>>>();
  await Promise.all(
    waiting.map(async (run) => {
      const question = await getOpenQuestion(auth.workspaceId, run.id);
      if (question) openQuestions.set(run.id, question);
    }),
  );

  const questionItems: Extract<TriageItem, { kind: "question" }>[] = waiting.flatMap((run) => {
    const question = openQuestions.get(run.id);
    if (!question) return [];
    return [
      {
        kind: "question",
        id: question.id,
        runId: run.id,
        questionText: question.question,
        context: question.context,
        askedAt: question.askedAt,
        href: `/polymath/${run.id}`,
      },
    ];
  });

  // Decisions keep the queue's own rank (what expires, then what risks more,
  // then what is newest) — the same order the homepage shows.
  const decisionItems: Extract<TriageItem, { kind: "decision" }>[] = decisions.map((card) => ({
    kind: "decision",
    id: card.id,
    title: card.title,
    detail: card.effect,
    href: card.href,
    at: card.createdAt,
    decision:
      card.decision.kind === "agent"
        ? {
            decisionType: "action",
            revisionId: card.decision.revisionId,
            version: card.decision.version,
            expired: card.decision.expired,
          }
        : { decisionType: "capture" },
  }));

  const runItems: Extract<TriageItem, { kind: "run" }>[] = runs
    // A suspended run speaks through its question card; listing it again as an
    // in-flight card would show one run in two tabs.
    .filter((run) => !openQuestions.has(run.id))
    .map((run) => ({
      kind: "run",
      id: run.id,
      runId: run.id,
      runState: run.state,
      stateLabel: RUN_STATE_LABEL[run.state] ?? run.state,
      title: runTitle(run.summary, run.objective),
      detail: run.error,
      href: `/polymath/${run.id}`,
      at: run.createdAt,
    }));

  const failedRuns = runItems.filter((item) => classifyRunState(item.runState) === "failed");
  const inFlightRuns = runItems.filter((item) => classifyRunState(item.runState) === "active");
  const doneRuns = runItems.filter((item) => classifyRunState(item.runState) === "done");

  // Tab order, then the product's order within a tab: a suspended agent asks
  // before a proposal waits, the queue's rank survives for decisions, and the
  // rest is recency (listRecentRuns already reads newest first).
  const items: TriageItem[] = [...questionItems, ...decisionItems, ...failedRuns, ...inFlightRuns, ...doneRuns].slice(
    0,
    limit,
  );

  return {
    items,
    counts: {
      // Everything that needs the owner. Expired decisions stay counted —
      // they occupy the Inbox; only their buttons are disabled.
      inbox: questionItems.length + decisionItems.length + failedRuns.length,
      // DB truth, not the page's slice, so the tab count holds when the feed
      // is capped. A run suspended on a question counts here too: it is in
      // flight, and its card surfaces in the Inbox where it needs you.
      inFlight,
      activity: doneRuns.length,
    },
  };
}
