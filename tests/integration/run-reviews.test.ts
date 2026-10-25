import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxEvents } from "@/domains/audit/schema";
import { agentRuns, runReviews } from "@/domains/agents/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-304 against real Postgres: a succeeded run's close enqueues exactly one
 * critique request; the critique pass stores one capped proposal with the
 * run's provenance and its audit row, fails without a partial row, and skips
 * silently when no provider is configured; the operator's verdict is one row
 * per run across set, switch and clear, with an audit row per flip; a run
 * from another workspace answers not-found.
 *
 * Import discipline mirrors the other suites: anything reaching @/lib/db is
 * lazy-imported after makeTestDb points DATABASE_URL at the scratch database.
 * A fake SessionDriver stands in for Eve; the generation provider is mocked
 * module-level like capture-enrichment.test.ts does.
 */

const generate = vi.fn();

vi.mock("@/integrations/generation/provider", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/integrations/generation/provider")>();
  return {
    ...original,
    generationProvider: vi.fn(() => ({
      name: "test:model",
      registryId: "test",
      generate: (...args: unknown[]) => generate(...(args as [])),
    })),
  };
});

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let onboarding: typeof import("@/domains/agents/onboarding");
let eventBridge: typeof import("@/domains/agents/event-bridge");
let reviews: typeof import("@/domains/agents/run-reviews");
let critique: typeof import("@/domains/agents/critique");
let providerModule: typeof import("@/integrations/generation/provider");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  onboarding = await import("@/domains/agents/onboarding");
  eventBridge = await import("@/domains/agents/event-bridge");
  reviews = await import("@/domains/agents/run-reviews");
  critique = await import("@/domains/agents/critique");
  providerModule = await import("@/integrations/generation/provider");
});

afterAll(async () => {
  await handle?.client.end();
});

beforeEach(() => {
  generate.mockReset();
  vi.mocked(providerModule.generationProvider).mockReset();
  vi.mocked(providerModule.generationProvider).mockImplementation(() => ({
    name: "test:model",
    registryId: "test",
    generate: (...args: unknown[]) => generate(...(args as [])),
  }) as never);
});

function fakeDriver() {
  return {
    async start(input: { sessionId: string }) {
      await db
        .update(agentRuns)
        .set({ sessionRef: `wrun_rr_${input.sessionId.slice(0, 8)}` })
        .where(eq(agentRuns.id, input.sessionId));
    },
    async signal() {},
    async cancel() {},
  };
}

/** A fresh succeeded run, closed through the real close path. */
async function succeededRun(slug: string) {
  const seeded = await seedWorkspace(db, `rr-${slug}-${Date.now()}`);
  const auth = ownerAuth(seeded.userId, seeded.workspaceId);
  const started = await onboarding.startOnboardingRun(auth, fakeDriver());
  await eventBridge.closeRun({
    workspaceId: seeded.workspaceId,
    runId: started.runId,
    state: "succeeded",
    summary: "Interviewed the owner and proposed a brief.",
  });
  return { ...seeded, auth, runId: started.runId };
}

function critiqueHandler() {
  return critique.runCritiqueRequestedHandler(async (workspaceId) => {
    const rows = await db.execute(
      sql`select user_id from memberships where workspace_id = ${workspaceId} and role = 'owner' and status = 'active' limit 1`,
    );
    const row = (rows as unknown as { user_id: string }[])[0];
    return row ? ownerAuth(row.user_id, workspaceId) : null;
  });
}

async function runCritiqueEvent(workspaceId: string, runId: string) {
  const events = await db
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, "run.critique_requested")));
  const event = events.find((e) => (e.payload as { runId: string }).runId === runId);
  if (!event) throw new Error("no critique event enqueued");
  await critiqueHandler()({
    id: event.id,
    workspaceId,
    topic: event.topic,
    payload: event.payload,
  } as Parameters<ReturnType<typeof critique.runCritiqueRequestedHandler>>[0]);
}

async function auditActions(workspaceId: string): Promise<string[]> {
  const rows = await db.execute(
    sql`select action from audit_events where workspace_id = ${workspaceId} order by created_at`,
  );
  return (rows as unknown as { action: string }[]).map((r) => r.action);
}

suite("run reviews", () => {
  it("a succeeded close enqueues exactly one critique request; other closes none", async () => {
    const { workspaceId, runId } = await succeededRun("enqueue");

    const events = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, "run.critique_requested")));
    expect(events).toHaveLength(1);
    expect(events[0].dispatchKey).toBe(runId);

    // A second close matches no active run: no state flip, no second event.
    const again = await eventBridge.closeRun({ workspaceId, runId, state: "succeeded" });
    expect(again.closed).toBe(false);
    const after = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, "run.critique_requested")));
    expect(after).toHaveLength(1);

    // A failed run asks for no critique.
    const seeded = await seedWorkspace(db, `rr-failed-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const started = await onboarding.startOnboardingRun(auth, fakeDriver());
    await eventBridge.closeRun({ workspaceId: seeded.workspaceId, runId: started.runId, state: "failed", error: "boom" });
    const failedEvents = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, seeded.workspaceId), eq(outboxEvents.topic, "run.critique_requested")));
    expect(failedEvents).toHaveLength(0);
  });

  it("the critique pass stores one capped proposal with provenance and its audit row", async () => {
    const { workspaceId, runId } = await succeededRun("critique-ok");
    generate.mockResolvedValue({
      text: JSON.stringify({
        gotWrong: "Missed that the owner asked for two examples.",
        wasThin: "The competitor section had no sources.",
        wouldDoDifferently: "Search before summarizing.",
      }),
    });

    await runCritiqueEvent(workspaceId, runId);

    const rows = await db.select().from(runReviews).where(and(eq(runReviews.runId, runId), eq(runReviews.kind, "critique")));
    expect(rows).toHaveLength(1);
    expect(rows[0].gotWrong).toContain("two examples");
    expect(rows[0].wasThin).toContain("no sources");
    expect(rows[0].wouldDoDifferently).toContain("Search");
    expect(rows[0].dismissedAt).toBeNull();
    // Provenance rides along from the run, not re-derived.
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(rows[0].model).toBe(run.model);
    expect(rows[0].profileRevisionId).toBe(run.profileRevisionId);
    expect(rows[0].policySnapshot).toEqual(run.policySnapshot);
    expect(await auditActions(workspaceId)).toContain("run.critique.created");

    // Redelivery is a no-op: one critique per run, enforced by the index.
    await runCritiqueEvent(workspaceId, runId);
    const after = await db.select().from(runReviews).where(and(eq(runReviews.runId, runId), eq(runReviews.kind, "critique")));
    expect(after).toHaveLength(1);
  });

  it("an all-empty critique stores nothing", async () => {
    const { workspaceId, runId } = await succeededRun("critique-empty");
    generate.mockResolvedValue({ text: JSON.stringify({ gotWrong: null, wasThin: null, wouldDoDifferently: null }) });
    await runCritiqueEvent(workspaceId, runId);
    const rows = await db.select().from(runReviews).where(eq(runReviews.runId, runId));
    expect(rows).toHaveLength(0);
  });

  it("an unconfigured provider skips without a row or an error", async () => {
    const { workspaceId, runId } = await succeededRun("critique-nokey");
    vi.mocked(providerModule.generationProvider).mockImplementation(() => {
      throw new providerModule.GenerationUnconfiguredError();
    });
    await runCritiqueEvent(workspaceId, runId);
    const rows = await db.select().from(runReviews).where(eq(runReviews.runId, runId));
    expect(rows).toHaveLength(0);
  });

  it("a provider failure writes no partial row and stays redeliverable", async () => {
    const { workspaceId, runId } = await succeededRun("critique-fails");
    generate.mockRejectedValue(new providerModule.GenerationRequestError("test", 500));
    await expect(runCritiqueEvent(workspaceId, runId)).rejects.toThrow("Generation request failed");
    const rows = await db.select().from(runReviews).where(eq(runReviews.runId, runId));
    expect(rows).toHaveLength(0);

    // The run itself is untouched: still succeeded, still has its summary.
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.state).toBe("succeeded");
    expect(run.summary).toContain("Interviewed");

    // Recovery: a later delivery with a healthy provider lands the proposal.
    generate.mockResolvedValue({ text: JSON.stringify({ gotWrong: "x", wasThin: null, wouldDoDifferently: null }) });
    await runCritiqueEvent(workspaceId, runId);
    const after = await db.select().from(runReviews).where(eq(runReviews.runId, runId));
    expect(after).toHaveLength(1);
  });

  it("one feedback row per run across set, switch and clear, with an audit row per flip", async () => {
    const { workspaceId, runId, auth } = await succeededRun("feedback");

    const up = await reviews.setRunFeedback(auth, { runId, verdict: "up" });
    expect(up).toEqual({ ok: true, verdict: "up" });
    const down = await reviews.setRunFeedback(auth, {
      runId,
      verdict: "down",
      reasons: ["wrong", "messy"],
      note: "Cited the wrong competitor.",
    });
    expect(down).toEqual({ ok: true, verdict: "down" });
    const cleared = await reviews.setRunFeedback(auth, { runId, verdict: "clear" });
    expect(cleared).toEqual({ ok: true, verdict: null });

    const rows = await db.select().from(runReviews).where(and(eq(runReviews.runId, runId), eq(runReviews.kind, "user_feedback")));
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBeNull();
    expect(rows[0].reasons).toEqual([]);
    expect(rows[0].note).toBeNull();

    const actions = await auditActions(workspaceId);
    expect(actions).toContain("run.feedback.up");
    expect(actions).toContain("run.feedback.down");
    expect(actions).toContain("run.feedback.cleared");
  });

  it("a reason outside the slug set is rejected before the write", async () => {
    const { runId, auth } = await succeededRun("bad-reason");
    await expect(
      reviews.setRunFeedback(auth, { runId, verdict: "down", reasons: ["rude"] as never }),
    ).rejects.toThrow();
    const rows = await db.select().from(runReviews).where(eq(runReviews.runId, runId));
    expect(rows).toHaveLength(0);
  });

  it("feedback on another workspace's run answers not-found and writes nothing", async () => {
    const target = await succeededRun("tenancy-a");
    const intruder = await seedWorkspace(db, `rr-tenancy-b-${Date.now()}`);
    const intruderAuth = ownerAuth(intruder.userId, intruder.workspaceId);

    const result = await reviews.setRunFeedback(intruderAuth, { runId: target.runId, verdict: "up" });
    expect(result).toEqual({ ok: false, verdict: null });
    const rows = await db.select().from(runReviews).where(eq(runReviews.runId, target.runId));
    expect(rows).toHaveLength(0);

    // The critique dismissal is scoped the same way.
    const dismissed = await reviews.dismissRunCritique(intruderAuth, { runId: target.runId });
    expect(dismissed.ok).toBe(false);
  });

  it("dismissing the critique stamps it once and writes the audit row", async () => {
    const { workspaceId, runId, auth } = await succeededRun("dismiss");
    generate.mockResolvedValue({ text: JSON.stringify({ gotWrong: "x", wasThin: null, wouldDoDifferently: null }) });
    await runCritiqueEvent(workspaceId, runId);

    const first = await reviews.dismissRunCritique(auth, { runId });
    expect(first.ok).toBe(true);
    const second = await reviews.dismissRunCritique(auth, { runId });
    expect(second.ok).toBe(false);

    const [row] = await db.select().from(runReviews).where(eq(runReviews.runId, runId));
    expect(row.dismissedAt).not.toBeNull();
    const actions = await auditActions(workspaceId);
    expect(actions.filter((a) => a === "run.critique.dismissed")).toHaveLength(1);
  });
});
