import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * C03 outreach invariants: drafts are replay-safe, edits and cancellation
 * hold only while the draft is open, the approval gate links exactly one
 * proposal per draft, and nothing in the module produces an external send.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let correspondence: typeof import("@/domains/crm/correspondence");
let crm: typeof import("@/domains/crm/commands");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  correspondence = await import("@/domains/crm/correspondence");
  crm = await import("@/domains/crm/commands");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

async function auditCount(auth: { workspaceId: string }, subjectId: string) {
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, auth.workspaceId));
  return rows.filter((row) => row.subjectId === subjectId).length;
}

suite("correspondence", () => {
  it("drafts against a real contact, replaying the idempotency key once", async () => {
    const auth = await seed("corr-draft");
    const contact = await crm.createContact(auth, { fullName: "Ada Lovelace" });

    const key = crypto.randomUUID();
    const first = await correspondence.draftCorrespondence(auth, {
      contactId: contact.id,
      subject: "Thursday works",
      body: "Confirming our review session.",
      idempotencyKey: key,
    });
    expect(first.state).toBe("drafted");
    const replay = await correspondence.draftCorrespondence(auth, {
      contactId: contact.id,
      subject: "Thursday works",
      body: "Confirming our review session.",
      idempotencyKey: key,
    });
    expect(replay.id).toBe(first.id);
    expect((await correspondence.listCorrespondence(auth))).toHaveLength(1);
    expect(await auditCount(auth, first.id)).toBe(1);

    await expect(
      correspondence.draftCorrespondence(auth, { contactId: crypto.randomUUID(), body: "hi" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("edits and cancels only while the draft is open, version-checked", async () => {
    const auth = await seed("corr-edit");
    const contact = await crm.createContact(auth, { fullName: "Grace Hopper" });
    const draft = await correspondence.draftCorrespondence(auth, { contactId: contact.id, body: "first pass" });

    await expect(
      correspondence.updateCorrespondenceDraft(auth, { correspondenceId: draft.id, expectedVersion: draft.version + 1, body: "stale" }),
    ).rejects.toMatchObject({ code: "stale_write" });

    const edited = await correspondence.updateCorrespondenceDraft(auth, {
      correspondenceId: draft.id,
      expectedVersion: draft.version,
      subject: "Compilers",
      body: "second pass",
    });
    expect(edited.body).toBe("second pass");

    const cancelled = await correspondence.cancelCorrespondence(auth, {
      correspondenceId: draft.id,
      expectedVersion: edited.version,
    });
    expect(cancelled.state).toBe("cancelled");

    await expect(
      correspondence.updateCorrespondenceDraft(auth, { correspondenceId: draft.id, expectedVersion: cancelled.version, body: "ghost" }),
    ).rejects.toMatchObject({ code: "stale_write" });
  });

  it("the approval gate links one proposal and never sends", async () => {
    const auth = await seed("corr-gate");
    const contact = await crm.createContact(auth, { fullName: "Katherine Johnson" });
    const draft = await correspondence.draftCorrespondence(auth, { contactId: contact.id, subject: "Orbits", body: "Numbers attached." });

    const first = await correspondence.requestSendApproval(auth, { correspondenceId: draft.id, expectedVersion: draft.version });
    expect(first.alreadyRequested).toBe(false);
    expect(first.correspondence.actionProposalId).toBe(first.proposalId);
    // The gate does not move the draft: no send happened, none is queued.
    expect(first.correspondence.state).toBe("drafted");

    const again = await correspondence.requestSendApproval(auth, {
      correspondenceId: draft.id,
      expectedVersion: first.correspondence.version,
    });
    expect(again.alreadyRequested).toBe(true);
    expect(again.proposalId).toBe(first.proposalId);

    expect(await auditCount(auth, draft.id)).toBe(2); // drafted + send_requested
  });
});
