import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";
import { agentProfiles, agentRuns, threads } from "@/domains/agents/schema";
import { agentProfileRevisions, runtimeExecutions, runtimeSignals, toolInvocations } from "@/domains/agents/runtime-schema";

/*
 * ASH-117: real-Postgres proofs for immutable revisions, execution/signal/
 * invocation identity, unknown outcomes and same-workspace references.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
// Loaded lazily: db.ts reads DATABASE_URL at import, and makeTestDb sets it first.
let rt: typeof import("@/domains/agents/runtime-persistence");

beforeAll(async () => {
  if (handle) rt = await import("@/domains/agents/runtime-persistence");
});
afterAll(async () => {
  await handle?.client.end();
});

let counter = 0;
async function seed(label: string) {
  counter += 1;
  const db = handle!.db;
  const { workspaceId, userId } = await seedWorkspace(db, `${label}-${Date.now()}-${counter}`);
  const [profile] = await db.insert(agentProfiles).values({ workspaceId, name: `p-${label}-${counter}`, allowedTools: ["tasks.read"] }).returning();
  const [run] = await db
    .insert(agentRuns)
    .values({ workspaceId, agentProfileId: profile.id, objective: "t", policySnapshot: {}, state: "running" })
    .returning();
  return { workspaceId, userId, profile, run };
}

const execInput = (s: { workspaceId: string; run: { id: string } }, generation = 1, dispatchKey = `d-${Math.random()}`) => ({
  workspaceId: s.workspaceId,
  runId: s.run.id,
  generation,
  provider: "eve",
  environment: "test",
  workflowVersion: "v1",
  dispatchKey,
});

suite("profile revisions", () => {
  it("reuses identical content, and an edit makes a new revision without changing the old one", async () => {
    const s = await seed("rev");
    const r1 = await rt.captureProfileRevision({ workspaceId: s.workspaceId, profileId: s.profile.id });
    const again = await rt.captureProfileRevision({ workspaceId: s.workspaceId, profileId: s.profile.id });
    expect(again.id).toBe(r1.id);

    expect(await rt.bindRunToRevision({ workspaceId: s.workspaceId, runId: s.run.id, revisionId: r1.id })).toBe(true);
    await handle!.db.update(agentProfiles).set({ allowedTools: ["tasks.read", "gmail.send"] }).where(eq(agentProfiles.id, s.profile.id));
    const r2 = await rt.captureProfileRevision({ workspaceId: s.workspaceId, profileId: s.profile.id });
    expect(r2.revision).toBe(2);

    const [stored] = await handle!.db.select().from(agentProfileRevisions).where(eq(agentProfileRevisions.id, r1.id));
    expect((stored.snapshot as { allowedTools: string[] }).allowedTools).toEqual(["tasks.read"]);
    const [run] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, s.run.id));
    expect(run.profileRevisionId).toBe(r1.id);
  });

  it("serializes racing captures onto one revision", async () => {
    const s = await seed("rev-race");
    const all = await Promise.all(Array.from({ length: 6 }, () => rt.captureProfileRevision({ workspaceId: s.workspaceId, profileId: s.profile.id })));
    expect(new Set(all.map((r) => r.id)).size).toBe(1);
  });

  it("rejects editing a revision or re-pinning a run", async () => {
    const s = await seed("rev-frozen");
    const r1 = await rt.captureProfileRevision({ workspaceId: s.workspaceId, profileId: s.profile.id });
    await expect(handle!.db.update(agentProfileRevisions).set({ snapshot: {} }).where(eq(agentProfileRevisions.id, r1.id))).rejects.toThrow();
    await rt.bindRunToRevision({ workspaceId: s.workspaceId, runId: s.run.id, revisionId: r1.id });
    await handle!.db.update(agentProfiles).set({ instructions: "changed" }).where(eq(agentProfiles.id, s.profile.id));
    const r2 = await rt.captureProfileRevision({ workspaceId: s.workspaceId, profileId: s.profile.id });
    await expect(handle!.db.update(agentRuns).set({ profileRevisionId: r2.id }).where(eq(agentRuns.id, s.run.id))).rejects.toThrow();
    await expect(handle!.db.update(agentRuns).set({ policySnapshot: { widened: true } }).where(eq(agentRuns.id, s.run.id))).rejects.toThrow();
  });
});

suite("same-workspace references", () => {
  it("rejects a run, thread, execution or revision pointing across workspaces", async () => {
    const a = await seed("xw-a");
    const b = await seed("xw-b");
    const db = handle!.db;
    const revB = await rt.captureProfileRevision({ workspaceId: b.workspaceId, profileId: b.profile.id });

    await expect(db.insert(agentRuns).values({ workspaceId: a.workspaceId, agentProfileId: b.profile.id, objective: "x", policySnapshot: {} })).rejects.toThrow();
    await expect(db.insert(threads).values({ workspaceId: a.workspaceId, agentProfileId: b.profile.id })).rejects.toThrow();
    await expect(
      db.insert(agentRuns).values({ workspaceId: a.workspaceId, agentProfileId: a.profile.id, profileRevisionId: revB.id, objective: "x", policySnapshot: {} }),
    ).rejects.toThrow();
    await expect(db.insert(runtimeExecutions).values(execInput({ workspaceId: a.workspaceId, run: b.run }))).rejects.toThrow();
    await expect(
      db.insert(toolInvocations).values({ workspaceId: a.workspaceId, runId: b.run.id, invocationId: "i", toolName: "t", argumentsHash: "h" }),
    ).rejects.toThrow();
    const { execution } = await rt.recordExecution(execInput(b));
    await expect(
      db.insert(runtimeSignals).values({ workspaceId: a.workspaceId, executionId: execution.id, signalKey: "k", signalType: "t", payloadHash: "h" }),
    ).rejects.toThrow();
  });
});

suite("runtime executions", () => {
  it("is idempotent on dispatch key and racing inserts create one row", async () => {
    const s = await seed("exec-dup");
    const input = execInput(s, 1, "dispatch-1");
    const results = await Promise.all(Array.from({ length: 5 }, () => rt.recordExecution(input)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.execution.id)).size).toBe(1);
    await expect(rt.recordExecution({ ...input, generation: 2 })).rejects.toMatchObject({ code: "dispatch_key_mismatch" });
    await expect(handle!.db.insert(runtimeExecutions).values(execInput(s, 1, "other-key"))).rejects.toThrow();
  });

  it("binds the provider id once and rejects a second identity or a duplicate provider id", async () => {
    const s = await seed("exec-bind");
    const { execution } = await rt.recordExecution(execInput(s));
    await rt.markDispatching(execution.id);
    const bound = await rt.bindProviderExecution({ workspaceId: s.workspaceId, executionId: execution.id, providerExecutionId: "wrun_1" });
    expect(bound.dispatchState).toBe("dispatched");
    expect((await rt.bindProviderExecution({ workspaceId: s.workspaceId, executionId: execution.id, providerExecutionId: "wrun_1" })).id).toBe(execution.id);
    await expect(
      rt.bindProviderExecution({ workspaceId: s.workspaceId, executionId: execution.id, providerExecutionId: "wrun_2" }),
    ).rejects.toMatchObject({ code: "execution_already_bound" });

    const second = await rt.recordExecution(execInput(s, 2));
    await expect(
      rt.bindProviderExecution({ workspaceId: s.workspaceId, executionId: second.execution.id, providerExecutionId: "wrun_1" }),
    ).rejects.toThrow();
  });

  it("represents an unknown dispatch as neither failed nor dispatched, then reconciles it", async () => {
    const s = await seed("exec-unknown");
    const { execution } = await rt.recordExecution(execInput(s));
    await rt.markDispatching(execution.id);
    const unknown = await rt.markDispatchUnknown(execution.id);
    expect(unknown).toMatchObject({ dispatchState: "unknown", providerExecutionId: null });
    expect(unknown?.uncertainSince).toBeTruthy();
    const settled = await rt.reconcileUnknownDispatch({ workspaceId: s.workspaceId, executionId: execution.id, outcome: { providerExecutionId: "wrun_found" } });
    expect(settled).toMatchObject({ dispatchState: "dispatched", providerExecutionId: "wrun_found" });
    // A dispatched execution cannot claim to be dispatched without an id.
    await expect(
      handle!.client.unsafe(`update runtime_executions set dispatch_state = 'dispatched', provider_execution_id = null where id = '${execution.id}'`),
    ).rejects.toThrow();
  });

  it("refuses to change routing identity", async () => {
    const s = await seed("exec-frozen");
    const { execution } = await rt.recordExecution(execInput(s));
    await expect(handle!.db.update(runtimeExecutions).set({ provider: "other" }).where(eq(runtimeExecutions.id, execution.id))).rejects.toThrow();
  });
});

suite("runtime signals", () => {
  it("dedupes by key, rejects a changed payload, and refuses a stale generation", async () => {
    const s = await seed("sig");
    const { execution: g1 } = await rt.recordExecution(execInput(s, 1));
    const first = await rt.recordSignal({ workspaceId: s.workspaceId, executionId: g1.id, signalKey: "answer-1", signalType: "answer", payload: { a: 1, b: 2 } });
    const dup = await rt.recordSignal({ workspaceId: s.workspaceId, executionId: g1.id, signalKey: "answer-1", signalType: "answer", payload: { b: 2, a: 1 } });
    expect(first.created).toBe(true);
    expect(dup).toMatchObject({ created: false, signal: { id: first.signal.id } });
    await expect(
      rt.recordSignal({ workspaceId: s.workspaceId, executionId: g1.id, signalKey: "answer-1", signalType: "answer", payload: { a: 9 } }),
    ).rejects.toMatchObject({ code: "signal_payload_mismatch" });

    const attempt = await rt.beginSignalAttempt(first.signal.id);
    expect(attempt?.attempts).toBe(1);
    const unknown = await rt.settleSignal({ signalId: first.signal.id, status: "unknown" });
    expect(unknown?.status).toBe("unknown");
    expect((await rt.beginSignalAttempt(first.signal.id))?.attempts).toBe(2);

    await rt.recordExecution(execInput(s, 2));
    await expect(
      rt.recordSignal({ workspaceId: s.workspaceId, executionId: g1.id, signalKey: "late", signalType: "answer", payload: {} }),
    ).rejects.toMatchObject({ code: "stale_generation" });
  });

  it("does not let a stored signal's payload hash change", async () => {
    const s = await seed("sig-frozen");
    const { execution } = await rt.recordExecution(execInput(s));
    const { signal } = await rt.recordSignal({ workspaceId: s.workspaceId, executionId: execution.id, signalKey: "k", signalType: "t", payload: { x: 1 } });
    await expect(handle!.db.update(runtimeSignals).set({ payloadHash: "tampered" }).where(eq(runtimeSignals.id, signal.id))).rejects.toThrow();
  });
});

suite("tool invocations", () => {
  const base = (s: { workspaceId: string; run: { id: string } }) => ({ workspaceId: s.workspaceId, runId: s.run.id, invocationId: "call-1", toolName: "gmail.send" });

  it("replays an existing identity and fails when arguments differ", async () => {
    const s = await seed("inv");
    const first = await rt.beginInvocation({ ...base(s), effectClass: "external_effect", args: { to: "a@example.com", token: "secret" } });
    expect(first.replay).toBe(false);
    expect(first.invocation.redactedArguments).toEqual({ to: "a@example.com", token: "[redacted]" });
    const again = await rt.beginInvocation({ ...base(s), effectClass: "external_effect", args: { token: "secret", to: "a@example.com" } });
    expect(again).toMatchObject({ replay: true, invocation: { id: first.invocation.id } });
    await expect(rt.beginInvocation({ ...base(s), args: { to: "b@example.com" } })).rejects.toMatchObject({ code: "invocation_arguments_mismatch" });
  });

  it("racing identical requests create one logical invocation", async () => {
    const s = await seed("inv-race");
    const all = await Promise.all(Array.from({ length: 6 }, () => rt.beginInvocation({ ...base(s), args: { q: 1 } })));
    expect(all.filter((r) => !r.replay)).toHaveLength(1);
  });

  it("keeps in-flight and unknown calls distinct from failed, and a settled result final", async () => {
    const s = await seed("inv-state");
    const { invocation } = await rt.beginInvocation({ ...base(s), effectClass: "paid", args: { q: 1 } });
    expect((await rt.markInvocationInFlight(invocation.id))?.state).toBe("in_flight");
    const unknown = await rt.settleInvocation({ id: invocation.id, state: "unknown" });
    expect(unknown).toMatchObject({ state: "unknown", completedAt: null });
    const done = await rt.settleInvocation({ id: invocation.id, state: "succeeded", result: { ok: true, apiKey: "k" } });
    expect(done).toMatchObject({ state: "succeeded", redactedResult: { ok: true, apiKey: "[redacted]" } });
    expect(await rt.settleInvocation({ id: invocation.id, state: "failed" })).toBeNull();
    await expect(
      handle!.db.update(toolInvocations).set({ state: "failed" }).where(eq(toolInvocations.id, invocation.id)),
    ).rejects.toThrow();
  });
});
