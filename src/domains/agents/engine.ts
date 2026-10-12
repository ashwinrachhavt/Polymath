import { and, eq, inArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { releaseSpend, reserveSpend } from "@/domains/spending/commands";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
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
 * The seam domain code sees. `sessionId` is the run id: the bridge keys its
 * mirror on it, so a run and its session are the same thing by construction.
 */
export interface SessionDriver {
  start(input: {
    sessionId: string;
    auth: AuthContext;
    policy: PolicySnapshot;
    instructions: string | null;
  }): Promise<void>;
  signal(sessionId: string, signal: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}

export interface AgentEngine {
  start(input: {
    auth: AuthContext;
    profileName: string;
    objective: string;
    subjects: unknown[];
    estimateUsd: string;
    threadId?: string;
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

export function createEngine(
  driver: SessionDriver,
  now: () => Date = () => new Date(),
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
        await db
          .update(agentRuns)
          .set({
            state: "failed",
            error: `spend ${claim.reason}`,
            endedAt: now(),
            updatedAt: now(),
          })
          .where(eq(agentRuns.id, run.id));
        throw new Error("Spend ceiling exceeded");
      }

      await db
        .update(agentRuns)
        .set({ state: "running", startedAt: now(), updatedAt: now() })
        .where(eq(agentRuns.id, run.id));

      await driver.start({
        sessionId: run.id,
        auth: input.auth,
        policy,
        instructions: profile.instructions ?? null,
      });

      return { runId: run.id, reservationId: claim.reservationId };
    },

    async signal(runId, signal, auth) {
      const run = await scopeCheck(runId, auth);
      if (isTerminal(run.state)) return;
      await driver.signal(run.id, signal);
    },

    async resume(runId, auth) {
      const run = await scopeCheck(runId, auth);
      if (isTerminal(run.state)) return;
      await driver.signal(run.id, "resume");
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

      await driver.cancel(runId);

      // The reservation is released in the same transaction that reads it;
      // releaseSpend is itself guarded on status = 'reserved', so a settled or
      // already-released claim is left alone.
      await withTransaction(async (tx) => {
        const open = (await tx.execute(
          sql`select id from spending_reservations where run_id = ${runId} and status = 'reserved' limit 1`,
        )) as unknown as { id: string }[];
        const reservation = open[0];
        if (reservation) {
          await releaseSpend(tx, { workspaceId: auth.workspaceId }, { reservationId: reservation.id });
        }
      });

      return { cancelled: true };
    },
  };
}
