import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionRevisions, actionAttempts, providerObservations } from "@/domains/actions/schema";
import { correspondence } from "@/domains/crm/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Send executor invariants: nothing sends without an approved, current
 * proposal; the default port never sends; a success settles once; a lost
 * response blocks retry until reconciled.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let corr: typeof import("@/domains/crm/correspondence");
let crm: typeof import("@/domains/crm/commands");
let exec: typeof import("@/domains/crm/send-executor");
let actions: typeof import("@/domains/actions/commands");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  corr = await import("@/domains/crm/correspondence");
  crm = await import("@/domains/crm/commands");
  exec = await import("@/domains/crm/send-executor");
  actions = await import("@/domains/actions/commands");
});

afterAll(async () => {
  await handle?.client.end();
});

async function setup(slug: string, opts: { approve: boolean }) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  const auth = ownerAuth(userId, workspaceId);
  const [account] = await db
    .insert(externalAccounts)
    .values({
      workspaceId,
      provider: "gmail",
      alias: `a-${Date.now()}`,
      status: "active",
      composioConnectedAccountId: `ca_${crypto.randomUUID()}`,
      createdBy: userId,
      updatedBy: userId,
    })
    .returning();
  const contact = await crm.createContact(auth, { fullName: "Ada", primaryEmail: `ada-${Date.now()}@example.test` });
  const draft = await corr.draftCorrespondence(auth, {
    contactId: contact.id,
    subject: "Hi",
    body: "Hello",
    externalAccountId: account.id,
  });
  const requested = await corr.requestSendApproval(auth, { correspondenceId: draft.id, expectedVersion: draft.version });
  if (opts.approve) {
    const [rev] = await db
      .select()
      .from(actionRevisions)
      .where(and(eq(actionRevisions.workspaceId, workspaceId), eq(actionRevisions.proposalId, requested.proposalId)))
      .orderBy(desc(actionRevisions.revisionNumber))
      .limit(1);
    await actions.decideProposal(auth, {
      proposalId: requested.proposalId,
      expectedVersion: 1,
      revisionId: rev.id,
      decision: "approved",
    });
  }
  return { auth, draft };
}

const okSender = (calls: unknown[]) => ({
  async send(input: unknown) {
    calls.push(input);
    return { providerObjectId: "msg_1", threadId: "t_1" };
  },
});

suite("sendApprovedCorrespondence", () => {
  it("refuses an unapproved send and never calls the provider", async () => {
    const { auth, draft } = await setup("send-unapproved", { approve: false });
    const calls: unknown[] = [];
    await expect(
      exec.sendApprovedCorrespondence(auth, { correspondenceId: draft.id, sender: okSender(calls) }),
    ).rejects.toThrow(/not been approved/);
    expect(calls).toHaveLength(0);
  });

  it("the default port refuses: nothing leaves without an adapter", async () => {
    const { auth, draft } = await setup("send-default", { approve: true });
    const result = await exec.sendApprovedCorrespondence(auth, { correspondenceId: draft.id });
    expect(result.state).toBe("failed");
    const [row] = (await corr.listCorrespondence(auth)).filter((r) => r.id === draft.id);
    expect(row.state).toBe("drafted");
  });

  it("sends once and replays as already sent", async () => {
    const { auth, draft } = await setup("send-ok", { approve: true });
    const calls: unknown[] = [];
    const first = await exec.sendApprovedCorrespondence(auth, { correspondenceId: draft.id, sender: okSender(calls) });
    expect(first).toMatchObject({ state: "sent", providerObjectId: "msg_1" });
    const again = await exec.sendApprovedCorrespondence(auth, { correspondenceId: draft.id, sender: okSender(calls) });
    expect(again.alreadySent).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("an unknown outcome blocks a retry until reconciled", async () => {
    const { auth, draft } = await setup("send-unknown", { approve: true });
    const lost = {
      async send(): Promise<never> {
        throw new exec.SendOutcomeUnknownError("timeout after request");
      },
    };
    expect((await exec.sendApprovedCorrespondence(auth, { correspondenceId: draft.id, sender: lost })).state).toBe("unknown");
    const calls: unknown[] = [];
    await expect(
      exec.sendApprovedCorrespondence(auth, { correspondenceId: draft.id, sender: okSender(calls) }),
    ).rejects.toThrow(/unknown outcome/);
    expect(calls).toHaveLength(0);
  });

  it("refuses when the draft was edited after approval", async () => {
    const { auth, draft } = await setup("send-edited", { approve: true });
    const [current] = (await corr.listCorrespondence(auth)).filter((r) => r.id === draft.id);
    await corr.updateCorrespondenceDraft(auth, { correspondenceId: draft.id, expectedVersion: current.version, body: "Changed" });
    const calls: unknown[] = [];
    await expect(
      exec.sendApprovedCorrespondence(auth, { correspondenceId: draft.id, sender: okSender(calls) }),
    ).rejects.toThrow(/changed after/);
    expect(calls).toHaveLength(0);
  });
});

/*
 * ASH-191. An unknown outcome blocks retry for a reason — a second send could
 * double the external effect. What was missing was the exit: a way to close the
 * unknown once someone has seen what the provider actually holds. These cases
 * assert that the exit exists, that it records the observation, and that it is
 * idempotent so a late observer cannot rewrite history.
 */
suite("resolveUnknownSend", () => {
  async function unknownAttempt(slug: string) {
    const { auth, draft } = await setup(slug, { approve: true });
    const lost = {
      async send(): Promise<never> {
        throw new exec.SendOutcomeUnknownError("timeout after request");
      },
    };
    await exec.sendApprovedCorrespondence(auth, { correspondenceId: draft.id, sender: lost });
    const [attempt] = await db
      .select()
      .from(actionAttempts)
      .where(and(eq(actionAttempts.workspaceId, auth.workspaceId), eq(actionAttempts.status, "unknown")))
      .orderBy(desc(actionAttempts.attemptNumber))
      .limit(1);
    return { auth, draft, attempt };
  }

  it("resolving as absent unblocks a retry", async () => {
    const { auth, draft, attempt } = await unknownAttempt(`resolve-absent-${Date.now()}`);
    expect(attempt.reconciliation).toBe("pending");

    await expect(
      exec.resolveUnknownSend(auth, { attemptId: attempt.id, observation: { observedState: "absent" }, source: "human_check" }),
    ).resolves.toEqual({ resolved: true, settledAs: "absent" });

    const calls: unknown[] = [];
    const sent = await exec.sendApprovedCorrespondence(auth, { correspondenceId: draft.id, sender: okSender(calls) });
    expect(sent.state).toBe("sent");
    expect(calls).toHaveLength(1);
  });

  it("resolving as sent settles the attempt, marks the draft sent, and blocks a resend", async () => {
    const { auth, draft, attempt } = await unknownAttempt(`resolve-sent-${Date.now()}`);

    await exec.resolveUnknownSend(auth, {
      attemptId: attempt.id,
      observation: { observedState: "sent", providerObjectId: "msg_found" },
      source: "provider_read",
    });

    const [settled] = await db.select().from(actionAttempts).where(eq(actionAttempts.id, attempt.id));
    expect(settled).toMatchObject({ status: "succeeded", reconciliation: "resolved", providerObjectId: "msg_found" });

    const [row] = (await corr.listCorrespondence(auth)).filter((r) => r.id === draft.id);
    expect(row.state).toBe("sent");

    const calls: unknown[] = [];
    const again = await exec.sendApprovedCorrespondence(auth, { correspondenceId: draft.id, sender: okSender(calls) });
    expect(again.alreadySent).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("records the observation so the decision is auditable", async () => {
    const { auth, attempt } = await unknownAttempt(`resolve-observe-${Date.now()}`);
    await exec.resolveUnknownSend(auth, { attemptId: attempt.id, observation: { observedState: "absent" }, source: "human_check" });

    const [observation] = await db
      .select()
      .from(providerObservations)
      .where(and(eq(providerObservations.workspaceId, auth.workspaceId), eq(providerObservations.attemptId, attempt.id)));
    expect(observation).toMatchObject({ observedState: "absent", provider: "human" });
  });

  it("a second resolution is a no-op rather than a rewrite, but still records the observation", async () => {
    const { auth, attempt } = await unknownAttempt(`resolve-twice-${Date.now()}`);
    await exec.resolveUnknownSend(auth, { attemptId: attempt.id, observation: { observedState: "absent" }, source: "human_check" });
    await expect(
      exec.resolveUnknownSend(auth, {
        attemptId: attempt.id,
        observation: { observedState: "sent", providerObjectId: "msg_late" },
        source: "provider_read",
      }),
    ).resolves.toEqual({ resolved: false });

    const [row] = await db.select().from(actionAttempts).where(eq(actionAttempts.id, attempt.id));
    expect(row.status).toBe("failed");

    // A later observer who finds contrary evidence is recorded, not discarded:
    // observations are append-only proof, even when they arrive too late to settle.
    const observed = await db
      .select()
      .from(providerObservations)
      .where(and(eq(providerObservations.attemptId, attempt.id), eq(providerObservations.observedState, "sent")));
    expect(observed).toHaveLength(1);
    expect(observed[0].detail).toMatchObject({ arrivedAfterSettlement: true, settledStatus: "failed" });
  });

  it("refuses to mark a cancelled draft sent, and says so", async () => {
    const { auth, draft, attempt } = await unknownAttempt(`resolve-cancelled-${Date.now()}`);
    const [current] = (await corr.listCorrespondence(auth)).filter((r) => r.id === draft.id);
    await db
      .update(correspondence)
      .set({ state: "cancelled", updatedAt: new Date(), updatedBy: auth.userId })
      .where(and(eq(correspondence.workspaceId, auth.workspaceId), eq(correspondence.id, current.id)));

    // The message was really sent, but the draft is no longer live. Recording a
    // send against it would resurrect a cancelled draft, so the command stops.
    await expect(
      exec.resolveUnknownSend(auth, {
        attemptId: attempt.id,
        observation: { observedState: "sent", providerObjectId: "msg_found" },
        source: "provider_read",
      }),
    ).rejects.toThrow(/no longer in a state that can record a send/);
  });

  it("keeps the original unknown-outcome summary when it resolves", async () => {
    const { auth, attempt } = await unknownAttempt(`resolve-summary-${Date.now()}`);
    await exec.resolveUnknownSend(auth, {
      attemptId: attempt.id,
      observation: { observedState: "absent" },
      source: "human_check",
    });

    const [row] = await db.select().from(actionAttempts).where(eq(actionAttempts.id, attempt.id));
    expect(row.responseSummary).toMatchObject({ resolution: { resolvedBy: "human_check", observedState: "absent" } });
    // The error code that recorded the unknown is not upgraded into a lie.
    expect(row.errorCode).toBe("send_outcome_unknown");
  });

  it("reports what the attempt settled as", async () => {
    const { auth, attempt } = await unknownAttempt(`resolve-reports-${Date.now()}`);
    await expect(
      exec.resolveUnknownSend(auth, {
        attemptId: attempt.id,
        observation: { observedState: "absent" },
        source: "human_check",
      }),
    ).resolves.toEqual({ resolved: true, settledAs: "absent" });
  });

  it("refuses an attempt from another workspace", async () => {
    const { attempt } = await unknownAttempt(`resolve-tenant-${Date.now()}`);
    const other = await seedWorkspace(db, `resolve-other-${Date.now()}`);
    await expect(
      exec.resolveUnknownSend(ownerAuth(other.userId, other.workspaceId), {
        attemptId: attempt.id,
        observation: { observedState: "absent" },
        source: "human_check",
      }),
    ).rejects.toThrow(/not in this workspace/);
  });
});
