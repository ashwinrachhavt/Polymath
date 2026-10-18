import { and, eq, inArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { releaseSpend, reserveSpend } from "@/domains/spending/commands";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { recordRoundEvent, redactText } from "./event-bridge";
import { agentProfiles, agentRuns } from "./schema";

/*
 * The AgentEngine contract: the only shape domain code sees for agent
 * execution. The session itself lives behind SessionDriver — the eve-backed
 * implementation arrives separately, and no file outside that one imports
 * `eve`.
 *
 * The invariants enforced here, not in the caller:
 *   - the run row exists (queued) before anything is spent or started, and its
 *     policy snapshot is frozen at that moment;
 *   - the spend reservation commits before the driver sees the session;
 *   - cancel flips the run to a terminal state first, and only then tells the
 *     driver and hands the reservation back. Terminal states are immutable, so
 *     a second cancel matches no row and is a no-op.
 */

export type PolicySnapshot = {
  profileId: string;
  model: string | null;
  allowedTools: unknown;
  allowedAccounts: unknown;
  budgetUsd: unknown;
  auth: AuthContext;
};

/**
 * `sessionId` is the Axiom run UUID. A driver may allocate its own session ID;
 * Eve persists that binding in session_ref before tools can resolve the run.
 */
export interface SessionDriver {
  start(input: {
    sessionId: string;
    auth: AuthContext;
    policy: PolicySnapshot;
    instructions: string | null;
    /** The objective becomes the session's first message: it starts the turn. */
    objective: string;
  }): Promise<void>;
  signal(sessionId: string, signal: string, auth: AuthContext): Promise<void>;
  cancel(sessionId: string, auth: AuthContext): Promise<void>;
}

export interface AgentEngine {
  start(input: {
    auth: AuthContext;
    profileName: string;
    objective: string;
    subjects: unknown[];
    estimateUsd: string;
    threadId?: string;
    /** Set when this run retries a finished one. */
    retryOfRunId?: string;
  }): Promise<{ runId: string; reservationId: string }>;
  signal(runId: string, signal: string, auth: AuthContext): Promise<void>;
  resume(runId: string, auth: AuthContext): Promise<void>;
  cancel(runId: string, auth: AuthContext): Promise<{ cancelled: boolean }>;
}

type RunState = (typeof agentRuns.$inferSelect)["state"];

/** The live states the run table's partial active index covers. */
const ACTIVE_STATES: RunState[] = ["queued", "running", "waiting_input", "waiting_approval"];
const TERMINAL_STATES: RunState[] = ["succeeded", "failed", "cancelled"];

const isTerminal = (state: RunState) => TERMINAL_STATES.includes(state);

/*
 * A profile's model routing is provider-shaped jsonb; the run row's `model`
 * column is the resolved primary, which is what spend prices against. Anything
 * else in the policy stays in the frozen snapshot untouched.
 */
function primaryModel(modelPolicy: unknown): string | null {
  if (typeof modelPolicy !== "object" || modelPolicy === null) return null;
  const primary = (modelPolicy as { primary?: unknown }).primary;
  return typeof primary === "string" ? primary : null;
}

/**
 * Resolves the run and proves it belongs to the caller's workspace in one read.
 * A run from another workspace and a run that does not exist are the same
 * error on purpose: the difference is not the caller's to learn.
 */
async function scopeCheck(runId: string, auth: AuthContext) {
  const [run] = await db
    .select({ id: agentRuns.id, workspaceId: agentRuns.workspaceId, state: agentRuns.state })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run || run.workspaceId !== auth.workspaceId) {
    throw new Error("run not found in workspace");
  }
  return run;
}

/** Closes a run that will never do work. The error text is redacted on write. */
async function failRun(runId: string, error: string, at: Date): Promise<void> {
  // A driver/provider failure message is where a credential leaks into a
  // column; the schema says redacted detail only, never a raw provider payload.
  await db
    .update(agentRuns)
    .set({ state: "failed", error: redactText(error), endedAt: at, updatedAt: at })
    .where(eq(agentRuns.id, runId));
}

/*
 * Hands back whatever budget the run still holds. Scoped to the workspace so a
 * run id from elsewhere cannot touch another tenant's reservation; a settled or
 * already-released claim matches nothing (releaseSpend is guarded the same way).
 */
async function releaseOpenReservation(runId: string, workspaceId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const open = (await tx.execute(
      sql`select id from spending_reservations
          where run_id = ${runId} and workspace_id = ${workspaceId} and status = 'reserved'
          limit 1`,
    )) as unknown as { id: string }[];
    const reservation = open[0];
    if (reservation) {
      await releaseSpend(tx, { workspaceId }, { reservationId: reservation.id });
    }
  });
}

/** Appends one line to a run's persisted thread (run_events). Injected so unit tests need no database. */
export type ThreadWriter = (input: {
  runId: string;
  workspaceId: string;
  type: string;
  data?: unknown;
}) => Promise<unknown>;

export function createEngine(
  driver: SessionDriver,
  now: () => Date = () => new Date(),
  writeEvent: ThreadWriter = recordRoundEvent,
): AgentEngine {
  return {
    async start(input) {
      const [profile] = await db
        .select()
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.workspaceId, input.auth.workspaceId),
            eq(agentProfiles.name, input.profileName),
          ),
        )
        .limit(1);
      if (!profile) throw new Error(`Unknown agent profile: ${input.profileName}`);

      const model = primaryModel(profile.modelPolicy);
      const policy: PolicySnapshot = {
        profileId: profile.id,
        model,
        allowedTools: profile.allowedTools,
        allowedAccounts: profile.allowedAccounts,
        budgetUsd: profile.budgetPolicy,
        auth: input.auth,
      };

      // The run exists before the session does, so a crash between the two
      // leaves a queued row to reconcile rather than silent work.
      const [run] = await db
        .insert(agentRuns)
        .values({
          workspaceId: input.auth.workspaceId,
          threadId: input.threadId ?? null,
          agentProfileId: profile.id,
          objective: input.objective,
          retryOfRunId: input.retryOfRunId ?? null,
          subjects: input.subjects,
          state: "queued",
          policySnapshot: policy,
          model,
        })
        .returning({ id: agentRuns.id });

      const claim = await withTransaction((tx) =>
        reserveSpend(
          tx,
          { workspaceId: input.auth.workspaceId },
          { runId: run.id, model, estimateUsd: input.estimateUsd },
        ),
      );
      if (!claim.ok) {
        // No budget, no run: the row is closed rather than left live to retry.
        await failRun(run.id, `spend ${claim.reason}`, now());
        throw new Error("Spend ceiling exceeded");
      }

      await db
        .update(agentRuns)
        .set({ state: "running", startedAt: now(), updatedAt: now() })
        .where(eq(agentRuns.id, run.id));

      // The objective is the thread's first message, written before Eve can
      // emit anything so a reload always reads it first.
      await writeEvent({
        runId: run.id,
        workspaceId: input.auth.workspaceId,
        type: "message",
        data: { role: "user", content: input.objective },
      });

      try {
        await driver.start({
          sessionId: run.id,
          auth: input.auth,
          policy,
          instructions: profile.instructions ?? null,
          objective: input.objective,
        });
      } catch (cause) {
        // A session that never started is not a running run: close it and give
        // the budget back, else the row stays live with money held forever.
        const message = cause instanceof Error ? cause.message : String(cause);
        await failRun(run.id, `driver failed to start: ${message}`, now());
        await releaseOpenReservation(run.id, input.auth.workspaceId);
        throw cause;
      }

      return { runId: run.id, reservationId: claim.reservationId };
    },

    async signal(runId, signal, auth) {
      const run = await scopeCheck(runId, auth);
      if (isTerminal(run.state)) return;
      await driver.signal(run.id, signal, auth);
      // The follow-up is real work again: a parked run goes back to running.
      // Conditional, so a close that landed meanwhile is never rewritten.
      await db
        .update(agentRuns)
        .set({ state: "running", updatedAt: now() })
        .where(and(eq(agentRuns.id, run.id), eq(agentRuns.state, "waiting_input")));
    },

    async resume(runId, auth) {
      const run = await scopeCheck(runId, auth);
      if (isTerminal(run.state)) return;
      await driver.signal(run.id, "resume", auth);
    },

    async cancel(runId, auth) {
      await scopeCheck(runId, auth);

      // Conditional on an active state: this write is the claim, so two
      // cancels cannot both win and a terminal run is never rewritten.
      const ended = await db
        .update(agentRuns)
        .set({ state: "cancelled", endedAt: now(), updatedAt: now() })
        .where(and(eq(agentRuns.id, runId), inArray(agentRuns.state, ACTIVE_STATES)))
        .returning({ id: agentRuns.id });
      if (ended.length === 0) return { cancelled: false };

      await driver.cancel(runId, auth);
      await writeEvent({ runId, workspaceId: auth.workspaceId, type: "cancelled", data: { by: auth.userId } });

      // The run is terminal before the budget is handed back; the release is
      // guarded on status = 'reserved', so a settled claim is left alone.
      await releaseOpenReservation(runId, auth.workspaceId);

      return { cancelled: true };
    },
  };
}
