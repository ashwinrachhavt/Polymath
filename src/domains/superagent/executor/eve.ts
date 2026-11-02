/**
 * The eve seam: how the executor sees the session runtime. It is deliberately
 * narrow — five operations, no event bridging, no streaming — because the
 * engine's parts may know only this much of eve. The seam never decides
 * anything; it starts a run, carries an input to it, and stops it.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRuns } from "@/domains/agents/schema";
import type { AgentEngine } from "@/domains/agents/engine";
import type { AuthContext } from "@/domains/identity/resolve";

export type AgentRunState = (typeof agentRuns.$inferSelect)["state"];

/** The live states the run table's partial active index covers (agents/engine.ts). */
export const ACTIVE_RUN_STATES: AgentRunState[] = ["queued", "running", "waiting_input", "waiting_approval"];

export function isActiveRunState(state: AgentRunState): boolean {
  return ACTIVE_RUN_STATES.includes(state);
}

/** The slice of an agent run row the executor reads back. */
export interface LiveRun {
  agentRunId: string;
  state: AgentRunState;
}

interface RunLookup {
  ticketId: string;
  runId: string;
}

/**
 * The five operations a ticket run needs from eve. `auth` rides every call:
 * a ticket run has no session of its own to inherit it from, so the host
 * resolves the workspace owner per operation. `workspaceId` and the ticket
 * ids exist to bound queries; the run ids are the seam's real handles.
 */
export interface EveForSuperagent {
  /** The active agent run carrying this TicketRun, if any. */
  liveRun(input: RunLookup & { workspaceId: string }): Promise<LiveRun | undefined>;
  /** The newest agent run for this TicketRun in any state — the launch replay check reads it. */
  lastRun(input: RunLookup & { workspaceId: string }): Promise<LiveRun | undefined>;
  /** Start one create-once run for the ticket run; its objective opens the session's first turn. */
  start(input: {
    workspaceId: string;
    auth: AuthContext;
    ticketId: string;
    runId: string;
    objective: string;
    profileName: string;
    estimateUsd: string;
  }): Promise<{ agentRunId: string }>;
  /** Carry an input's text to the run's session. */
  signal(input: { workspaceId: string; auth: AuthContext; agentRunId: string; text: string }): Promise<void>;
  /** Cancel the run's session; the conditional write makes two cancels safe. */
  cancel(input: { workspaceId: string; auth: AuthContext; agentRunId: string }): Promise<{ cancelled: boolean }>;
}

/**
 * Subjects carry the domain ownership of an agent run: one run belongs to one
 * ticket and one TicketRun. Subject tags mirror the event-bridge's
 * superagent_ticket tags so any consumer can trace a run to its ticket.
 */
function ticketRunSubjects(ticketId: string, runId: string): { type: string; id: string }[] {
  return [
    { type: "superagent_ticket", id: ticketId },
    { type: "superagent_ticket_run", id: runId },
  ];
}

/** The real seam over the AgentEngine and the run table. */
export function createEveSeam(engine: AgentEngine): EveForSuperagent {
  const byRunSubject = async (workspaceId: string, runId: string): Promise<LiveRun | undefined> => {
    const rows = await db
      .select({ id: agentRuns.id, state: agentRuns.state })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.workspaceId, workspaceId),
          sql`${agentRuns.subjects} @> ${JSON.stringify([{ type: "superagent_ticket_run", id: runId }])}::jsonb`,
        ),
      )
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    const row = rows[0];
    return row ? { agentRunId: row.id, state: row.state } : undefined;
  };

  return {
    liveRun: async ({ workspaceId, runId }) => {
      const found = await byRunSubject(workspaceId, runId);
      return found && isActiveRunState(found.state) ? found : undefined;
    },
    lastRun: ({ workspaceId, runId }) => byRunSubject(workspaceId, runId),
    start: async ({ auth, ticketId, runId, objective, profileName, estimateUsd }) => {
      const { runId: agentRunId } = await engine.start({
        auth,
        profileName,
        objective,
        subjects: ticketRunSubjects(ticketId, runId),
        estimateUsd,
        // A launch's objective is run machinery — the ticket's scope and the
        // request that started it — not a person's words; it opens the
        // session's first turn without appearing in any chat transcript.
        objectiveInternal: true,
      });
      return { agentRunId };
    },
    signal: ({ auth, agentRunId, text }) => engine.signal(agentRunId, text, auth),
    cancel: ({ auth, agentRunId }) => engine.cancel(agentRunId, auth),
  };
}
