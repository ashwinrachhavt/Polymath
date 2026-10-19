import { z } from "zod";

/*
 * RT02 (ASH-116): the Polymath-owned AgentRuntime contracts. These types are the
 * ONLY shape domain code uses to talk to an execution runtime; the Eve
 * adapter and the fake both implement them, and neither leaks its own types
 * upward. Everything crossing the boundary is zod-validated - a TypeScript
 * type is not a check at the network edge.
 *
 * The three-valued rules that define the contract:
 *  - dispatch is accepted, duplicate, or UNKNOWN - a lost response is never
 *    treated as a failed start;
 *  - reconciliation is found, confirmed-absent, or UNKNOWN - an eventually
 *    consistent empty lookup is never confirmed absence;
 *  - inspection returns observations. Mutating canonical run state from an
 *    observation is the AgentRunService's job, never the runtime's.
 */

export const RUNTIME_CONTRACT_VERSION = 1;

export const runIdentity = z.object({
  contractVersion: z.literal(RUNTIME_CONTRACT_VERSION),
  runId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  /**
   * Which admission of this run the operation belongs to. A retry bumps the
   * generation; callbacks from an older generation must not authorize effects.
   */
  executionGeneration: z.number().int().positive(),
});
export type RunIdentity = z.infer<typeof runIdentity>;

export const capabilityGrant = z.object({
  grantId: z.string().uuid(),
  profileRevision: z.number().int().positive(),
  allowedOperations: z.array(z.string().min(1)).min(1),
  allowedResources: z.array(z.string().min(1)).optional(),
  allowedAccounts: z.array(z.string().uuid()).optional(),
  expiresAt: z.string().datetime(),
  delegationDepth: z.number().int().min(0).max(3).default(0),
});
export type CapabilityGrant = z.infer<typeof capabilityGrant>;

export const spendReservation = z.object({
  reservationId: z.string().uuid(),
  currency: z.literal("USD"),
  maxUnits: z.string().regex(/^\d+(\.\d{1,4})?$/),
});
export type SpendReservation = z.infer<typeof spendReservation>;

export const runtimeLimits = z.object({
  maxRuntimeSeconds: z.number().int().positive().max(86_400),
  maxToolCalls: z.number().int().positive().max(10_000),
  maxTokens: z.number().int().positive().optional(),
});
export type RuntimeLimits = z.infer<typeof runtimeLimits>;

export const runtimeStartRequest = z.object({
  identity: runIdentity,
  /**
   * Stable across retries of the same admission: the runtime dedupes on it,
   * so a retried start cannot admit two sessions. Same shape the outbox
   * dispatcher uses (workspace + purpose-scoped string).
   */
  dispatchKey: z.string().min(1).max(200),
  objective: z.string().min(1).max(20_000),
  profileRef: z.object({ profileId: z.string().uuid(), revision: z.number().int().positive() }),
  contextRef: z.object({ manifestId: z.string().uuid() }).optional(),
  grant: capabilityGrant,
  reservation: spendReservation,
  limits: runtimeLimits,
});
export type RuntimeStartRequest = z.infer<typeof runtimeStartRequest>;

export const runtimeSignal = z.object({
  identity: runIdentity,
  /** Durable: re-delivering the same signalId is a duplicate, never a second effect. */
  signalId: z.string().uuid(),
  kind: z.enum(["user_input", "approval", "cancellation", "resume"]),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type RuntimeSignal = z.infer<typeof runtimeSignal>;

/** Dispatch outcomes. `unknown` means the response was lost: reconcile, don't assume. */
export type StartOutcome =
  | { kind: "accepted"; runtimeRef: string; acceptedAt: string }
  | { kind: "duplicate"; runtimeRef: string }
  | { kind: "unknown"; detail?: string };

export type SignalOutcome =
  | { kind: "delivered" }
  | { kind: "duplicate" }
  | { kind: "unknown"; detail?: string };

export type CancelOutcome =
  | { kind: "cancelled" }
  | { kind: "already-terminal" }
  | { kind: "unknown"; detail?: string };

export const runtimePhase = z.enum([
  "starting",
  "running",
  "waiting_input",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
]);
export type RuntimePhase = z.infer<typeof runtimePhase>;

export const runtimeObservation = z.object({
  identity: runIdentity,
  runtimeRef: z.string(),
  phase: runtimePhase,
  /** Output is exposed separately from phase: completed is not validated. */
  output: z.string().nullable(),
  /** Redacted detail only - never a raw provider payload. */
  detail: z.string().nullable(),
  observedAt: z.string().datetime(),
});
export type RuntimeObservation = z.infer<typeof runtimeObservation>;

/** Reconciliation of a start whose response was lost. */
export type StartReconciliation =
  | { kind: "found"; observation: RuntimeObservation }
  | { kind: "confirmed-absent" }
  | { kind: "unknown"; detail?: string };

/**
 * The port. Implementations: the programmable fake (tests, contract suite) and
 * the Eve adapter (ASH-119). Runtime inspection returns observations, never
 * direct domain mutations.
 */
export interface AgentRuntime {
  start(request: RuntimeStartRequest): Promise<StartOutcome>;
  signal(signal: RuntimeSignal): Promise<SignalOutcome>;
  inspect(identity: RunIdentity): Promise<StartReconciliation>;
  reconcileStart(identity: RunIdentity, dispatchKey: string): Promise<StartReconciliation>;
  cancel(identity: RunIdentity): Promise<CancelOutcome>;
}
