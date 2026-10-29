import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AuthContext } from "@/domains/identity/resolve";
import { ensureProfile } from "@/domains/agents/commands";
import { agentRuns, agentSteps } from "@/domains/agents/schema";
import { generationProvider, GenerationUnconfiguredError, GENERATION_TIMEOUT_MS, metered, type GenerationProvider } from "@/integrations/generation/provider";
import { providerEntry } from "@/integrations/providers/registry";
import { drizzleQuotaStore, QuotaExhaustedError, withQuota } from "@/integrations/providers/quota";
import { artifacts, artifactVersions } from "./schema";
import { embedArtifact } from "./embedding";
import { materializeSemanticEdges } from "./relations";
import { artifactWorkspaceMismatch, getSitting } from "./sittings";
import {
  assertEventRedacted,
  isAllowedStageOutcome,
  SITTING_PROTOCOL_VERSION,
  type SittingEvent,
} from "./sitting-events";

/*
 * The sitting creation run (plan 2026-10-29 §3, §16.1): a real agent_runs row
 * whose AI work executes IN-PROCESS within the originating stream
 * connection's lifetime. There is no server-side continuation across
 * disconnects; a reconnect attaches to the run's durable events only
 * (allowlisted stage outcomes on agent_steps), replayed by cursor. Live
 * token/thinking events are never persisted (§3: no transcripts on reopen).
 *
 * Stage pipeline after save: Track A = embed + link discovery, Track B =
 * analysis + enrichment, concurrent; one stage's failure never blocks a
 * sibling. Version-guarded throughout via embedArtifact's skipped:edited /
 * skipped:busy semantics.
 */

/** §16.1: a running creation run older than this with no live connection is stranded. */
export const STRANDED_RUN_AGE_MS = 10 * 60 * 1000;

/** §16.9: 30s without a durable event ends the stream with stage_failed. */
export const NO_DURABLE_EVENT_DEADLINE_MS = GENERATION_TIMEOUT_MS;

const CREATION_OBJECTIVE = "zettel-sitting-creation";
const SITTING_SYSTEM_PROMPT =
  "You are assisting a zettel sitting: the writer pauses and you suggest one connection or sharpening for their draft, briefly.";

/** Quota-unavailable copy is the §15.3 contract, verbatim. */
export const QUOTA_UNAVAILABLE_MESSAGE =
  "Link discovery needs AI quota — your card is saved. Add credits or ask an admin to raise the quota, then retry indexing.";

export type SittingRun = { runId: string; reused: boolean };

/**
 * Start (or reuse) the sitting's creation run. §16.9: one concurrent
 * creation run per sitting - a new pause reuses the open run. §16.4: quota
 * admission happens once HERE, per run, never per stream attach.
 */
export async function startCreationRun(
  auth: AuthContext,
  input: { sittingId: string; artifactId: string },
  env: Record<string, string | undefined> = process.env,
): Promise<SittingRun> {
  const sitting = await getSitting(auth, input.sittingId);
  if (!sitting) throw artifactWorkspaceMismatch();
  const [card] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!card) throw artifactWorkspaceMismatch();

  const [existing] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(
      eq(agentRuns.workspaceId, auth.workspaceId),
      eq(agentRuns.objective, CREATION_OBJECTIVE),
      eq(agentRuns.state, "running"),
      sql`${agentRuns.subjects} @> ${JSON.stringify([{ sittingId: input.sittingId }])}::jsonb`,
    ))
    .limit(1);
  if (existing) return { runId: existing.id, reused: true };

  const profileId = await ensureProfile(auth.workspaceId, "polymath");

  // §16.4: one operation admission per run, cached on the run row's policy
  // snapshot; a reconnect attaches to durable events and never re-admits. An
  // exhausted allowance does not block the run: writing is preserved and the
  // generation stages report QUOTA_UNAVAILABLE (§15.3) while Track A runs.
  let quota: { admitted: boolean; provider?: string } = { admitted: false };
  // Frozen-model contract: the resolved provider's "registry:model" name is
  // pinned on the run row at start, not only inside the quota snapshot.
  let model: string | null = null;
  try {
    const provider = generationProvider(env);
    model = provider.name;
    const entry = providerEntry(provider.registryId);
    if (entry?.quota && entry.enabled) {
      // One operation admission per run in the provider's own unit; the
      // no-op settles the reservation immediately (per-call usage accounting
      // rides metered() during execution).
      await withQuota(drizzleQuotaStore(), entry, auth.workspaceId, 1, async () => null);
    }
    quota = { admitted: true, provider: provider.registryId };
  } catch (cause) {
    if (cause instanceof QuotaExhaustedError) {
      quota = { admitted: false, provider: cause.provider };
    } else if (cause instanceof GenerationUnconfiguredError) {
      quota = { admitted: false };
    } else {
      throw cause;
    }
  }

  try {
    const [run] = await db
      .insert(agentRuns)
      .values({
        workspaceId: auth.workspaceId,
        agentProfileId: profileId,
        objective: CREATION_OBJECTIVE,
        subjects: [{ sittingId: input.sittingId, artifactId: input.artifactId }],
        state: "running",
        startedAt: new Date(),
        model,
        policySnapshot: { source: "zettel-sitting-creation", quota },
      })
      .returning({ id: agentRuns.id });
    return { runId: run.id, reused: false };
  } catch (cause) {
    // Review F: the pre-check above is the fast path; migration 0262's
    // partial unique index is the guard. A concurrent POST that loses the
    // race attaches to the winner's run - never a second execution.
    if (isUniqueViolation(cause)) {
      const [winner] = await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(
          eq(agentRuns.workspaceId, auth.workspaceId),
          eq(agentRuns.objective, CREATION_OBJECTIVE),
          eq(agentRuns.state, "running"),
          sql`${agentRuns.subjects} @> ${JSON.stringify([{ sittingId: input.sittingId }])}::jsonb`,
        ))
        .limit(1);
      if (winner) return { runId: winner.id, reused: true };
    }
    throw cause;
  }
}

/** Postgres 23505, through either the postgres.js error or a drizzle wrapper. */
function isUniqueViolation(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "23505";
}

type RunContext = {
  runId: string;
  sittingId: string;
  artifactId: string;
  /** The owning connection's lifetime (§16.1): when it aborts, execution stops. */
  signal?: AbortSignal;
};

/*
 * The per-run live bus: subscribers are the open stream connections. Durable
 * events are written to agent_steps FIRST and only then fanned out live, so a
 * connected client never sees an event the record lacks (§3: durable success
 * events emitted after commit).
 */
const liveSubscribers = new Map<string, Set<(event: SittingEvent) => void>>();

export function subscribeRun(runId: string, subscriber: (event: SittingEvent) => void): () => void {
  let set = liveSubscribers.get(runId);
  if (!set) liveSubscribers.set(runId, (set = new Set()));
  set.add(subscriber);
  return () => {
    set.delete(subscriber);
    if (set.size === 0) liveSubscribers.delete(runId);
  };
}

/** Durable events for a cursor replay, oldest first (§16.1: allowlisted only). */
export async function durableEvents(auth: AuthContext, runId: string, afterSeq: number) {
  const steps = await db
    .select({ sequence: agentSteps.sequence, summary: agentSteps.summary, payload: agentSteps.payload })
    .from(agentSteps)
    .where(and(eq(agentSteps.runId, runId), eq(agentSteps.workspaceId, auth.workspaceId), sql`${agentSteps.sequence} > ${afterSeq}`))
    .orderBy(agentSteps.sequence);
  return steps;
}

async function persistEvent(
  auth: AuthContext,
  ctx: RunContext,
  seqState: { next: number },
  event: SittingEvent,
  outcome: string | null,
): Promise<void> {
  assertEventRedacted(event);
  if (outcome !== null && !isAllowedStageOutcome(outcome)) {
    throw new Error(`stage outcome outside the §15.2 allowlist: ${outcome}`);
  }
  const sequence = seqState.next++;
  await db.insert(agentSteps).values({
    workspaceId: auth.workspaceId,
    runId: ctx.runId,
    sequence,
    kind: "artifact",
    summary: outcome,
    payload: {
      event: event.event,
      ...(event.artifactId ? { artifactId: event.artifactId } : {}),
      ...(event.artifactVersionId ? { artifactVersionId: event.artifactVersionId } : {}),
      ...(typeof event.payload === "object" && event.payload !== null ? event.payload as Record<string, unknown> : {}),
    },
  });
  await db.update(agentRuns).set({ lastEventSeq: sequence }).where(eq(agentRuns.id, ctx.runId));
  for (const sub of liveSubscribers.get(ctx.runId) ?? []) sub(event);
}

function emitLive(ctx: RunContext, event: SittingEvent): void {
  assertEventRedacted(event);
  for (const sub of liveSubscribers.get(ctx.runId) ?? []) sub(event);
}

const frame = (ctx: RunContext, event: SittingEvent["event"], payload?: unknown, ids?: { artifactVersionId?: string }): SittingEvent => ({
  protocolVersion: SITTING_PROTOCOL_VERSION,
  operationId: ctx.runId,
  artifactId: ctx.artifactId,
  ...(ids?.artifactVersionId ? { artifactVersionId: ids.artifactVersionId } : {}),
  event,
  payload,
});

/**
 * Execute the run's stage pipeline IN-PROCESS (§16.1). The caller's stream
 * connection owns this execution; when it drops, execution stops and only
 * durable events remain. A new connection attaches to the durable record.
 */
export type CreationRunDeps = {
  embedArtifact: typeof embedArtifact;
  materializeSemanticEdges: typeof materializeSemanticEdges;
};

const defaultDeps: CreationRunDeps = { embedArtifact, materializeSemanticEdges };

export async function executeCreationRun(
  auth: AuthContext,
  ctx: RunContext,
  env: Record<string, string | undefined> = process.env,
  deps: CreationRunDeps = defaultDeps,
): Promise<void> {
  const [run] = await db.select({ lastEventSeq: agentRuns.lastEventSeq }).from(agentRuns).where(eq(agentRuns.id, ctx.runId)).limit(1);
  const seq = { next: (run?.lastEventSeq ?? 0) + 1 };
  // §16.9: 30s without a durable event ends the stream with stage_failed.
  let lastDurableAt = Date.now();
  const durable = async (event: SittingEvent, outcome: string | null) => {
    await persistEvent(auth, ctx, seq, event, outcome);
    lastDurableAt = Date.now();
  };
  // §16.1: the connection owns execution for its lifetime. An aborted
  // request stops the pipeline at the next stage boundary; the run row is
  // marked interrupted, never succeeded, so the sweep contract stays honest.
  const aborted = () => ctx.signal?.aborted ?? false;

  // Stage 0: save-first (§3). The card is already committed by the caller;
  // the run's first durable event names the saved version.
  const [card] = await db
    .select({ id: artifacts.id, currentVersionId: artifacts.currentVersionId, versionNumber: artifactVersions.versionNumber })
    .from(artifacts)
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(and(eq(artifacts.id, ctx.artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!card) {
    await durable(frame(ctx, "stage_failed", { stage: "save", code: "NOT_FOUND", message: "The card is gone; the sitting's writing was not found.", operationId: ctx.runId }), "failed:save");
    await finishRun(ctx.runId, "failed", "card not found");
    return;
  }
  await durable(
    frame(ctx, "card_saved", { outcome: "saved", versionNumber: card.versionNumber }, { artifactVersionId: card.currentVersionId ?? undefined }),
    "saved",
  );

  // Provider selection fails at selection (§15.6), never mid-stream; an
  // unconfigured provider turns Track B into a reported skip, not a failure.
  let provider: GenerationProvider | null = null;
  try {
    provider = generationProvider(env);
  } catch (cause) {
    if (!(cause instanceof GenerationUnconfiguredError)) throw cause;
  }

  const deadlineGuard = () => {
    if (Date.now() - lastDurableAt > NO_DURABLE_EVENT_DEADLINE_MS) {
      throw new Error("creation run produced no durable event within the deadline");
    }
  };

  const trackA = async () => {
    // Stage A1: embed. embedArtifact owns the version guard; its skip reasons
    // map onto the §15.2 outcomes verbatim.
    if (aborted()) return;
    await durable(frame(ctx, "stage_started", { stage: "embed" }), null);
    try {
      deadlineGuard();
      const outcome = await deps.embedArtifact(auth, { artifactId: ctx.artifactId });
      if (outcome.status === "succeeded") {
        const [fresh] = await db
          .select({ versionNumber: artifactVersions.versionNumber })
          .from(artifacts)
          .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
          .where(eq(artifacts.id, ctx.artifactId)).limit(1);
        await durable(frame(ctx, "stage_completed", { stage: "embed", outcome: `embedded:v${fresh?.versionNumber ?? 0}` }), `embedded:v${fresh?.versionNumber ?? 0}`);
      } else if (outcome.status === "skipped" && (outcome.reason === "busy" || outcome.reason === "edited")) {
        // The version guard itself: persisted as its allowlisted outcome.
        await durable(frame(ctx, "stage_completed", { stage: "embed", outcome: `skipped:${outcome.reason}` }), `skipped:${outcome.reason}`);
      } else if (outcome.status === "failed") {
        await durable(frame(ctx, "stage_failed", { stage: "embed", code: "EMBED_FAILED", message: "Indexing this version failed - retry indexing when the provider recovers.", operationId: ctx.runId }), "failed:embed");
      } else {
        // not_found / no_text: nothing to index and nothing mislabeled - a
        // warning event, never a borrowed version-guard outcome.
        await durable(frame(ctx, "warning", { stage: "embed", message: "Nothing to index on this version." }), null);
      }
    } catch {
      await durable(frame(ctx, "stage_failed", { stage: "embed", code: "EMBED_FAILED", message: "Indexing this version failed - retry indexing when the provider recovers.", operationId: ctx.runId }), "failed:embed");
    }

    // Stage A2: link discovery (§5: candidates surfaced, never asserted).
    if (aborted()) return;
    await durable(frame(ctx, "stage_started", { stage: "links" }), null);
    try {
      deadlineGuard();
      const count = await deps.materializeSemanticEdges(auth, ctx.artifactId);
      await durable(frame(ctx, "links_found", { outcome: `links:${count}`, candidates: count }), `links:${count}`);
    } catch (cause) {
      if (cause instanceof QuotaExhaustedError) {
        await durable(frame(ctx, "stage_failed", { stage: "links", code: "QUOTA_UNAVAILABLE", message: QUOTA_UNAVAILABLE_MESSAGE, operationId: ctx.runId }), "failed:links");
      } else {
        await durable(frame(ctx, "stage_failed", { stage: "links", code: "LINKS_FAILED", message: "Link discovery failed - your card is saved; retry indexing.", operationId: ctx.runId }), "failed:links");
      }
    }
  };

  const trackB = async () => {
    if (aborted()) return;
    if (!provider) {
      await durable(frame(ctx, "stage_failed", { stage: "enrich", code: "PROVIDER_UNCONFIGURED", message: "No generation provider is configured, so suggestions did not run - your card is saved.", operationId: ctx.runId }), "failed:enrich");
      return;
    }
    // §16.4: per-call usage rides metered() to the run row; admission already
    // happened once at run start.
    const usage: { model: string; kind: string; inputTokens?: number; outputTokens?: number; durationMs: number }[] = [];
    const meteredProvider = metered(provider, (entry) => { usage.push({ model: entry.model, kind: entry.kind, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, durationMs: entry.durationMs }); });

    await durable(frame(ctx, "stage_started", { stage: "enrich" }), null);
    try {
      deadlineGuard();
      const [version] = await db
        .select({ plainText: artifactVersions.plainText })
        .from(artifactVersions)
        .where(eq(artifactVersions.id, card.currentVersionId ?? ""))
        .limit(1);
      const draft = (version?.plainText ?? "").slice(0, 4000);
      const input = { system: SITTING_SYSTEM_PROMPT, prompt: draft, temperature: 0.3 };
      if (meteredProvider.stream) {
        // Live-only events: thinking/tokens fan out but are never persisted.
        let suggestion = "";
        for await (const chunk of meteredProvider.stream(input)) {
          if (aborted()) return;
          deadlineGuard();
          if (chunk.type === "thinking") emitLive(ctx, frame(ctx, "thinking", { content: chunk.content }));
          else if (chunk.type === "token") { suggestion += chunk.content; emitLive(ctx, frame(ctx, "token", { content: chunk.content })); }
        }
        await durable(frame(ctx, "enrichment", { outcome: "enriched", suggestion }), "enriched");
      } else {
        // Token-less Track B fallback (§8): no stream, one generate, stage
        // outcomes still emit.
        const { text } = await meteredProvider.generate(input);
        await durable(frame(ctx, "enrichment", { outcome: "enriched", suggestion: text }), "enriched");
      }
      for (const u of usage) {
        await db.insert(agentSteps).values({
          workspaceId: auth.workspaceId, runId: ctx.runId, sequence: seq.next++, kind: "model",
          summary: "enriched",
          payload: { event: "usage", model: u.model, kind: u.kind, inputTokens: u.inputTokens, outputTokens: u.outputTokens, durationMs: u.durationMs },
        });
      }
    } catch (cause) {
      if (cause instanceof QuotaExhaustedError) {
        await durable(frame(ctx, "stage_failed", { stage: "enrich", code: "QUOTA_UNAVAILABLE", message: QUOTA_UNAVAILABLE_MESSAGE, operationId: ctx.runId }), "failed:enrich");
      } else {
        await durable(frame(ctx, "stage_failed", { stage: "enrich", code: "ENRICH_FAILED", message: "The suggestion pass failed - your card is saved; retry from the rail.", operationId: ctx.runId }), "failed:enrich");
      }
    }
  };

  // Two concurrent tracks after save (§3); one stage's failure never blocks
  // a sibling (allSettled).
  await Promise.allSettled([trackA(), trackB()]);
  if (aborted()) {
    // The owning connection dropped: the run is interrupted, not done, and a
    // later attach replays the durable record up to the last committed event.
    await finishRun(ctx.runId, "failed", "Run interrupted - retry to finish enrichment.");
    return;
  }
  await durable(frame(ctx, "done", {}), null);
  await finishRun(ctx.runId, "succeeded", null);
}

async function finishRun(runId: string, state: "succeeded" | "failed", error: string | null) {
  await db.update(agentRuns).set({ state, endedAt: new Date(), ...(error ? { error } : {}) }).where(eq(agentRuns.id, runId));
}

/**
 * §16.1 stranded-run startup sweep: a running creation run whose originating
 * connection is long gone is failed with a stage_failed outcome, so the next
 * attach replays a finished record instead of waiting forever. Returns the
 * number of runs swept.
 */
export async function sweepStrandedCreationRuns(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STRANDED_RUN_AGE_MS);
  const stranded = await db
    .select({ id: agentRuns.id, workspaceId: agentRuns.workspaceId, lastEventSeq: agentRuns.lastEventSeq })
    .from(agentRuns)
    .where(and(
      eq(agentRuns.objective, CREATION_OBJECTIVE),
      eq(agentRuns.state, "running"),
      lt(agentRuns.startedAt, cutoff),
    ));
  for (const run of stranded) {
    const sequence = run.lastEventSeq + 1;
    await db.insert(agentSteps).values({
      workspaceId: run.workspaceId,
      runId: run.id,
      sequence,
      kind: "artifact",
      summary: "failed:interrupted",
      payload: { event: "stage_failed", stage: "run", code: "RUN_INTERRUPTED", message: "Run interrupted - retry to finish enrichment.", operationId: run.id },
    });
    await db.update(agentRuns).set({ state: "failed", error: "Run interrupted - retry to finish enrichment.", lastEventSeq: sequence, endedAt: now }).where(eq(agentRuns.id, run.id));
  }
  return stranded.length;
}

/** The run's sitting/artifact subjects, for the stream route's attach check. */
export async function getCreationRun(auth: AuthContext, runId: string) {
  const [run] = await db
    .select({ id: agentRuns.id, state: agentRuns.state, subjects: agentRuns.subjects, lastEventSeq: agentRuns.lastEventSeq, policySnapshot: agentRuns.policySnapshot })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, auth.workspaceId), eq(agentRuns.objective, CREATION_OBJECTIVE)))
    .limit(1);
  return run ?? null;
}

/** Latest creation run for a sitting, for the reconnect path (§14.7). */
export async function latestCreationRun(auth: AuthContext, sittingId: string) {
  const [run] = await db
    .select({ id: agentRuns.id, state: agentRuns.state, lastEventSeq: agentRuns.lastEventSeq })
    .from(agentRuns)
    .where(and(
      eq(agentRuns.workspaceId, auth.workspaceId),
      eq(agentRuns.objective, CREATION_OBJECTIVE),
      sql`${agentRuns.subjects} @> ${JSON.stringify([{ sittingId }])}::jsonb`,
    ))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return run ?? null;
}
