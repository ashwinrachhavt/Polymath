import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
const holder = vi.hoisted(() => ({
  auth: null as unknown as ReturnType<typeof ownerAuth>,
}));
vi.mock("@/lib/auth", () => ({
  getAuthContext: vi.fn(async () => holder.auth),
}));

import {
  actionAttempts,
  actionProposals,
  actionReviews,
  actionRevisions,
} from "@/domains/actions/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { designBriefDocxSha256 } from "@/domains/knowledge/design-brief-docx";
import type { DesignBrief } from "@/domains/knowledge/design-brief";
import {
  makeTestDb,
  ownerAuth,
  seedWorkspace,
} from "../helpers/test-workspace";

/*
 * decideProposalAction's refusal persistence, against real Postgres: a
 * committed approval whose execution is refused (Canva disabled here)
 * records the refusal in the review history so a reloaded card still shows
 * it. The properties this file exists to prove:
 *  1. concurrent identical refusals persist exactly ONE row (the write is
 *     serialized per proposal, so check-then-insert cannot double-write);
 *  2. re-approving a NEW revision records the refusal again - the dedupe
 *     is revision-scoped, so the fresh decision is not swallowed;
 *  3. a refusal never leaves an attempt row behind.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let actions: typeof import("@/app/(workspace)/reviews/actions");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  actions = await import("@/app/(workspace)/reviews/actions");
});
afterAll(async () => {
  await handle?.client.end();
});

const brief: DesignBrief = {
  title: "Launch one-pager",
  objective: "Align the team on the launch story.",
  audience: "Founders",
  keyMessage: "The research card becomes the pitch.",
  tone: ["direct"],
  format: "doc",
  visualDirection: "Sparse and typographic.",
  deliverables: ["One-pager"],
  constraints: null,
  callToAction: null,
};

const REFUSAL_NOTE =
  "Execution refused: Canva import is not enabled on this deployment; the import cannot be dispatched.";

let counter = 0;

async function seedPendingImport(slug: string) {
  counter += 1;
  const { userId, workspaceId } = await seedWorkspace(
    db,
    `${slug}-${Date.now()}-${counter}`,
  );
  const auth = ownerAuth(userId, workspaceId);
  holder.auth = auth;
  const alias = `canva-refusal-${counter}`;
  const [account] = await db
    .insert(externalAccounts)
    .values({
      workspaceId,
      provider: "canva",
      alias,
      status: "active",
      composioConnectedAccountId: `ca_${crypto.randomUUID()}`,
      createdBy: userId,
      updatedBy: userId,
    })
    .returning();
  const [proposal] = await db
    .insert(actionProposals)
    .values({
      workspaceId,
      capability: "canva.design.import",
      riskClass: "external_write",
      accountAlias: alias,
      title: `Import design brief "${brief.title}" to Canva`,
      expectedEffect: "Creates one new Canva design.",
      dedupeKey: `canva.design.import:${workspaceId}:artifact-${counter}:version-1`,
    })
    .returning();
  const revisionPayload = {
    title: `Design brief: ${brief.title}`,
    brief,
    docxSha256: designBriefDocxSha256(brief),
    accountPin: {
      resolved: true,
      externalAccountId: account.id,
      connectedAccountId: account.composioConnectedAccountId,
      alias,
      sender: alias,
    },
  };
  const [revision] = await db
    .insert(actionRevisions)
    .values({
      workspaceId,
      proposalId: proposal.id,
      revisionNumber: 1,
      payload: revisionPayload,
      preview: { title: brief.title },
      createdBy: userId,
    })
    .returning();
  return { auth, proposal, revision, revisionPayload, workspaceId, userId };
}

const refusalRows = async (proposalId: string) =>
  (
    await db
      .select()
      .from(actionReviews)
      .where(eq(actionReviews.proposalId, proposalId))
  ).filter((row) => row.note?.startsWith("Execution refused:"));

suite("decideProposalAction refusal persistence", () => {
  it("concurrent identical refusals persist exactly one review row and no attempt", async () => {
    const { proposal, revision } = await seedPendingImport("refusal-race");
    const decide = () =>
      actions.decideProposalAction({
        idempotencyKey: crypto.randomUUID(),
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        revisionId: revision.id,
        decision: "approved",
      });
    // One commits the decision, the other conflicts and falls through to the
    // same refused execution: both reach the persistence write together.
    const [first, second] = await Promise.all([decide(), decide()]);
    expect(first).toMatchObject({ ok: false, decided: true });
    expect(second).toMatchObject({ ok: false, decided: true });

    const refusals = await refusalRows(proposal.id);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.note).toBe(REFUSAL_NOTE);
    expect(refusals[0]!.revisionId).toBe(revision.id);
    expect(refusals[0]!.reviewedBy).toBeNull();

    const attempts = await db
      .select()
      .from(actionAttempts)
      .where(eq(actionAttempts.proposalId, proposal.id));
    expect(attempts).toHaveLength(0);
  });

  it("a replayed decide re-derives the same row instead of stacking a duplicate", async () => {
    const { proposal, revision } = await seedPendingImport("refusal-replay");
    const input = {
      idempotencyKey: crypto.randomUUID(),
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      revisionId: revision.id,
      decision: "approved" as const,
    };
    await actions.decideProposalAction(input);
    await actions.decideProposalAction(input);
    const refusals = await refusalRows(proposal.id);
    expect(refusals).toHaveLength(1);
  });

  it("re-approving a new revision records the refusal again under that revision", async () => {
    const { proposal, revision, revisionPayload, workspaceId, userId } =
      await seedPendingImport("refusal-revision");
    const first = await actions.decideProposalAction({
      idempotencyKey: crypto.randomUUID(),
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      revisionId: revision.id,
      decision: "approved",
    });
    expect(first).toMatchObject({ ok: false, decided: true });

    // The shape reviseProposal produces: a fresh revision, the proposal
    // pending again at a bumped version.
    const [revision2] = await db
      .insert(actionRevisions)
      .values({
        workspaceId,
        proposalId: proposal.id,
        revisionNumber: 2,
        payload: revisionPayload,
        preview: { title: brief.title },
        createdBy: userId,
      })
      .returning();
    const [reopened] = await db
      .update(actionProposals)
      .set({
        status: "pending",
        version: proposal.version + 2,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(actionProposals.id, proposal.id),
          eq(actionProposals.version, proposal.version + 1),
        ),
      )
      .returning();
    expect(reopened).toBeDefined();

    const second = await actions.decideProposalAction({
      idempotencyKey: crypto.randomUUID(),
      proposalId: proposal.id,
      expectedVersion: reopened!.version,
      revisionId: revision2.id,
      decision: "approved",
    });
    expect(second).toMatchObject({ ok: false, decided: true });

    const refusals = await refusalRows(proposal.id);
    expect(refusals).toHaveLength(2);
    expect(new Set(refusals.map((row) => row.revisionId))).toEqual(
      new Set([revision.id, revision2.id]),
    );
    expect(refusals.every((row) => row.note === REFUSAL_NOTE)).toBe(true);
  });
});
