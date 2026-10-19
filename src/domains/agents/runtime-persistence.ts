import { and, eq, isNull, max, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { agentProfiles, agentRuns } from "./schema";
import {
  agentProfileRevisions,
  runtimeExecutions,
  runtimeSignals,
  toolInvocations,
  type EffectClass,
} from "./runtime-schema";

/*
 * Persistence for immutable profile revisions, runtime executions, signals and
 * tool invocations (ASH-117). Database constraints are the authority; these
 * functions make the intended transitions easy and turn conflicts into named
 * errors. None of them calls a provider: reserve, commit, call, settle.
 */

type Executor = Pick<typeof db, "select" | "insert" | "update" | "execute">;

export class RuntimeConflictError extends Error {
  constructor(
    readonly code:
      | "invocation_arguments_mismatch"
      | "signal_payload_mismatch"
      | "dispatch_key_mismatch"
      | "execution_already_bound"
      | "stale_generation"
      | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeConflictError";
  }
}

/** Stable JSON: object keys sorted, undefined dropped, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const hashCanonical = (value: unknown) => sha256Hex(canonicalJson(value));

const SECRET_KEY = /secret|token|password|passwd|authorization|api[_-]?key|credential|cookie/i;

/** Strips secret-looking values before anything is stored. Hidden reasoning is never passed in. */
export function redactForStorage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForStorage);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? "[redacted]" : redactForStorage(v),
      ]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Profile revisions

/**
 * Captures the profile as it is now. Identical content reuses the existing
 * revision; an edited profile gets the next number. Serialized per profile so
 * two racing admissions cannot claim the same revision number.
 */
export async function captureProfileRevision(
  input: { workspaceId: string; profileId: string; createdBy?: string | null },
  client: typeof db = db,
) {
  return client.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agent_profile_revision:${input.profileId}`}, 0))`);
    const [profile] = await tx
      .select()
      .from(agentProfiles)
      .where(and(eq(agentProfiles.id, input.profileId), eq(agentProfiles.workspaceId, input.workspaceId)))
      .limit(1);
    if (!profile) throw new RuntimeConflictError("not_found", "profile not found in workspace");
    const snapshot = {
      name: profile.name,
      description: profile.description,
      instructions: profile.instructions,
      modelPolicy: profile.modelPolicy,
      allowedTools: profile.allowedTools,
      allowedAccounts: profile.allowedAccounts,
      contextPolicy: profile.contextPolicy,
      budgetPolicy: profile.budgetPolicy,
      memoryPolicy: profile.memoryPolicy,
    };
    const contentHash = await hashCanonical(snapshot);
    const [existing] = await tx
      .select()
      .from(agentProfileRevisions)
      .where(and(eq(agentProfileRevisions.agentProfileId, profile.id), eq(agentProfileRevisions.contentHash, contentHash)))
      .limit(1);
    if (existing) return existing;
    const [{ latest }] = await tx
      .select({ latest: max(agentProfileRevisions.revision) })
      .from(agentProfileRevisions)
      .where(eq(agentProfileRevisions.agentProfileId, profile.id));
    const [created] = await tx
      .insert(agentProfileRevisions)
      .values({
        workspaceId: input.workspaceId,
        agentProfileId: profile.id,
        revision: (latest ?? 0) + 1,
        contentHash,
        snapshot,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return created;
  });
}

/** Pins a run to a revision once. A different revision afterwards is rejected by the database. */
export async function bindRunToRevision(
  input: { workspaceId: string; runId: string; revisionId: string },
  client: Executor = db,
) {
  const rows = await client
    .update(agentRuns)
    .set({ profileRevisionId: input.revisionId })
    .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.workspaceId, input.workspaceId), isNull(agentRuns.profileRevisionId)))
    .returning({ id: agentRuns.id });
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Executions

export type ExecutionInput = {
  workspaceId: string;
  runId: string;
  generation: number;
  provider: string;
  environment: string;
  workflowVersion: string;
  dispatchKey: string;
};

/** Idempotent on dispatchKey: a repeat returns the first row; the same key for another run/generation is an error. */
export async function recordExecution(input: ExecutionInput, client: Executor = db) {
  const [created] = await client
    .insert(runtimeExecutions)
    .values(input)
    .onConflictDoNothing({ target: [runtimeExecutions.workspaceId, runtimeExecutions.dispatchKey] })
    .returning();
  if (created) return { execution: created, created: true };
  const [existing] = await client
    .select()
    .from(runtimeExecutions)
    .where(and(eq(runtimeExecutions.workspaceId, input.workspaceId), eq(runtimeExecutions.dispatchKey, input.dispatchKey)))
    .limit(1);
  if (!existing || existing.runId !== input.runId || existing.generation !== input.generation) {
    throw new RuntimeConflictError("dispatch_key_mismatch", "dispatch key already belongs to another execution");
  }
  return { execution: existing, created: false };
}

/** Records intent before the provider call. If the process dies after this, the row says "maybe started". */
export async function markDispatching(executionId: string, client: Executor = db) {
  const [row] = await client
    .update(runtimeExecutions)
    .set({ dispatchState: "dispatching", dispatchStartedAt: sql`now()`, updatedAt: sql`now()`, version: sql`${runtimeExecutions.version} + 1` })
    .where(and(eq(runtimeExecutions.id, executionId), eq(runtimeExecutions.dispatchState, "planned")))
    .returning();
  return row ?? null;
}

/** Binds the provider's id once (null to bound). The same id again is a no-op; another id is an error. */
export async function bindProviderExecution(
  input: { workspaceId: string; executionId: string; providerExecutionId: string },
  client: Executor = db,
) {
  const [bound] = await client
    .update(runtimeExecutions)
    .set({
      providerExecutionId: input.providerExecutionId,
      dispatchState: "dispatched",
      dispatchedAt: sql`now()`,
      uncertainSince: null,
      updatedAt: sql`now()`,
      version: sql`${runtimeExecutions.version} + 1`,
    })
    .where(
      and(
        eq(runtimeExecutions.id, input.executionId),
        eq(runtimeExecutions.workspaceId, input.workspaceId),
        isNull(runtimeExecutions.providerExecutionId),
      ),
    )
    .returning();
  if (bound) return bound;
  const [current] = await client.select().from(runtimeExecutions).where(eq(runtimeExecutions.id, input.executionId)).limit(1);
  if (!current) throw new RuntimeConflictError("not_found", "execution not found");
  if (current.providerExecutionId === input.providerExecutionId) return current;
  throw new RuntimeConflictError("execution_already_bound", "execution is already bound to a different provider id");
}

/** The provider call happened (or may have) and its outcome is not known. Not failed, not succeeded. */
export async function markDispatchUnknown(executionId: string, client: Executor = db) {
  const [row] = await client
    .update(runtimeExecutions)
    .set({
      dispatchState: "unknown",
      uncertainSince: sql`coalesce(${runtimeExecutions.uncertainSince}, now())`,
      updatedAt: sql`now()`,
      version: sql`${runtimeExecutions.version} + 1`,
    })
    .where(and(eq(runtimeExecutions.id, executionId), eq(runtimeExecutions.dispatchState, "dispatching")))
    .returning();
  return row ?? null;
}

/** Reconciliation settles an unknown dispatch: either the provider has it (bind) or it does not (rejected). */
export async function reconcileUnknownDispatch(
  input: { workspaceId: string; executionId: string; outcome: { providerExecutionId: string } | { notStarted: true } },
  client: Executor = db,
) {
  if ("providerExecutionId" in input.outcome) {
    const row = await bindProviderExecution(
      { workspaceId: input.workspaceId, executionId: input.executionId, providerExecutionId: input.outcome.providerExecutionId },
      client,
    );
    await client.update(runtimeExecutions).set({ reconciledAt: sql`now()` }).where(eq(runtimeExecutions.id, row.id));
    return row;
  }
  const [row] = await client
    .update(runtimeExecutions)
    .set({ dispatchState: "rejected", reconciledAt: sql`now()`, updatedAt: sql`now()`, version: sql`${runtimeExecutions.version} + 1` })
    .where(and(eq(runtimeExecutions.id, input.executionId), eq(runtimeExecutions.dispatchState, "unknown")))
    .returning();
  return row ?? null;
}

async function assertCurrentGeneration(executionId: string, client: Executor) {
  const [execution] = await client.select().from(runtimeExecutions).where(eq(runtimeExecutions.id, executionId)).limit(1);
  if (!execution) throw new RuntimeConflictError("not_found", "execution not found");
  const [{ latest }] = await client
    .select({ latest: max(runtimeExecutions.generation) })
    .from(runtimeExecutions)
    .where(eq(runtimeExecutions.runId, execution.runId));
  if ((latest ?? 0) !== execution.generation) {
    throw new RuntimeConflictError("stale_generation", "execution generation is no longer the run's current generation");
  }
  return execution;
}

// ---------------------------------------------------------------------------
// Signals

/**
 * Registers a logical signal once. The same key with the same payload returns
 * the existing row; the same key with a different payload fails. Signals to a
 * superseded generation are refused.
 */
export async function recordSignal(
  input: { workspaceId: string; executionId: string; signalKey: string; signalType: string; payload: unknown; payloadRevision?: number },
  client: Executor = db,
) {
  await assertCurrentGeneration(input.executionId, client);
  const payloadHash = await hashCanonical(input.payload);
  const payloadRevision = input.payloadRevision ?? 1;
  const [created] = await client
    .insert(runtimeSignals)
    .values({
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      signalKey: input.signalKey,
      signalType: input.signalType,
      payloadRevision,
      payloadHash,
    })
    .onConflictDoNothing({ target: [runtimeSignals.executionId, runtimeSignals.signalKey] })
    .returning();
  if (created) return { signal: created, created: true };
  const [existing] = await client
    .select()
    .from(runtimeSignals)
    .where(and(eq(runtimeSignals.executionId, input.executionId), eq(runtimeSignals.signalKey, input.signalKey)))
    .limit(1);
  if (!existing || existing.payloadHash !== payloadHash || existing.payloadRevision !== payloadRevision) {
    throw new RuntimeConflictError("signal_payload_mismatch", "signal key already used with a different payload");
  }
  return { signal: existing, created: false };
}

/** Counts an attempt before the send, so a crash mid-send leaves a visible attempt rather than none. */
export async function beginSignalAttempt(signalId: string, client: Executor = db) {
  const [row] = await client
    .update(runtimeSignals)
    .set({ status: "sending", attempts: sql`${runtimeSignals.attempts} + 1`, lastAttemptAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(runtimeSignals.id, signalId), sql`${runtimeSignals.status} in ('pending', 'failed', 'unknown')`))
    .returning();
  return row ?? null;
}

export async function settleSignal(
  input: { signalId: string; status: "delivered" | "failed" | "unknown"; redactedError?: string; reconcileNote?: string },
  client: Executor = db,
) {
  const [row] = await client
    .update(runtimeSignals)
    .set({
      status: input.status,
      deliveredAt: input.status === "delivered" ? sql`now()` : undefined,
      redactedError: input.redactedError ?? null,
      reconciledAt: input.reconcileNote ? sql`now()` : undefined,
      reconcileNote: input.reconcileNote,
      updatedAt: sql`now()`,
    })
    .where(eq(runtimeSignals.id, input.signalId))
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Tool invocations

/**
 * Claims a tool invocation identity. `replay` is true when it already exists
 * with the same arguments, so the caller reads the stored state instead of
 * running the tool again. Different arguments under the same identity fail.
 */
export async function beginInvocation(
  input: {
    workspaceId: string;
    runId: string;
    executionId?: string | null;
    invocationId: string;
    toolName: string;
    accountAlias?: string | null;
    effectClass?: EffectClass;
    args: unknown;
  },
  client: Executor = db,
) {
  const argumentsHash = await hashCanonical(input.args);
  const [created] = await client
    .insert(toolInvocations)
    .values({
      workspaceId: input.workspaceId,
      runId: input.runId,
      executionId: input.executionId ?? null,
      invocationId: input.invocationId,
      toolName: input.toolName,
      accountAlias: input.accountAlias ?? null,
      effectClass: input.effectClass ?? "read",
      argumentsHash,
      redactedArguments: redactForStorage(input.args),
    })
    .onConflictDoNothing({ target: [toolInvocations.runId, toolInvocations.invocationId] })
    .returning();
  if (created) return { invocation: created, replay: false };
  const [existing] = await client
    .select()
    .from(toolInvocations)
    .where(and(eq(toolInvocations.runId, input.runId), eq(toolInvocations.invocationId, input.invocationId)))
    .limit(1);
  if (!existing || existing.argumentsHash !== argumentsHash || existing.toolName !== input.toolName) {
    throw new RuntimeConflictError("invocation_arguments_mismatch", "invocation id reused with different arguments");
  }
  return { invocation: existing, replay: true };
}

/** Marks the call as about to leave. After this a crash means "unknown", never "not started". */
export async function markInvocationInFlight(id: string, client: Executor = db) {
  const [row] = await client
    .update(toolInvocations)
    .set({ state: "in_flight", startedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(toolInvocations.id, id), eq(toolInvocations.state, "requested")))
    .returning();
  return row ?? null;
}

export async function settleInvocation(
  input: { id: string; state: "succeeded" | "failed" | "unknown"; result?: unknown; errorCode?: string },
  client: Executor = db,
) {
  const [row] = await client
    .update(toolInvocations)
    .set({
      state: input.state,
      redactedResult: input.result === undefined ? undefined : redactForStorage(input.result),
      errorCode: input.errorCode ?? null,
      completedAt: input.state === "unknown" ? undefined : sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(toolInvocations.id, input.id), sql`${toolInvocations.state} not in ('succeeded', 'failed')`))
    .returning();
  return row ?? null;
}
