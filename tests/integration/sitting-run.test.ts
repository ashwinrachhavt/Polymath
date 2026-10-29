import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agentRuns, agentSteps } from "@/domains/agents/schema";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { createSitting } from "@/domains/knowledge/sittings";
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

    const steps = await handle!.db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(agentSteps.sequence);
    const summaries = steps.map((s) => s.summary).filter((s): s is string => s !== null);
    expect(summaries).toContain("saved");
    expect(summaries).toContain("enriched");
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
