import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionProposals, actionReviews, actionRevisions } from "@/domains/actions/schema";
import { auditEvents, requestReceipts } from "@/domains/audit/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * decideProposal / reviseProposal are the human half of the proposal
 * machine: the CAS on (version, still pending), the approval binding to the
 * exact revision seen, the receipt that makes a retried click a replay, and
 * the audit row that commits with the change. Only real Postgres proves the
 * unique indexes and the version guard win their races, so this suite runs
 * against TEST_DATABASE_URL like action-proposals.test.ts.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/actions/commands");
let withTransaction: typeof import("@/lib/db-transaction").withTransaction;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/actions/commands");
  ({ withTransaction } = await import("@/lib/db-transaction"));
});

afterAll(async () => {
  await handle?.client.end();
});

let seedCounter = 0;

async function seed(label: string) {
  seedCounter += 1;
  const { userId, workspaceId } = await seedWorkspace(db, `${label}-${Date.now()}-${seedCounter}`);
  return ownerAuth(userId, workspaceId);
}

/** A pending proposal with one payload revision, as an agent would leave it. */
async function seedProposal(auth: ReturnType<typeof ownerAuth>, label: string) {
  const { proposalId } = await withTransaction((tx) =>
    commands.createProposal(tx, auth, {
      capability: "gmail.send",
      riskClass: "external_write",
      title: `Send reply ${label}`,
      expectedEffect: "Sends the drafted reply",
      dedupeKey: `gmail.send:${auth.workspaceId}:${label}`,
      runId: null,
    }),
  );
  const [revision] = await db
    .insert(actionRevisions)
    .values({
      workspaceId: auth.workspaceId,
      proposalId,
      revisionNumber: 1,
      payload: { to: "priya@example.com", body: "hello" },
    })
    .returning();
  const [proposal] = await db.select().from(actionProposals).where(eq(actionProposals.id, proposalId));
  return { proposal, revision };
}

suite("decideProposal", () => {
  it("a revision pins the exact sender identity at creation, and approval never rewrites it", async () => {
    const auth = await seed("pin");
    const [account] = await db
      .insert(externalAccounts)
      .values({
        workspaceId: auth.workspaceId,
        provider: "gmail",
        alias: "work-gmail",
        status: "active",
        composioConnectedAccountId: `ca_${crypto.randomUUID()}`,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning();
    const { proposal } = await seedProposal(auth, "pin");
    await db.update(actionProposals).set({ accountAlias: "work-gmail" }).where(eq(actionProposals.id, proposal.id));

    const revised = await commands.reviseProposal(auth, {
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      payload: { to: "priya@example.com", body: "revised wording" },
      preview: { to: "priya@example.com" },
    });
    const [pinned] = await db.select().from(actionRevisions).where(eq(actionRevisions.id, revised.revisionId));
    const expected = {
      resolved: true,
      externalAccountId: account.id,
      connectedAccountId: account.composioConnectedAccountId,
      alias: "work-gmail",
      sender: "work-gmail",
    };
    expect((pinned.payload as Record<string, unknown>).accountPin).toEqual(expected);
    expect((pinned.preview as Record<string, unknown>).accountPin).toEqual(expected);

    // Approving binds the pinned revision unchanged: the decision writes no
    // identity of its own and never mutates what the reviewer saw.
    await commands.decideProposal(auth, {
      proposalId: proposal.id,
      expectedVersion: revised.version,
      revisionId: revised.revisionId,
      decision: "approved",
    });
    const [after] = await db.select().from(actionRevisions).where(eq(actionRevisions.id, revised.revisionId));
    expect(after.payload).toEqual(pinned.payload);
    expect(after.preview).toEqual(pinned.preview);
  });

  it("a revision written with no resolvable account pins resolved:false so execution must refuse", async () => {
    const auth = await seed("pin-unresolved");
    const { proposal } = await seedProposal(auth, "pin-unresolved");

    const revised = await commands.reviseProposal(auth, {
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      payload: { to: "priya@example.com", body: "revised wording" },
    });

    const [pinned] = await db.select().from(actionRevisions).where(eq(actionRevisions.id, revised.revisionId));
    expect((pinned.payload as Record<string, unknown>).accountPin).toEqual({ resolved: false, alias: null, provider: "gmail" });
  });

  it("approving flips the status, writes the review, the audit row and the receipt in one transaction", async () => {
    const auth = await seed("decide-approve");
    const { proposal, revision } = await seedProposal(auth, "a1");

    const result = await commands.decideProposal(auth, {
      idempotencyKey: crypto.randomUUID(),
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      revisionId: revision.id,
      decision: "approved",
      note: "Looks right",
    });

    expect(result.version).toBe(proposal.version + 1);
    const [after] = await db.select().from(actionProposals).where(eq(actionProposals.id, proposal.id));
    expect(after.status).toBe("approved");
    expect(after.decidedBy).toBe(auth.userId);
    expect(after.decidedAt).not.toBeNull();

    const reviews = await db.select().from(actionReviews).where(eq(actionReviews.proposalId, proposal.id));
    expect(reviews).toHaveLength(1);
    expect(reviews[0].decision).toBe("approved");
    expect(reviews[0].revisionId).toBe(revision.id);
    expect(reviews[0].note).toBe("Looks right");

    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.subjectId, proposal.id)));
    expect(audits.map((a) => a.action)).toContain("actions.proposal_decided");
  });

  it("a retried click replays the receipt and never writes a second review", async () => {
    const auth = await seed("decide-replay");
    const { proposal, revision } = await seedProposal(auth, "r1");
    const idempotencyKey = crypto.randomUUID();
    const input = {
      idempotencyKey,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      revisionId: revision.id,
      decision: "rejected" as const,
    };

    const first = await commands.decideProposal(auth, input);
    // The retry renders the same intent: same key, same request body.
    const second = await commands.decideProposal(auth, input);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);

    const reviews = await db.select().from(actionReviews).where(eq(actionReviews.proposalId, proposal.id));
    expect(reviews).toHaveLength(1);
    const receipts = await db
      .select()
      .from(requestReceipts)
      .where(and(eq(requestReceipts.workspaceId, auth.workspaceId), eq(requestReceipts.idempotencyKey, idempotencyKey)));
    expect(receipts).toHaveLength(1);
  });

  it("a stale rendered version is a conflict, not a silent overwrite", async () => {
    const auth = await seed("decide-conflict");
    const { proposal, revision } = await seedProposal(auth, "c1");

    await commands.decideProposal(auth, {
      idempotencyKey: crypto.randomUUID(),
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      revisionId: revision.id,
      decision: "approved",
    });

    await expect(
      commands.decideProposal(auth, {
        idempotencyKey: crypto.randomUUID(),
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        revisionId: revision.id,
        decision: "rejected",
      }),
    ).rejects.toMatchObject({ code: "proposal_conflict" });

    const [after] = await db.select().from(actionProposals).where(eq(actionProposals.id, proposal.id));
    expect(after.status).toBe("approved");
  });

  it("a decision against anything but the latest revision is refused", async () => {
    const auth = await seed("decide-stale-revision");
    const { proposal, revision } = await seedProposal(auth, "s1");

    await commands.reviseProposal(auth, {
      idempotencyKey: crypto.randomUUID(),
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      payload: { to: "priya@example.com", body: "edited" },
    });

    await expect(
      commands.decideProposal(auth, {
        idempotencyKey: crypto.randomUUID(),
        proposalId: proposal.id,
        expectedVersion: proposal.version + 1,
        revisionId: revision.id,
        decision: "approved",
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
  });

  it("another workspace's proposal id is simply not found", async () => {
    const auth = await seed("decide-tenant-a");
    const other = await seed("decide-tenant-b");
    const { proposal, revision } = await seedProposal(auth, "t1");

    await expect(
      commands.decideProposal(other, {
        idempotencyKey: crypto.randomUUID(),
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        revisionId: revision.id,
        decision: "approved",
      }),
    ).rejects.toMatchObject({ code: "proposal_not_found" });
  });
});

suite("reviseProposal", () => {
  it("appends an immutable revision and bumps the version", async () => {
    const auth = await seed("revise-happy");
    const { proposal, revision } = await seedProposal(auth, "v1");

    const result = await commands.reviseProposal(auth, {
      idempotencyKey: crypto.randomUUID(),
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      payload: { to: "priya@example.com", body: "second draft" },
    });

    expect(result.revisionNumber).toBe(revision.revisionNumber + 1);
    expect(result.version).toBe(proposal.version + 1);

    const revisions = await db
      .select()
      .from(actionRevisions)
      .where(eq(actionRevisions.proposalId, proposal.id))
      .orderBy(desc(actionRevisions.revisionNumber));
    expect(revisions).toHaveLength(2);
    expect(revisions[0].payload).toMatchObject({ body: "second draft" });
    // The first revision is untouched: revisions are immutable history.
    expect(revisions[1].payload).toMatchObject({ body: "hello" });

    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.subjectId, proposal.id)));
    expect(audits.map((a) => a.action)).toContain("actions.proposal_revised");
  });

  it("a replayed save returns the same revision instead of appending a third", async () => {
    const auth = await seed("revise-replay");
    const { proposal } = await seedProposal(auth, "v2");
    const idempotencyKey = crypto.randomUUID();
    const input = {
      idempotencyKey,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      payload: { to: "priya@example.com", body: "second draft" },
    };

    const first = await commands.reviseProposal(auth, input);
    const second = await commands.reviseProposal(auth, input);

    expect(second.replayed).toBe(true);
    expect(second.revisionId).toBe(first.revisionId);
    const revisions = await db.select().from(actionRevisions).where(eq(actionRevisions.proposalId, proposal.id));
    expect(revisions).toHaveLength(2);
  });

  it("editing a decided proposal is refused: a changed intent is a new proposal", async () => {
    const auth = await seed("revise-decided");
    const { proposal, revision } = await seedProposal(auth, "v3");
    await commands.decideProposal(auth, {
      idempotencyKey: crypto.randomUUID(),
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      revisionId: revision.id,
      decision: "rejected",
    });

    const [decided] = await db.select().from(actionProposals).where(eq(actionProposals.id, proposal.id));
    await expect(
      commands.reviseProposal(auth, {
        idempotencyKey: crypto.randomUUID(),
        proposalId: proposal.id,
        expectedVersion: decided.version,
        payload: { body: "too late" },
      }),
    ).rejects.toMatchObject({ code: "proposal_conflict" });
  });
});
