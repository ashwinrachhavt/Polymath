import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionRevisions } from "@/domains/actions/schema";
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
