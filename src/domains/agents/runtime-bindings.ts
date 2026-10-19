import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentProfileRevisions,
  agentProfiles,
  runExecutions,
  runSignals,
  toolCalls,
} from "./schema";

/*
 * ASH-117 (RT03): immutable execution inputs and durable runtime bindings.
 *
 * What lives here and why:
 *   - canonicalHash: one canonicalization for argument/payload identity, so a
 *     replayed request compares equal no matter how the caller ordered keys.
 *   - captureProfileRevision: a run binds the immutable revision of its
 *     profile, so editing the profile later can never rewrite history.
 *   - openExecution / bindExecution / failExecution / completeExecution: one
 *     row per logical provider execution, with `uncertain` as a first-class
 *     state — a lost dispatch response is never written down as "failed",
 *     because the execution may exist and only reconciliation can close it.
 *   - deliverSignal: a signal is durable before delivery, with a stable
 *     identity; a replayed delivery of a delivered signal does nothing, and
 *     the same identity with a different payload fails loudly.
 *   - recordToolInvocation / completeToolInvocation: idempotent tool calls.
 *     Replaying an invocation id returns the recorded row instead of
 *     repeating paid work or an external effect; reusing the id with
 *     different arguments throws.
 */

/** Stable JSON: object keys sorted recursively, undefined dropped, arrays keep order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

type ProfileRow = typeof agentProfiles.$inferSelect;

/** The profile fields a revision pins; anything else on the row is bookkeeping. */
export function profileRevisionSnapshot(profile: ProfileRow) {
  return {
    name: profile.name,
    description: profile.description ?? null,
    instructions: profile.instructions ?? null,
    modelPolicy: profile.modelPolicy ?? {},
    allowedTools: profile.allowedTools ?? [],
    allowedAccounts: profile.allowedAccounts ?? [],
    contextPolicy: profile.contextPolicy ?? {},
    budgetPolicy: profile.budgetPolicy ?? {},
    memoryPolicy: profile.memoryPolicy ?? {},
  };
}

/*
 * The revision of the profile exactly as admitted. An unchanged profile
 * reuses its latest revision; any change writes the next one. The unique
 * (profile_id, revision_number) index makes a concurrent capture safe: the
 * loser re-reads and gets the winner's row.
 */
export async function captureProfileRevision(
  workspaceId: string,
  profile: ProfileRow,
): Promise<string> {
  const wanted = canonicalHash(profileRevisionSnapshot(profile));
  const revisions = await db
    .select()
    .from(agentProfileRevisions)
    .where(
      and(
        eq(agentProfileRevisions.workspaceId, workspaceId),
        eq(agentProfileRevisions.profileId, profile.id),
      ),
    );
  // A row missing its NOT NULL fields is not a valid revision (a mocked or
  // partial read); treat it as absent rather than binding garbage. Max in
  // code rather than ORDER BY: the set is one profile's history.
  const valid = revisions.filter((r) => typeof r.revisionNumber === "number");
  const latest = valid.reduce<(typeof valid)[number] | undefined>(
    (max, r) => (max && max.revisionNumber > r.revisionNumber ? max : r),
    undefined,
  );
  if (latest && canonicalHash(profileRevisionSnapshot(latest as unknown as ProfileRow)) === wanted) {
    return latest.id;
  }
  const snapshot = profileRevisionSnapshot(profile);
  const next = (latest?.revisionNumber ?? 0) + 1;
  const [inserted] = await db
    .insert(agentProfileRevisions)
    .values({
      workspaceId,
      profileId: profile.id,
      revisionNumber: next,
      ...snapshot,
    })
    .onConflictDoNothing()
    .returning({ id: agentProfileRevisions.id });
  if (inserted) return inserted.id;
  // Lost a race: the conflicting row holds the same revision number. Re-read.
  const [raced] = await db
    .select({ id: agentProfileRevisions.id })
    .from(agentProfileRevisions)
    .where(
      and(
        eq(agentProfileRevisions.workspaceId, workspaceId),
        eq(agentProfileRevisions.profileId, profile.id),
        eq(agentProfileRevisions.revisionNumber, next),
      ),
    )
    .limit(1);
  if (!raced) throw new Error("profile revision capture lost its race and found no winner");
  return raced.id;
}

/** The environment label an execution identity is unique within. */
export function executionEnvironment(): string {
  return process.env.VERCEL_ENV ?? (process.env.NODE_ENV === "production" ? "production" : "development");
}

/**
 * Opens the execution record before the provider sees any work: a crash
 * between dispatch and bind leaves a `dispatched` row to reconcile rather
 * than silent work. The dispatch key is stable so a retried dispatch of the
 * same generation cannot create a second logical execution.
 */
export async function openExecution(input: {
  workspaceId: string;
  runId: string;
  generation: number;
  provider: string;
  workflowVersion?: string | null;
}): Promise<{ executionId: string; dispatchKey: string }> {
  const dispatchKey = `run-${input.runId}-gen-${input.generation}`;
  const [execution] = await db
    .insert(runExecutions)
    .values({
      workspaceId: input.workspaceId,
      runId: input.runId,
      generation: input.generation,
      provider: input.provider,
      environment: executionEnvironment(),
      workflowVersion: input.workflowVersion ?? null,
      dispatchKey,
      state: "dispatched",
      dispatchedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: runExecutions.id });
  if (execution) return { executionId: execution.id, dispatchKey };
  const [existing] = await db
    .select({ id: runExecutions.id })
    .from(runExecutions)
    .where(and(eq(runExecutions.workspaceId, input.workspaceId), eq(runExecutions.dispatchKey, dispatchKey)))
    .limit(1);
  if (!existing) throw new Error("execution dispatch key collided and found no existing row");
  return { executionId: existing.id, dispatchKey };
}

/*
 * Binds the provider's own execution id. A provider id is bound once: binding
 * a different id to the same execution means the driver mixed up sessions,
 * and that is an error, not an overwrite. The partial unique index on
 * (provider, environment, provider_execution_id) stops the reverse direction:
 * two executions claiming one provider-side execution.
 */
export async function bindExecution(input: {
  workspaceId: string;
  runId: string;
  executionId: string;
  providerExecutionId: string;
  workflowVersion?: string | null;
}): Promise<void> {
  const [current] = await db
    .select({ providerExecutionId: runExecutions.providerExecutionId })
    .from(runExecutions)
    .where(
      and(
        eq(runExecutions.id, input.executionId),
        eq(runExecutions.workspaceId, input.workspaceId),
        eq(runExecutions.runId, input.runId),
      ),
    )
    .limit(1);
  if (!current) throw new Error("execution not found in workspace");
  if (current.providerExecutionId && current.providerExecutionId !== input.providerExecutionId) {
    throw new Error(
      `execution already bound to a different provider execution; refusing to rebind`,
    );
  }
  if (current.providerExecutionId === input.providerExecutionId) return; // idempotent rebind
  await db
    .update(runExecutions)
    .set({
      providerExecutionId: input.providerExecutionId,
      workflowVersion: input.workflowVersion ?? undefined,
      state: "bound",
      boundAt: new Date(),
    })
    .where(eq(runExecutions.id, input.executionId));
}

/**
 * Marks an execution uncertain: the dispatch outcome is unknown and the
 * execution may exist at the provider. Never call this "failed" — only a
 * provider answer or a reconciliation observation can do that.
 */
export async function markExecutionUncertain(executionId: string): Promise<void> {
  await db
    .update(runExecutions)
    .set({ state: "uncertain", uncertainAt: new Date() })
    .where(and(eq(runExecutions.id, executionId), eq(runExecutions.state, "dispatched")));
}

export async function completeExecution(
  executionId: string,
  outcome: "completed" | "failed",
): Promise<void> {
  await db
    .update(runExecutions)
    .set({ state: outcome, completedAt: new Date() })
    .where(eq(runExecutions.id, executionId));
}

/*
 * Delivers a signal under a durable identity. The row exists before the
 * delivery attempt; a replayed key with the same payload that already
 * delivered is a no-op, so a retried send is never a second send. The same
 * key with a different payload is rejected, because delivering it would
 * silently change what the identity means.
 */
export async function deliverSignal(input: {
  workspaceId: string;
  runId: string;
  signalKey?: string;
  payload: unknown;
  deliver: () => Promise<void>;
}): Promise<{ replayed: boolean }> {
  const signalKey = input.signalKey ?? `sig_${randomUUID()}`;
  const payloadHash = canonicalHash(input.payload ?? null);
  const payloadSummary = input.payload === undefined ? null : (JSON.parse(JSON.stringify(input.payload ?? null)) as unknown);

  const candidates = await db
    .select()
    .from(runSignals)
    .where(
      and(
        eq(runSignals.workspaceId, input.workspaceId),
        eq(runSignals.runId, input.runId),
        eq(runSignals.signalKey, signalKey),
      ),
    )
    .limit(1);
  // A row without its NOT NULL hash is not a valid signal row; treat as absent.
  const existing = candidates[0] && typeof candidates[0].payloadHash === "string" ? candidates[0] : null;
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw new Error(`signal "${signalKey}" was already used with a different payload`);
    }
    if (existing.status === "delivered") return { replayed: true };
  }

  if (!existing) {
    await db.insert(runSignals).values({
      workspaceId: input.workspaceId,
      runId: input.runId,
      generation: await currentGeneration(input.workspaceId, input.runId),
      signalKey,
      payloadHash,
      payloadSummary: payloadSummary as Record<string, unknown> | null,
      status: "pending",
    });
  }

  try {
    await input.deliver();
  } catch (cause) {
    await db
      .update(runSignals)
      .set({ status: "unknown", attempts: existing ? existing.attempts + 1 : 1, lastAttemptAt: new Date(), reconciliation: "pending" })
      .where(
        and(
          eq(runSignals.workspaceId, input.workspaceId),
          eq(runSignals.runId, input.runId),
          eq(runSignals.signalKey, signalKey),
        ),
      );
    throw cause;
  }
  await db
    .update(runSignals)
    .set({ status: "delivered", attempts: existing ? existing.attempts + 1 : 1, lastAttemptAt: new Date(), deliveredAt: new Date() })
    .where(
      and(
        eq(runSignals.workspaceId, input.workspaceId),
        eq(runSignals.runId, input.runId),
        eq(runSignals.signalKey, signalKey),
      ),
    );
  return { replayed: false };
}

/** The newest execution generation for a run; 1 when no execution row exists yet. */
async function currentGeneration(workspaceId: string, runId: string): Promise<number> {
  const rows = await db
    .select({ generation: runExecutions.generation })
    .from(runExecutions)
    .where(and(eq(runExecutions.workspaceId, workspaceId), eq(runExecutions.runId, runId)));
  const generations = rows.map((r) => r.generation).filter((g) => typeof g === "number");
  return generations.length ? Math.max(...generations) : 1;
}

/*
 * Idempotent tool invocation. The caller's invocation id plus the canonical
 * argument hash is the dedupe rule: a replay returns the recorded row (paid
 * work and external effects are not repeated), and the same id with different
 * arguments throws instead of silently meaning two things.
 */
export async function recordToolInvocation(input: {
  workspaceId: string;
  runId: string;
  invocationId: string;
  toolName: string;
  accountAlias?: string | null;
  /** Redacted arguments — the hash covers exactly what is stored. */
  args?: unknown;
  stepId?: string | null;
}): Promise<{ toolCallId: string; replayed: boolean }> {
  const argumentHash = canonicalHash(input.args ?? null);
  const [existing] = await db
    .select({ id: toolCalls.id, argumentHash: toolCalls.argumentHash })
    .from(toolCalls)
    .where(and(eq(toolCalls.workspaceId, input.workspaceId), eq(toolCalls.invocationId, input.invocationId)))
    .limit(1);
  if (existing && typeof existing.argumentHash === "string") {
    if (existing.argumentHash !== argumentHash) {
      throw new Error(
        `invocation "${input.invocationId}" was already used with different arguments`,
      );
    }
    return { toolCallId: existing.id, replayed: true };
  }
  const [inserted] = await db
    .insert(toolCalls)
    .values({
      workspaceId: input.workspaceId,
      runId: input.runId,
      stepId: input.stepId ?? null,
      toolName: input.toolName,
      accountAlias: input.accountAlias ?? null,
      arguments: (input.args ?? null) as Record<string, unknown> | null,
      invocationId: input.invocationId,
      argumentHash,
      executionState: "requested",
    })
    .onConflictDoNothing()
    .returning({ id: toolCalls.id });
  if (inserted) return { toolCallId: inserted.id, replayed: false };
  // Lost a race to the same invocation id: the winner's row is the answer,
  // subject to the same argument-hash check.
  const [raced] = await db
    .select({ id: toolCalls.id, argumentHash: toolCalls.argumentHash })
    .from(toolCalls)
    .where(and(eq(toolCalls.workspaceId, input.workspaceId), eq(toolCalls.invocationId, input.invocationId)))
    .limit(1);
  if (!raced) throw new Error("tool invocation lost its race and found no winner");
  if (raced.argumentHash !== argumentHash) {
    throw new Error(`invocation "${input.invocationId}" was already used with different arguments`);
  }
  return { toolCallId: raced.id, replayed: true };
}

/** Closes a recorded invocation with its redacted result. Replay-safe: closing a closed row matches nothing. */
export async function completeToolInvocation(input: {
  workspaceId: string;
  invocationId: string;
  ok: boolean;
  result?: unknown;
  errorCode?: string | null;
  durationMs?: number | null;
}): Promise<void> {
  await db
    .update(toolCalls)
    .set({
      ok: input.ok,
      result: (input.result ?? null) as Record<string, unknown> | null,
      errorCode: input.errorCode ?? null,
      durationMs: input.durationMs ?? null,
      executionState: input.ok ? "completed" : "failed",
    })
    .where(
      and(
        eq(toolCalls.workspaceId, input.workspaceId),
        eq(toolCalls.invocationId, input.invocationId),
        eq(toolCalls.executionState, "requested"),
      ),
    );
}
