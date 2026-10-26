import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionProposals, actionRevisions } from "@/domains/actions/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-284 persistence semantics, against a real database (CI Postgres): a
 * triage proposal lands pending with its single revision; a retry of the
 * same triage replays it; a changed triage for the same issue is a new
 * proposal rather than a silent edit. Nothing here calls GitHub - there is
 * no executor for the capability by design.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let triage: typeof import("@/domains/integrations/github-triage");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  triage = await import("@/domains/integrations/github-triage");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

type Auth = ReturnType<typeof ownerAuth>;

async function latestRevision(auth: Auth, proposalId: string) {
  const [row] = await db
    .select()
    .from(actionRevisions)
    .where(and(eq(actionRevisions.workspaceId, auth.workspaceId), eq(actionRevisions.proposalId, proposalId)))
    .orderBy(desc(actionRevisions.revisionNumber))
    .limit(1);
  return row;
}

const base = {
  owner: "ashwinrachhavt",
  repo: "Polymath",
  issueNumber: 42,
  issueTitle: "Inbox badge keeps a count after filing",
  rationale: "Reproducible defect report with steps; bug fits.",
};

suite("github triage proposals", () => {
  it("lands pending with one revision carrying the exact proposed changes", async () => {
    const auth = await seed("triage-create");
    const result = await triage.proposeGitHubTriage(auth, {
      ...base,
      changes: { addLabels: ["bug"], assignees: ["ashwinrachhavt"] },
      dedupeKey: "wrun_sess:issue-42",
    });
    expect(result.deduplicated).toBe(false);
    const [row] = await db.select().from(actionProposals).where(eq(actionProposals.id, result.proposalId));
    expect(row.status).toBe("pending");
    expect(row.capability).toBe("github.issue.triage");
    expect(row.riskClass).toBe("prepare");
    expect(row.targetType).toBe("github_issue");
    expect(row.expiresAt).not.toBeNull();
    const revision = await latestRevision(auth, result.proposalId);
    const payload = revision.payload as { changes: { addLabels: string[]; assignees: string[] }; issueNumber: number };
    expect(payload.issueNumber).toBe(42);
    expect(payload.changes.addLabels).toEqual(["bug"]);
    expect(payload.changes.assignees).toEqual(["ashwinrachhavt"]);
  });

  it("replays the same triage instead of queuing a second proposal", async () => {
    const auth = await seed("triage-replay");
    const input = { ...base, changes: { addLabels: ["bug"] }, dedupeKey: "wrun_sess:issue-42" };
    const first = await triage.proposeGitHubTriage(auth, input);
    const second = await triage.proposeGitHubTriage(auth, input);
    expect(second.proposalId).toBe(first.proposalId);
    expect(second.deduplicated).toBe(true);
    const rows = await db.select().from(actionProposals).where(eq(actionProposals.workspaceId, auth.workspaceId));
    expect(rows).toHaveLength(1);
  });

  it("a changed triage for the same issue is a new proposal, never a silent edit", async () => {
    const auth = await seed("triage-changed");
    const first = await triage.proposeGitHubTriage(auth, { ...base, changes: { addLabels: ["bug"] }, dedupeKey: "wrun_sess:issue-42" });
    const second = await triage.proposeGitHubTriage(auth, { ...base, changes: { closeReason: "not_planned" }, dedupeKey: "wrun_sess:issue-42" });
    expect(second.proposalId).not.toBe(first.proposalId);
    expect(second.deduplicated).toBe(false);
    // The first proposal's revision still carries its original changes.
    const revision = await latestRevision(auth, first.proposalId);
    expect((revision.payload as { changes: { addLabels?: string[] } }).changes.addLabels).toEqual(["bug"]);
  });

  it("refuses an empty triage before touching the queue", async () => {
    const auth = await seed("triage-empty");
    await expect(triage.proposeGitHubTriage(auth, { ...base, changes: {}, dedupeKey: "wrun_sess:empty" })).rejects.toMatchObject({ code: "empty_changes" });
    const rows = await db.select().from(actionProposals).where(eq(actionProposals.workspaceId, auth.workspaceId));
    expect(rows).toHaveLength(0);
  });
});
