import { desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";
import {
  actionAttempts,
  actionProposals,
  actionReviews,
  actionRevisions,
} from "@/domains/actions/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The approved-effect executor, against real Postgres and a stubbed fetch.
 *
 * The six properties this file exists to prove:
 *  1. one approval produces exactly one provider call, and a replay returns the
 *     settled outcome rather than a second send;
 *  2. an attempt left `unknown` by a crash blocks any new claim;
 *  3. a revision appended after the decision makes the decision stale;
 *  4. a revoked account is refused before the provider is touched;
 *  5. a timeout settles `unknown` and never `failed`;
 *  6. a 4xx settles `failed` with `retryable: false`.
 *
 * fetch is stubbed rather than the Composio seam so the real classification in
 * `executeComposioWrite` and the real RFC 2822 build in `gmail/send.ts` are on
 * the path. The stub's call count is the "provider spy count" the plan names.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let executor: typeof import("@/domains/actions/executor");
let actions: typeof import("@/domains/actions/commands");
let gmailSend: typeof import("@/domains/integrations/gmail/send");

const API_KEY = "test-composio-key";
beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  process.env.COMPOSIO_API_KEY = API_KEY;
  executor = await import("@/domains/actions/executor");
  actions = await import("@/domains/actions/commands");
  gmailSend = await import("@/domains/integrations/gmail/send");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  delete process.env.COMPOSIO_API_KEY;
  await handle?.client.end();
});

/** A fetch stub answering every provider call with one shape, and counting calls. */
function stubProvider(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const spy = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  });
  vi.stubGlobal("fetch", spy);
  return { spy, calls };
}

function sentOk(id = "msg_1") {
  return () => new Response(JSON.stringify({ data: { id, threadId: "thr_1" } }), { status: 200 });
}

type Seeded = {
  auth: ReturnType<typeof ownerAuth>;
  proposalId: string;
  revisionId: string;
  accountAlias: string;
};

let counter = 0;

async function seedSend(options: {
  slug: string;
  approved?: boolean;
  runId?: string | null;
  accountStatus?: "active" | "revoked";
  payload?: Record<string, unknown>;
}): Promise<Seeded & { workspaceId: string }> {
  counter += 1;
  const { userId, workspaceId } = await seedWorkspace(db, `${options.slug}-${Date.now()}-${counter}`);
  const auth = ownerAuth(userId, workspaceId);
  const alias = `work-gmail-${counter}`;
  await db.insert(externalAccounts).values({
    workspaceId,
    provider: "gmail",
    alias,
    status: options.accountStatus ?? "active",
    composioConnectedAccountId: options.accountStatus === "revoked" ? null : `ca_${crypto.randomUUID()}`,
    createdBy: userId,
    updatedBy: userId,
  });

  const [proposal] = await db
    .insert(actionProposals)
    .values({
      workspaceId,
      capability: "gmail.send",
      riskClass: "external_write",
      status: options.approved === false ? "pending" : "approved",
      accountAlias: alias,
      title: "Send email to ada@example.test",
      expectedEffect: "Sends a message.",
      dedupeKey: `gmail.mcp:${workspaceId}:ada@example.test:Hi:`,
      runId: options.runId ?? null,
      decidedAt: options.approved === false ? null : new Date(),
      decidedBy: options.approved === false ? null : userId,
    })
    .returning();

  const [revision] = await db
    .insert(actionRevisions)
    .values({
      workspaceId,
      proposalId: proposal.id,
      revisionNumber: 1,
      payload: options.payload ?? { to: "ada@example.test", subject: "Hi", body: "Hello", inReplyTo: null },
      preview: { to: "ada@example.test", subject: "Hi" },
      createdBy: userId,
    })
    .returning();

  if (options.approved !== false) {
    await db.insert(actionReviews).values({
      workspaceId,
      proposalId: proposal.id,
      revisionId: revision.id,
      decision: "approved",
      reviewedBy: userId,
    });
  }

  return { auth, proposalId: proposal.id, revisionId: revision.id, accountAlias: alias, workspaceId };
}

async function seedRun(workspaceId: string, userId: string, allowedTools = ["gmail.send"]) {
  const [profile] = await db
    .insert(agentProfiles)
    .values({ workspaceId, name: `alfred-${crypto.randomUUID()}` })
    .returning();
  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId,
      agentProfileId: profile.id,
      objective: "Send a reply",
      state: "running",
      policySnapshot: { allowedTools },
      createdBy: userId,
    })
    .returning();
  return run.id;
}

suite("executeApprovedEffect", () => {
  it("sends exactly once; a second execution returns the settled outcome", async () => {
    const seeded = await seedSend({ slug: "effect-once" });
    const { spy } = stubProvider(sentOk("msg_1"));

    const first = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(first).toMatchObject({ status: "sent", providerId: "msg_1" });

    const second = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(second).toMatchObject({ status: "sent", providerId: "msg_1" });
    expect(spy).toHaveBeenCalledTimes(1);

    const attempts = await db
      .select()
      .from(actionAttempts)
      .where(eq(actionAttempts.proposalId, seeded.proposalId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("succeeded");
    expect(attempts[0].idempotencyKey).toBe(`exec:${seeded.proposalId}`);

    // The proposal stays approved: the attempt, not the proposal, carries the effect.
    const [proposal] = await db
      .select({ status: actionProposals.status })
      .from(actionProposals)
      .where(eq(actionProposals.id, seeded.proposalId));
    expect(proposal.status).toBe("approved");
  });

  it("a crash-shaped unknown attempt blocks the claim and never calls the provider", async () => {
    const seeded = await seedSend({ slug: "effect-unknown-blocks" });
    await db.insert(actionAttempts).values({
      workspaceId: seeded.workspaceId,
      proposalId: seeded.proposalId,
      revisionId: seeded.revisionId,
      idempotencyKey: `exec:${seeded.proposalId}`,
      attemptNumber: 1,
      status: "unknown",
      reconciliation: "pending",
    });
    const { spy } = stubProvider(sentOk());

    const outcome = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(outcome.status).toBe("unknown");
    expect(spy).not.toHaveBeenCalled();

    const attempts = await db
      .select()
      .from(actionAttempts)
      .where(eq(actionAttempts.proposalId, seeded.proposalId));
    expect(attempts).toHaveLength(1);
  });

  it("a revision appended after approval makes the decision stale", async () => {
    const seeded = await seedSend({ slug: "effect-stale" });

    // `reviseProposal` refuses a decided proposal, which is the first guard.
    await expect(
      actions.reviseProposal(seeded.auth, {
        proposalId: seeded.proposalId,
        expectedVersion: 1,
        payload: { to: "mallory@example.test", subject: "Hi", body: "Changed", inReplyTo: null },
      }),
    ).rejects.toThrow(/changed since|no longer pending/i);

    // The second guard is the executor's: a newer revision exists, so the
    // approval no longer covers the payload that would be sent.
    await db.insert(actionRevisions).values({
      workspaceId: seeded.workspaceId,
      proposalId: seeded.proposalId,
      revisionNumber: 2,
      payload: { to: "mallory@example.test", subject: "Hi", body: "Changed", inReplyTo: null },
      createdBy: seeded.auth.userId,
    });
    const { spy } = stubProvider(sentOk());

    await expect(
      executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId }),
    ).rejects.toBeInstanceOf(actions.StaleRevisionError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a revoked account before any provider call", async () => {
    const seeded = await seedSend({ slug: "effect-revoked", accountStatus: "revoked" });
    const { spy } = stubProvider(sentOk());

    await expect(
      executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId }),
    ).rejects.toBeInstanceOf(executor.SendNotAllowedError);
    expect(spy).not.toHaveBeenCalled();
    const attempts = await db
      .select()
      .from(actionAttempts)
      .where(eq(actionAttempts.proposalId, seeded.proposalId));
    expect(attempts).toHaveLength(0);
  });

  it("a timeout settles unknown, never failed, and blocks a second send", async () => {
    const seeded = await seedSend({ slug: "effect-timeout" });
    const { spy } = stubProvider(() => {
      throw new TypeError("fetch failed");
    });

    const first = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(first.status).toBe("unknown");
    if (first.status !== "unknown") throw new Error("unreachable");
    expect(first.reconciliationId).toBeTruthy();

    const [attempt] = await db.select().from(actionAttempts).where(eq(actionAttempts.id, first.reconciliationId));
    expect(attempt.status).toBe("unknown");
    expect(attempt.errorCode).toBe("send_outcome_unknown");
    expect(attempt.endedAt).toBeNull();

    // Re-approval cannot become a send: the proposal is no longer pending, and
    // the executor returns the unresolved attempt.
    await expect(
      actions.decideProposal(seeded.auth, {
        proposalId: seeded.proposalId,
        expectedVersion: 1,
        revisionId: seeded.revisionId,
        decision: "approved",
      }),
    ).rejects.toBeInstanceOf(actions.ProposalConflictError);
    const replay = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(replay.status).toBe("unknown");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a 400 settles failed with retryable false", async () => {
    const seeded = await seedSend({ slug: "effect-rejected" });
    stubProvider(() => new Response(JSON.stringify({ error: "invalid recipient" }), { status: 400 }));

    const outcome = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(outcome).toMatchObject({ status: "failed", retryable: false });

    const [attempt] = await db
      .select()
      .from(actionAttempts)
      .where(eq(actionAttempts.proposalId, seeded.proposalId));
    expect(attempt.status).toBe("failed");
    expect(attempt.reconciliation).toBe("not_needed");
    expect(attempt.errorCode).toBe("provider_rejected_400");
  });

  it("a 500 is ambiguous, so it settles unknown", async () => {
    const seeded = await seedSend({ slug: "effect-500" });
    stubProvider(() => new Response("upstream", { status: 500 }));

    const outcome = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(outcome.status).toBe("unknown");
  });

  it("six approved effects in one run exceed the cap", async () => {
    const seeded = await seedSend({ slug: "effect-cap" });
    const runId = await seedRun(seeded.workspaceId, seeded.auth.userId);

    // Five prior effects charged to the same run.
    for (let n = 0; n < 5; n += 1) {
      const [p] = await db
        .insert(actionProposals)
        .values({
          workspaceId: seeded.workspaceId,
          capability: "gmail.send",
          riskClass: "external_write",
          status: "approved",
          runId,
          title: `Prior ${n}`,
          expectedEffect: "Sends a message.",
          dedupeKey: `prior-${seeded.workspaceId}-${n}`,
        })
        .returning();
      const [r] = await db
        .insert(actionRevisions)
        .values({ workspaceId: seeded.workspaceId, proposalId: p.id, revisionNumber: 1, payload: {} })
        .returning();
      await db.insert(actionAttempts).values({
        workspaceId: seeded.workspaceId,
        proposalId: p.id,
        revisionId: r.id,
        idempotencyKey: `exec:${p.id}`,
        attemptNumber: 1,
        status: "succeeded",
        providerObjectId: `msg_${n}`,
      });
    }

    // The sixth proposal is the one under test; it must be charged to the run.
    await db
      .update(actionProposals)
      .set({ runId })
      .where(eq(actionProposals.id, seeded.proposalId));
    const { spy } = stubProvider(sentOk());

    await expect(
      executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId }),
    ).rejects.toBeInstanceOf(executor.EffectBudgetExceededError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a cancelled run before any provider call", async () => {
    const seeded = await seedSend({ slug: "effect-cancelled-run" });
    const runId = await seedRun(seeded.workspaceId, seeded.auth.userId);
    await db.update(agentRuns).set({ state: "cancelled" }).where(eq(agentRuns.id, runId));
    await db.update(actionProposals).set({ runId }).where(eq(actionProposals.id, seeded.proposalId));
    const { spy } = stubProvider(sentOk());

    await expect(
      executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId }),
    ).rejects.toBeInstanceOf(executor.SendNotAllowedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a capability with no executor instead of guessing one", async () => {
    const seeded = await seedSend({ slug: "effect-unsupported" });
    await db
      .update(actionProposals)
      .set({ capability: "gmail.delete" })
      .where(eq(actionProposals.id, seeded.proposalId));
    const { spy } = stubProvider(sentOk());

    await expect(
      executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId }),
    ).rejects.toBeInstanceOf(executor.EffectNotSupportedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("builds a stable Message-ID from the attempt id", async () => {
    const seeded = await seedSend({ slug: "effect-marker" });
    const { calls } = stubProvider(sentOk());
    await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });

    const [attempt] = await db
      .select()
      .from(actionAttempts)
      .where(eq(actionAttempts.proposalId, seeded.proposalId))
      .orderBy(desc(actionAttempts.attemptNumber));
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body)) as { body: { raw: string }; method: string };
    expect(body.method).toBe("POST");
    const raw = Buffer.from(body.body.raw, "base64url").toString("utf8");
    expect(raw).toContain(`Message-ID: ${gmailSend.messageIdMarker(attempt.id)}`);
  });
});
