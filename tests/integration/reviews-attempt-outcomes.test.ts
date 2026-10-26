import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionAttempts, actionProposals, actionRevisions, providerObservations } from "@/domains/actions/schema";
import { latestAttemptOutcomes } from "@/domains/actions/queries";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The review card's persisted-outcome loader, against real Postgres. The
 * properties this file exists to prove:
 *  1. tenant scoping - another workspace's attempt is never read;
 *  2. stable ordering - the NEWEST attempt per proposal decides the outcome
 *     (an older success must not mask a newer failure, or vice versa);
 *  3. no observation leak - a design link attaches only from the latest
 *     attempt's own canva observation, and only when the URL the provider
 *     returned passes safeCanvaDesignUrl (a lookalike host renders nothing).
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let counter = 0;

beforeAll(() => {
  if (!handle) return;
  ({ db } = handle);
});
afterAll(async () => {
  await handle?.client.end();
});

async function seedProposal(workspaceId: string, userId: string, slug: string) {
  counter += 1;
  const [proposal] = await db
    .insert(actionProposals)
    .values({
      workspaceId,
      capability: "canva.design.import",
      riskClass: "external_write",
      status: "approved",
      title: `Import design brief to Canva (${slug})`,
      expectedEffect: "Creates one new Canva design.",
      dedupeKey: `outcomes:${workspaceId}:${slug}-${counter}`,
      decidedAt: new Date(),
      decidedBy: userId,
    })
    .returning();
  const [revision] = await db
    .insert(actionRevisions)
    .values({ workspaceId, proposalId: proposal.id, revisionNumber: 1, payload: {}, createdBy: userId })
    .returning();
  return { proposal, revision };
}

async function seedAttempt(input: {
  workspaceId: string;
  proposalId: string;
  revisionId: string;
  attemptNumber: number;
  status: "succeeded" | "failed" | "unknown";
  providerObjectId?: string | null;
  errorCode?: string | null;
  responseSummary?: unknown;
}) {
  const [attempt] = await db
    .insert(actionAttempts)
    .values({
      workspaceId: input.workspaceId,
      proposalId: input.proposalId,
      revisionId: input.revisionId,
      attemptNumber: input.attemptNumber,
      idempotencyKey: `exec:${input.proposalId}:${input.attemptNumber}`,
      status: input.status,
      reconciliation: "not_needed",
      providerObjectId: input.providerObjectId ?? null,
      errorCode: input.errorCode ?? null,
      responseSummary: (input.responseSummary ?? null) as Record<string, unknown> | null,
      endedAt: input.status === "unknown" ? null : new Date(),
    })
    .returning();
  return attempt;
}

async function seedObservation(input: { workspaceId: string; attemptId: string; proposalId: string; detail: unknown; provider?: string }) {
  await db.insert(providerObservations).values({
    workspaceId: input.workspaceId,
    attemptId: input.attemptId,
    proposalId: input.proposalId,
    provider: input.provider ?? "canva",
    providerObjectId: "design-x",
    observedState: "imported",
    detail: input.detail,
  });
}

suite("latestAttemptOutcomes", () => {
  it("the newest attempt decides: an older failure does not mask the settled success, and its own observation carries the link", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `outcomes-newest-${Date.now()}`);
    const { proposal, revision } = await seedProposal(workspaceId, userId, "newest");
    await seedAttempt({
      workspaceId,
      proposalId: proposal.id,
      revisionId: revision.id,
      attemptNumber: 1,
      status: "failed",
      errorCode: "canva_import_failed",
    });
    const second = await seedAttempt({
      workspaceId,
      proposalId: proposal.id,
      revisionId: revision.id,
      attemptNumber: 2,
      status: "succeeded",
      providerObjectId: "design-1",
    });
    await seedObservation({
      workspaceId,
      attemptId: second.id,
      proposalId: proposal.id,
      detail: { jobId: "job-1", designId: "design-1", editUrl: "https://www.canva.com/design/design-1/edit" },
    });

    const outcomes = await latestAttemptOutcomes(workspaceId, [proposal.id]);
    const loaded = outcomes.get(proposal.id);
    expect(loaded?.outcome).toMatchObject({ status: "sent", providerId: "design-1" });
    expect(loaded?.designUrl).toBe("https://www.canva.com/design/design-1/edit");
  });

  it("an older success's observation never leaks onto a newer failure", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `outcomes-nolook-${Date.now()}`);
    const { proposal, revision } = await seedProposal(workspaceId, userId, "noleak");
    const first = await seedAttempt({
      workspaceId,
      proposalId: proposal.id,
      revisionId: revision.id,
      attemptNumber: 1,
      status: "succeeded",
      providerObjectId: "design-old",
    });
    await seedObservation({
      workspaceId,
      attemptId: first.id,
      proposalId: proposal.id,
      detail: { jobId: "job-old", designId: "design-old", editUrl: "https://www.canva.com/design/design-old/edit" },
    });
    await seedAttempt({
      workspaceId,
      proposalId: proposal.id,
      revisionId: revision.id,
      attemptNumber: 2,
      status: "failed",
      errorCode: "canva_import_failed",
    });

    const outcomes = await latestAttemptOutcomes(workspaceId, [proposal.id]);
    const loaded = outcomes.get(proposal.id);
    expect(loaded?.outcome).toMatchObject({ status: "failed" });
    expect(loaded?.designUrl).toBeNull();
  });

  it("a lookalike or credentialed URL is dropped even on a settled success", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `outcomes-evil-${Date.now()}`);
    for (const [slug, editUrl] of [
      ["host", "https://canva.com.evil.example/design/x"],
      ["creds", "https://user:pw@www.canva.com/design/x"],
      ["scheme", "javascript:alert(1)"],
    ] as const) {
      const { proposal, revision } = await seedProposal(workspaceId, userId, `evil-${slug}`);
      const attempt = await seedAttempt({
        workspaceId,
        proposalId: proposal.id,
        revisionId: revision.id,
        attemptNumber: 1,
        status: "succeeded",
        providerObjectId: "design-x",
      });
      await seedObservation({ workspaceId, attemptId: attempt.id, proposalId: proposal.id, detail: { editUrl } });
      const outcomes = await latestAttemptOutcomes(workspaceId, [proposal.id]);
      expect(outcomes.get(proposal.id)?.outcome).toMatchObject({ status: "sent" });
      expect(outcomes.get(proposal.id)?.designUrl).toBeNull();
    }
  });

  it("another workspace's attempt is never read", async () => {
    const a = await seedWorkspace(db, `outcomes-tenanta-${Date.now()}`);
    const b = await seedWorkspace(db, `outcomes-tenantb-${Date.now()}`);
    const { proposal, revision } = await seedProposal(b.workspaceId, b.userId, "tenant-b");
    await seedAttempt({
      workspaceId: b.workspaceId,
      proposalId: proposal.id,
      revisionId: revision.id,
      attemptNumber: 1,
      status: "succeeded",
      providerObjectId: "design-b",
    });

    // Workspace A asking for B's proposal id gets nothing back.
    const outcomes = await latestAttemptOutcomes(a.workspaceId, [proposal.id]);
    expect(outcomes.has(proposal.id)).toBe(false);
  });

  it("a proposal with no attempt has no outcome entry", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `outcomes-none-${Date.now()}`);
    const { proposal } = await seedProposal(workspaceId, userId, "none");
    const outcomes = await latestAttemptOutcomes(workspaceId, [proposal.id]);
    expect(outcomes.has(proposal.id)).toBe(false);
  });
});
