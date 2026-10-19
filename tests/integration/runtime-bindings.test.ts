import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentProfileRevisions,
  agentProfiles,
  agentRuns,
  runExecutions,
  runSignals,
  toolCalls,
} from "@/domains/agents/schema";
import {
  bindExecution,
  captureProfileRevision,
  completeToolInvocation,
  deliverSignal,
  markExecutionUncertain,
  openExecution,
  recordToolInvocation,
} from "@/domains/agents/runtime-bindings";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-117 acceptance coverage, on a real Postgres because the invariants are
 * constraint-level: tenant-composite foreign keys, uniqueness of provider
 * execution identity, and duplicate-insert races cannot be proven by a mock.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

let ws: { userId: string; workspaceId: string };
// Provider execution ids must be unique per suite run: the scratch DB is
// shared with other files and is not truncated between them.
const pe = (n: string) => `wrun_rb_${Date.now()}_${n}`;
let pe1 = "", pe2 = "", pe3 = "", pe4 = "";
let other: { userId: string; workspaceId: string };

async function makeProfile(name: string) {
  const [profile] = await holder.db!
    .insert(agentProfiles)
    .values({ workspaceId: ws.workspaceId, name, modelPolicy: { primary: "m1" } })
    .returning();
  return profile;
}

async function makeRun(profileId: string, profileRevisionId: string | null = null, workspaceId = ws.workspaceId) {
  const [run] = await holder.db!
    .insert(agentRuns)
    .values({
      workspaceId,
      agentProfileId: profileId,
      profileRevisionId,
      objective: "test",
      policySnapshot: { profileId },
    })
    .returning();
  return run;
}

beforeAll(async () => {
  holder.db = handle?.db;
  pe1 = pe("1"); pe2 = pe("2"); pe3 = pe("3"); pe4 = pe("4");
  ws = await seedWorkspace(handle!.db, `rt03a${Date.now() % 100000}`);
  other = await seedWorkspace(handle!.db, `rt03b${Date.now() % 100000}`);
});
afterAll(async () => { await handle?.client.end(); });

suite("profile revisions", () => {
  it("an unchanged profile reuses its revision; an edit writes the next one; old revisions are untouched", async () => {
    const profile = await makeProfile(`p-${Date.now()}`);
    const rev1 = await captureProfileRevision(ws.workspaceId, profile);
    // Same profile again: no new revision.
    expect(await captureProfileRevision(ws.workspaceId, profile)).toBe(rev1);

    // Edit the profile (as ensureProfile's capability top-up does).
    const [edited] = await holder.db!
      .update(agentProfiles)
      .set({ allowedTools: ["documents.search"] })
      .where(eq(agentProfiles.id, profile.id))
      .returning();
    const rev2 = await captureProfileRevision(ws.workspaceId, edited);
    expect(rev2).not.toBe(rev1);

    const revisions = await holder.db!
      .select()
      .from(agentProfileRevisions)
      .where(eq(agentProfileRevisions.profileId, profile.id));
    expect(revisions).toHaveLength(2);
    const byNumber = Object.fromEntries(revisions.map((r) => [r.revisionNumber, r]));
    // The old revision kept its snapshot: the edit did not rewrite history.
    expect(byNumber[1].allowedTools).toEqual([]);
    expect(byNumber[2].allowedTools).toEqual(["documents.search"]);

    // A run admitted under rev1 keeps pointing at rev1 after the edit.
    const run = await makeRun(profile.id, rev1);
    const [bound] = await holder.db!
      .select({ profileRevisionId: agentRuns.profileRevisionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id));
    expect(bound.profileRevisionId).toBe(rev1);
  });
});

suite("runtime executions", () => {
  it("a retried dispatch of the same generation returns the same execution row", async () => {
    const profile = await makeProfile(`p-gen-${Date.now()}`);
    const run = await makeRun(profile.id);
    const first = await openExecution({ workspaceId: ws.workspaceId, runId: run.id, generation: 1, provider: "eve" });
    const again = await openExecution({ workspaceId: ws.workspaceId, runId: run.id, generation: 1, provider: "eve" });
    expect(again.executionId).toBe(first.executionId);
    // A second generation is a new execution, not an overwrite.
    const gen2 = await openExecution({ workspaceId: ws.workspaceId, runId: run.id, generation: 2, provider: "eve" });
    expect(gen2.executionId).not.toBe(first.executionId);
  });

  it("binds null-to-bound, idempotently rebinds the same id, and refuses a different id", async () => {
    const profile = await makeProfile(`p-bind-${Date.now()}`);
    const run = await makeRun(profile.id);
    const exec = await openExecution({ workspaceId: ws.workspaceId, runId: run.id, generation: 1, provider: "eve" });
    await bindExecution({ workspaceId: ws.workspaceId, runId: run.id, executionId: exec.executionId, providerExecutionId: pe1 });
    await bindExecution({ workspaceId: ws.workspaceId, runId: run.id, executionId: exec.executionId, providerExecutionId: pe1 });
    const [row] = await holder.db!.select().from(runExecutions).where(eq(runExecutions.id, exec.executionId));
    expect(row.state).toBe("bound");
    expect(row.boundAt).not.toBeNull();
    await expect(
      bindExecution({ workspaceId: ws.workspaceId, runId: run.id, executionId: exec.executionId, providerExecutionId: pe2 }),
    ).rejects.toThrow(/different provider execution/);
  });

  it("two executions cannot claim one provider execution id", async () => {
    const profile = await makeProfile(`p-dup-${Date.now()}`);
    const runA = await makeRun(profile.id);
    const runB = await makeRun(profile.id);
    const execA = await openExecution({ workspaceId: ws.workspaceId, runId: runA.id, generation: 1, provider: "eve" });
    const execB = await openExecution({ workspaceId: ws.workspaceId, runId: runB.id, generation: 1, provider: "eve" });
    await bindExecution({ workspaceId: ws.workspaceId, runId: runA.id, executionId: execA.executionId, providerExecutionId: pe3 });
    await expect(
      bindExecution({ workspaceId: ws.workspaceId, runId: runB.id, executionId: execB.executionId, providerExecutionId: pe3 }),
    ).rejects.toThrow();
  });

  it("a lost dispatch is uncertain, not failed; a bound execution stays bound", async () => {
    const profile = await makeProfile(`p-unc-${Date.now()}`);
    const run = await makeRun(profile.id);
    const exec = await openExecution({ workspaceId: ws.workspaceId, runId: run.id, generation: 1, provider: "eve" });
    await markExecutionUncertain(exec.executionId);
    let [row] = await holder.db!.select().from(runExecutions).where(eq(runExecutions.id, exec.executionId));
    expect(row.state).toBe("uncertain");
    expect(row.uncertainAt).not.toBeNull();

    const exec2 = await openExecution({ workspaceId: ws.workspaceId, runId: run.id, generation: 2, provider: "eve" });
    await bindExecution({ workspaceId: ws.workspaceId, runId: run.id, executionId: exec2.executionId, providerExecutionId: pe4 });
    await markExecutionUncertain(exec2.executionId); // stale: only 'dispatched' rows can go uncertain
    [row] = await holder.db!.select().from(runExecutions).where(eq(runExecutions.id, exec2.executionId));
    expect(row.state).toBe("bound");
  });

  it("the tenant-composite key rejects a cross-workspace run reference", async () => {
    const profile = await makeProfile(`p-xws-${Date.now()}`);
    const foreignRun = await makeRun(profile.id, null, other.workspaceId);
    await expect(
      holder.db!.insert(runExecutions).values({
        workspaceId: ws.workspaceId, // my workspace, someone else's run
        runId: foreignRun.id,
        generation: 1,
        provider: "eve",
        dispatchKey: `xws-${Date.now()}`,
      }),
    ).rejects.toThrow();
  });
});

suite("durable signals", () => {
  it("delivers once under a stable identity; a replay is a no-op; a payload change fails loudly", async () => {
    const profile = await makeProfile(`p-sig-${Date.now()}`);
    const run = await makeRun(profile.id);
    let deliveries = 0;
    const deliver = async () => { deliveries += 1; };

    const first = await deliverSignal({ workspaceId: ws.workspaceId, runId: run.id, signalKey: "cancel", payload: { by: "u1" }, deliver });
    expect(first.replayed).toBe(false);
    expect(deliveries).toBe(1);

    const replay = await deliverSignal({ workspaceId: ws.workspaceId, runId: run.id, signalKey: "cancel", payload: { by: "u1" }, deliver });
    expect(replay.replayed).toBe(true);
    expect(deliveries).toBe(1); // a retried cancel is never a second cancel

    const [row] = await holder.db!.select().from(runSignals).where(and(eq(runSignals.runId, run.id), eq(runSignals.signalKey, "cancel")));
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
    expect(row.generation).toBe(1);

    await expect(
      deliverSignal({ workspaceId: ws.workspaceId, runId: run.id, signalKey: "cancel", payload: { by: "u2" }, deliver }),
    ).rejects.toThrow(/different payload/);
  });

  it("a lost delivery is unknown and flagged for reconciliation, never failed", async () => {
    const profile = await makeProfile(`p-sigu-${Date.now()}`);
    const run = await makeRun(profile.id);
    await expect(
      deliverSignal({
        workspaceId: ws.workspaceId,
        runId: run.id,
        signalKey: "answer:q1",
        payload: { answer: "yes" },
        deliver: async () => { throw new Error("connection reset"); },
      }),
    ).rejects.toThrow("connection reset");
    const [row] = await holder.db!.select().from(runSignals).where(and(eq(runSignals.runId, run.id), eq(runSignals.signalKey, "answer:q1")));
    expect(row.status).toBe("unknown");
    expect(row.reconciliation).toBe("pending");
    expect(row.attempts).toBe(1);
  });
});

suite("tool invocations", () => {
  it("a replayed invocation returns the recorded row; the same id with different arguments throws", async () => {
    const profile = await makeProfile(`p-inv-${Date.now()}`);
    const run = await makeRun(profile.id);
    const first = await recordToolInvocation({
      workspaceId: ws.workspaceId,
      runId: run.id,
      invocationId: "inv-1",
      toolName: "gmail.send",
      args: { to: "a@b.c", subject: "hi" },
    });
    expect(first.replayed).toBe(false);

    const replay = await recordToolInvocation({
      workspaceId: ws.workspaceId,
      runId: run.id,
      invocationId: "inv-1",
      toolName: "gmail.send",
      args: { subject: "hi", to: "a@b.c" }, // key order is not identity
    });
    expect(replay.replayed).toBe(true);
    expect(replay.toolCallId).toBe(first.toolCallId);

    await expect(
      recordToolInvocation({
        workspaceId: ws.workspaceId,
        runId: run.id,
        invocationId: "inv-1",
        toolName: "gmail.send",
        args: { to: "someone@else", subject: "hi" },
      }),
    ).rejects.toThrow(/different arguments/);
  });

  it("completion closes the invocation exactly once", async () => {
    const profile = await makeProfile(`p-invc-${Date.now()}`);
    const run = await makeRun(profile.id);
    await recordToolInvocation({ workspaceId: ws.workspaceId, runId: run.id, invocationId: "inv-2", toolName: "documents.search", args: { q: "x" } });
    await completeToolInvocation({ workspaceId: ws.workspaceId, invocationId: "inv-2", ok: true, result: { hits: 1 }, durationMs: 5 });
    await completeToolInvocation({ workspaceId: ws.workspaceId, invocationId: "inv-2", ok: false, errorCode: "late_failure" });
    const [row] = await holder.db!.select().from(toolCalls).where(and(eq(toolCalls.workspaceId, ws.workspaceId), eq(toolCalls.invocationId, "inv-2")));
    // The second close matched nothing: the completed state survived.
    expect(row.executionState).toBe("completed");
    expect(row.ok).toBe(true);
  });
});
