import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agentRuns, agentSteps } from "@/domains/agents/schema";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { createSitting } from "@/domains/knowledge/sittings";
import { annotateBloom } from "@/domains/knowledge/bloom";
import {
  durableEvents,
  executeCreationRun,
  startCreationRun,
  subscribeRun,
  sweepStrandedCreationRuns,
  type CreationRunDeps,
} from "@/domains/knowledge/sitting-run";
import { isAllowedStageOutcome, type SittingEvent } from "@/domains/knowledge/sitting-events";
import { SittingError } from "@/domains/knowledge/sittings";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The sitting creation run (plan §3, §16.1, §16.4, §16.9) on real Postgres:
 * one concurrent run per sitting, durable allowlisted outcomes only (tokens
 * never persisted), fixture-provider journey to done, and the stranded-run
 * startup sweep.
 *
 * Value: protects=the durable-stream contract journeys rely on;
 * fails_when=a second run starts for one sitting, live tokens reach
 * agent_steps, the fixture journey can't reach done, or stranded runs
 * survive the sweep.
 */

const handle = makeTestDb();
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

const suite = handle ? describe : describe.skip;

// Migration 0262 itself: the one-running-run-per-sitting guard (review F).
const MIGRATION_0262 = readFileSync(
  join(process.cwd(), "src/db/migrations/0262_one_running_creation_run.sql"),
  "utf8",
);

suite("sitting creation run", () => {
  let ws: { userId: string; workspaceId: string };
  let otherWs: { userId: string; workspaceId: string };
  const env = { GENERATION_PROVIDER: "fixture", NODE_ENV: "test" };

  beforeAll(async () => {
    holder.db = handle?.db;
    if (!handle) return;
    // Re-runnable: drop the guard so the real file applies cleanly every run.
    await handle.client.unsafe('DROP INDEX IF EXISTS "agent_runs_one_running_creation_per_sitting";');
    for (const stmt of MIGRATION_0262.split("--> statement-breakpoint")) {
      const sql = stmt.trim();
      if (sql) await handle.client.unsafe(sql);
    }
    const stamp = Date.now();
    ws = await seedWorkspace(handle.db, `sitrun-a-${stamp}`);
    otherWs = await seedWorkspace(handle.db, `sitrun-b-${stamp}`);
  });

  afterAll(async () => {
    await handle?.client.end();
  });

  async function seedCard(title: string, workspaceId = ws.workspaceId) {
    const [card] = await handle!.db.insert(artifacts).values({ workspaceId, kind: "zettel", title }).returning();
    const [version] = await handle!.db.insert(artifactVersions).values({
      workspaceId, artifactId: card.id, versionNumber: 1,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: title }] }] },
      plainText: title,
    }).returning();
    await handle!.db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, card.id));
    return card;
  }

  it("starts one run per sitting and reuses it on a second pause (§16.9)", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, {});
    const card = await seedCard("cap card");
    const first = await startCreationRun(auth, { sittingId: sitting.id, artifactId: card.id }, env);
    expect(first.reused).toBe(false);
    const second = await startCreationRun(auth, { sittingId: sitting.id, artifactId: card.id }, env);
    expect(second.reused).toBe(true);
    expect(second.runId).toBe(first.runId);
  });

  it("two concurrent pauses start exactly one run - the unique index is the guard (review F)", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, { topic: "race" });
    const card = await seedCard("raced idea");
    const [a, b] = await Promise.all([
      startCreationRun(auth, { sittingId: sitting.id, artifactId: card.id }, env),
      startCreationRun(auth, { sittingId: sitting.id, artifactId: card.id }, env),
    ]);
    expect(a.runId).toBe(b.runId);
    expect(a.reused || b.reused).toBe(true);
    const runs = await handle!.db
      .select()
      .from(agentRuns)
      .where(and(
        eq(agentRuns.workspaceId, ws.workspaceId),
        eq(agentRuns.state, "running"),
        sql`${agentRuns.subjects} @> ${JSON.stringify([{ sittingId: sitting.id }])}::jsonb`,
      ));
    expect(runs).toHaveLength(1);
  });

  it("rejects a foreign-workspace sitting or artifact with the typed error", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const foreignSitting = await createSitting(ownerAuth(otherWs.userId, otherWs.workspaceId), {});
    const card = await seedCard("mine");
    try {
      await startCreationRun(auth, { sittingId: foreignSitting.id, artifactId: card.id }, env);
      expect.unreachable();
    } catch (err) {
      expect((err as SittingError).code).toBe("ARTIFACT_WORKSPACE_MISMATCH");
    }
    const sitting = await createSitting(auth, {});
    const foreignCard = await seedCard("theirs", otherWs.workspaceId);
    try {
      await startCreationRun(auth, { sittingId: sitting.id, artifactId: foreignCard.id }, env);
      expect.unreachable();
    } catch (err) {
      expect((err as SittingError).code).toBe("ARTIFACT_WORKSPACE_MISMATCH");
    }
  });

  it("runs the fixture journey to done: durable allowlisted outcomes, live-only tokens", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, { topic: "garden" });
    const card = await seedCard("a load-bearing idea");
    const { runId } = await startCreationRun(auth, { sittingId: sitting.id, artifactId: card.id }, env);

    const live: SittingEvent[] = [];
    const unsubscribe = subscribeRun(runId, (e) => live.push(e));
    await executeCreationRun(auth, { runId, sittingId: sitting.id, artifactId: card.id }, env);
    unsubscribe();

    const [run] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.state).toBe("succeeded");
    // Review: the replay cursor tracks the highest committed step exactly -
    // never below it for the sweep to reuse a sequence.
    const [maxStep] = await handle!.db.select({ max: sql<number>`max(${agentSteps.sequence})` }).from(agentSteps).where(eq(agentSteps.runId, runId));
    expect(run.lastEventSeq).toBe(maxStep.max);

    const steps = await handle!.db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(agentSteps.sequence);
    const summaries = steps.map((s) => s.summary).filter((s): s is string => s !== null);
    expect(summaries).toContain("saved");
    expect(summaries).toContain("enriched");
    // §6: the Bloom stage annotates and reports its allowlisted outcome.
    expect(summaries).toContain("bloom:2");
    // §15.2: every persisted outcome is inside the allowlist.
    for (const summary of summaries) expect(isAllowedStageOutcome(summary), summary).toBe(true);
    // §3: tokens/thinking stream live but are NEVER persisted.
    const durableEvents = steps.map((s) => (s.payload as { event?: string } | null)?.event);
    expect(durableEvents).not.toContain("token");
    expect(durableEvents).not.toContain("thinking");
    expect(durableEvents).toContain("card_saved");
    expect(durableEvents).toContain("done");
    // The fixture streamed live events to the attached subscriber.
    expect(live.some((e) => e.event === "thinking")).toBe(true);
    expect(live.some((e) => e.event === "token")).toBe(true);
    expect(live.some((e) => e.event === "enrichment")).toBe(true);
    const suggestion = live.find((e) => e.event === "enrichment")?.payload as { suggestion?: string };
    expect(suggestion.suggestion).toContain("fixture suggestion");

    // §6 + §16.8: the annotation landed in the bloom namespace with model,
    // prompt version and artifact version - and it is never mastery.
    const [annotated] = await handle!.db.select().from(artifacts).where(eq(artifacts.id, card.id));
    const metadata = annotated.metadata as { bloom?: { level: number; levelName: string; model: string; promptVersion: string; artifactVersionNumber: number; source: string } } | null;
    expect(metadata?.bloom?.level).toBe(2);
    expect(metadata?.bloom?.levelName).toBe("Apply");
    expect(metadata?.bloom?.model).toBe("fixture:e2e");
    expect(metadata?.bloom?.promptVersion).toBe("bloom-practice-v1");
    expect(metadata?.bloom?.artifactVersionNumber).toBe(1);
    expect(metadata?.bloom?.source).toBe("creation-run");
  });

  it("stops execution when the owning connection aborts (§16.1, review A)", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, { topic: "dropped" });
    const card = await seedCard("connection drops mid-run");
    const { runId } = await startCreationRun(auth, { sittingId: sitting.id, artifactId: card.id }, env);

    // Abort as soon as the first durable event lands (card_saved): every
    // later stage boundary must observe the abort and stop.
    const controller = new AbortController();
    const unsubscribe = subscribeRun(runId, (e) => {
      if (e.event === "card_saved") controller.abort();
    });
    await executeCreationRun(auth, { runId, sittingId: sitting.id, artifactId: card.id, signal: controller.signal }, env);
    unsubscribe();

    const [run] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    // Interrupted, never succeeded: the sweep contract stays honest.
    expect(run.state).toBe("failed");
    expect(run.error).toContain("interrupted");
    const steps = await handle!.db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(agentSteps.sequence);
    const events = steps.map((s) => (s.payload as { event?: string } | null)?.event);
    expect(events).toContain("card_saved");
    expect(events).not.toContain("done");
  });

  it("bloom annotation merges by namespace and never bumps updated_at (§16.8)", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const card = await seedCard("namespace target");
    // A neighboring namespace written first must survive the bloom write.
    await handle!.db.update(artifacts).set({ metadata: { dismissedCandidates: ["x"] } }).where(eq(artifacts.id, card.id));
    const [before] = await handle!.db.select().from(artifacts).where(eq(artifacts.id, card.id));
    const annotation = {
      level: 1 as const, levelName: "Recall", rationale: "test", source: "creation-run" as const,
      model: "fixture:e2e", promptVersion: "bloom-practice-v1", artifactVersionNumber: 1,
      annotatedAt: new Date().toISOString(),
    };
    await annotateBloom(auth, { artifactId: card.id, annotation });
    const [after] = await handle!.db.select().from(artifacts).where(eq(artifacts.id, card.id));
    const metadata = after.metadata as { bloom?: unknown; dismissedCandidates?: string[] } | null;
    expect(metadata?.bloom).toMatchObject({ level: 1, levelName: "Recall" });
    expect(metadata?.dismissedCandidates).toEqual(["x"]); // merge by namespace, not whole-object write
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime()); // the drizzle trap: no human-edit bump
  });

  it("a quota-refused run never calls the provider: enrich reports QUOTA_UNAVAILABLE (§16.4, review)", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, { topic: "quota" });
    const card = await seedCard("quota-gated idea");
    // Admission refused (exhausted allowance) is recorded on the run row at
    // insert (policy snapshots are update-frozen by migration 0150).
    const { ensureProfile } = await import("@/domains/agents/commands");
    const profileId = await ensureProfile(auth.workspaceId, "polymath");
    const [runRow] = await handle!.db.insert(agentRuns).values({
      workspaceId: auth.workspaceId,
      agentProfileId: profileId,
      objective: "zettel-sitting-creation",
      subjects: [{ sittingId: sitting.id, artifactId: card.id }],
      state: "running",
      startedAt: new Date(),
      policySnapshot: { source: "zettel-sitting-creation", quota: { admitted: false, provider: "gemini" } },
    }).returning({ id: agentRuns.id });
    const runId = runRow.id;

    let embedCalled = 0;
    await executeCreationRun(auth, { runId, sittingId: sitting.id, artifactId: card.id }, env, {
      embedArtifact: (async () => { embedCalled += 1; return { status: "failed" as const, error: "x" }; }) as never,
      materializeSemanticEdges: (async () => 0) as never,
    });

    const steps = await handle!.db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(agentSteps.sequence);
    const events = steps.map((s) => (s.payload as { event?: string } | null)?.event);
    // Track A still ran; generation did not.
    expect(embedCalled).toBe(1);
    expect(events).not.toContain("enrichment");
    expect(events).not.toContain("bloom_suggested");
    const quotaFailure = steps.find((s) => (s.payload as { stage?: string; code?: string } | null)?.code === "QUOTA_UNAVAILABLE");
    expect((quotaFailure?.payload as { stage?: string })?.stage).toBe("enrich");
    expect(quotaFailure?.summary).toBe("failed:enrich");
  });

  it("a hung stage trips the watchdog: the run fails stalled instead of succeeding silently (§16.9, review)", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, { topic: "stall" });
    const card = await seedCard("stalled idea");
    const { runId } = await startCreationRun(auth, { sittingId: sitting.id, artifactId: card.id }, env);

    await executeCreationRun(auth, { runId, sittingId: sitting.id, artifactId: card.id }, env, {
      // Never resolves: without the watchdog this run would hang, then
      // "succeed" with no durable event for the whole window.
      embedArtifact: (() => new Promise(() => {})) as never,
      materializeSemanticEdges: (async () => 0) as never,
      deadlineMs: 50,
    });

    const [run] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.state).toBe("failed");
    const steps = await handle!.db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(agentSteps.sequence);
    const stall = steps.find((s) => (s.payload as { code?: string } | null)?.code === "RUN_STALLED");
    expect((stall?.payload as { stage?: string })?.stage).toBe("run");
    expect(stall?.summary).toBe("failed:stalled");
    expect(isAllowedStageOutcome(stall!.summary!)).toBe(true);
  });

  it("concurrent starts admit quota exactly once - the loser attaches without paying (§16.4, review)", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, { topic: "one admission" });
    const card = await seedCard("admission idea");
    const geminiEnv = { GENERATION_PROVIDER: "gemini", GEMINI_API_KEY: "g", NODE_ENV: "test" };
    const [a, b] = await Promise.all([
      startCreationRun(auth, { sittingId: sitting.id, artifactId: card.id }, geminiEnv),
      startCreationRun(auth, { sittingId: sitting.id, artifactId: card.id }, geminiEnv),
    ]);
    expect(a.runId).toBe(b.runId);
    expect([a.reused, b.reused].sort()).toEqual([false, true]);
    // The winner's unit settles (consumed); the loser's reservation is
    // released untouched - one run's work costs one unit, never two.
    const buckets = await handle!.client.unsafe(
      "select coalesce(sum(consumed), 0)::int as consumed from provider_quota_buckets where workspace_id = $1 and provider = 'gemini'",
      [ws.workspaceId],
    );
    expect(buckets[0].consumed).toBe(1);
    const settled = await handle!.client.unsafe(
      "select count(*)::int as n from provider_usage_ledger where workspace_id = $1 and kind = 'settle'",
      [ws.workspaceId],
    );
    expect(settled[0].n).toBe(1);
  });

  it("sweeps stranded running creation runs with a stage_failed outcome (§16.1)", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, {});
    const card = await seedCard("stranded card");
    const { runId } = await startCreationRun(auth, { sittingId: sitting.id, artifactId: card.id }, env);
    // Age the run past the threshold; the sweep must fail it with the
    // allowlisted interrupted outcome.
    await handle!.db.update(agentRuns).set({ startedAt: new Date(Date.now() - 11 * 60 * 1000) }).where(eq(agentRuns.id, runId));
    const swept = await sweepStrandedCreationRuns();
    expect(swept).toBeGreaterThanOrEqual(1);
    const [run] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.state).toBe("failed");
    const steps = await handle!.db.select().from(agentSteps).where(eq(agentSteps.runId, runId));
    const failure = steps.find((s) => s.summary === "failed:interrupted");
    expect(failure).toBeDefined();
    const payload = failure!.payload as { stage: string; code: string; message: string; operationId: string };
    expect(payload.code).toBe("RUN_INTERRUPTED");
    expect(payload.operationId).toBe(runId);
    expect(payload.message).toBe("Run interrupted - retry to finish enrichment.");
    // A fresh running run is NOT swept.
    const card2 = await seedCard("fresh card");
    const sitting2 = await createSitting(auth, {});
    const fresh = await startCreationRun(auth, { sittingId: sitting2.id, artifactId: card2.id }, env);
    expect(await sweepStrandedCreationRuns()).toBe(0);
    const [freshRun] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, fresh.runId));
    expect(freshRun.state).toBe("running");
  });

  it("records skipped:edited when the card moved mid-run (edit-during-enrichment, §11)", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, {});
    const card = await seedCard("edited mid-run");
    const { runId } = await startCreationRun(auth, { sittingId: sitting.id, artifactId: card.id }, env);
    // The embed pass finds the artifact's version has moved since it started:
    // the donor's version-guard semantics preserved (§15.10).
    const deps: CreationRunDeps = {
      embedArtifact: async () => ({ status: "skipped", reason: "edited" }),
      materializeSemanticEdges: async () => 0,
    };
    await executeCreationRun(auth, { runId, sittingId: sitting.id, artifactId: card.id }, env, deps);
    const steps = await handle!.db.select().from(agentSteps).where(eq(agentSteps.runId, runId));
    const summaries = steps.map((s) => s.summary);
    expect(summaries).toContain("skipped:edited");
    expect(summaries).not.toContain("failed:embed");
    // Sibling stages still ran: one skip never blocks Track B (§14.4).
    expect(summaries).toContain("enriched");
  });

  it("replays the durable record from a cursor after a drop (§16.1) and persists no credentials (§15.9)", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, {});
    const card = await seedCard("replay card");
    const { runId } = await startCreationRun(auth, { sittingId: sitting.id, artifactId: card.id }, env);
    await executeCreationRun(auth, { runId, sittingId: sitting.id, artifactId: card.id }, env);

    // Connection dropped after commit: the replay from 0 carries every
    // durable event, in order; from a mid cursor only the tail.
    const all = await durableEvents(auth, runId, 0);
    expect(all.length).toBeGreaterThanOrEqual(3);
    const seqs = all.map((s) => s.sequence);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    const mid = seqs[Math.floor(seqs.length / 2)]!;
    const tail = await durableEvents(auth, runId, mid);
    expect(tail.length).toBe(all.length - all.filter((s) => s.sequence <= mid).length);
    expect(tail.every((s) => s.sequence > mid)).toBe(true);

    // §15.9: no credential markers anywhere in the persisted record.
    const steps = await handle!.db.select().from(agentSteps).where(eq(agentSteps.runId, runId));
    const serialized = JSON.stringify(steps);
    for (const marker of ["CLOUDFLARE_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "Bearer ", "authorization"]) {
      expect(serialized.includes(marker), marker).toBe(false);
    }
  });
});
