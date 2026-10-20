import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ADR 0006 Q5: the owner approves anything external or sensitive; an admin
 * approves internal preparation; rejecting stays open to members.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let actions: typeof import("@/domains/actions/commands");
let tx: typeof import("@/lib/db-transaction");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  actions = await import("@/domains/actions/commands");
  tx = await import("@/lib/db-transaction");
});

afterAll(async () => {
  await handle?.client.end();
});

async function proposal(riskClass: "prepare" | "external_write") {
  const { userId, workspaceId } = await seedWorkspace(db, `tier-${riskClass}-${Date.now()}`);
  const owner = ownerAuth(userId, workspaceId);
  const { proposalId } = await tx.withTransaction((t) =>
    actions.createProposal(t, { workspaceId }, {
      capability: "x",
      riskClass,
      title: "t",
      expectedEffect: "e",
      dedupeKey: `tier:${workspaceId}`,
    }),
  );
  const rev = await actions.reviseProposal(owner, { proposalId, expectedVersion: 1, payload: { a: 1 } });
  return { owner, proposalId, revisionId: rev.revisionId, version: rev.version };
}

suite("approval tiers", () => {
  it("an admin cannot approve an external write; the owner can", async () => {
    const p = await proposal("external_write");
    const admin = { ...p.owner, role: "admin" as const };
    await expect(
      actions.decideProposal(admin, { proposalId: p.proposalId, expectedVersion: p.version, revisionId: p.revisionId, decision: "approved" }),
    ).rejects.toThrow(/Requires owner/);
    await expect(
      actions.decideProposal(p.owner, { proposalId: p.proposalId, expectedVersion: p.version, revisionId: p.revisionId, decision: "approved" }),
    ).resolves.toMatchObject({ replayed: false });
  });

  it("an admin approves internal preparation; a member cannot, but may reject", async () => {
    const p = await proposal("prepare");
    const member = { ...p.owner, role: "member" as const };
    await expect(
      actions.decideProposal(member, { proposalId: p.proposalId, expectedVersion: p.version, revisionId: p.revisionId, decision: "approved" }),
    ).rejects.toThrow(/Requires admin/);
    const admin = { ...p.owner, role: "admin" as const };
    await expect(
      actions.decideProposal(admin, { proposalId: p.proposalId, expectedVersion: p.version, revisionId: p.revisionId, decision: "approved" }),
    ).resolves.toMatchObject({ replayed: false });

    const q = await proposal("external_write");
    const memberQ = { ...q.owner, role: "member" as const };
    await expect(
      actions.decideProposal(memberQ, { proposalId: q.proposalId, expectedVersion: q.version, revisionId: q.revisionId, decision: "rejected" }),
    ).resolves.toMatchObject({ replayed: false });
  });
});
