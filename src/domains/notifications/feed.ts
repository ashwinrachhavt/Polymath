import { and, eq, inArray } from "drizzle-orm";
import { listRecentRuns } from "@/domains/agents/queries";
import { listWorkspaceActivity, projectSummary } from "@/domains/audit/queries";
import { listHomeQueue } from "@/domains/home/queue";
import { db } from "@/lib/db";
import { agentRuns } from "@/domains/agents/schema";

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

function runLabel(objective: string): string {
  const first = objective.split("\n")[0].trim();
  const known = OBJECTIVE_LABELS[first];
  if (known) return known;
  return first.length > 120 ? `${first.slice(0, 117)}...` : first || "Agent run";
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
    href: `/alfred/${run.id}`,
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
  const items = [...decisionItems, ...runItems, ...auditItems].sort((a, b) => {
    if (a.needsAction !== b.needsAction) return a.needsAction ? -1 : 1;
    return b.at.getTime() - a.at.getTime();
  });

  return {
    items: items.slice(0, limit),
    counts: {
      decision: decisionItems.length,
      run: runItems.length,
      audit: auditItems.length,
    },
    needsAction: decisionItems.filter((item) => item.state !== "Expired").length +
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
    .where(and(eq(agentRuns.workspaceId, workspaceId), inArray(agentRuns.state, [...RUN_ACTION_STATE_LIST])));
  return rows.length;
}
