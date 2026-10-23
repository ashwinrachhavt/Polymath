import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionAttempts, actionProposals, actionRevisions } from "@/domains/actions/schema";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * AI revisions to a saved artifact are proposals until the owner approves:
 *  1. approval appends a new version and never overwrites the old one;
 *  2. a revision proposed against a version that is no longer current
 *     refuses, because the words it changed are gone;
 *  3. the run's frozen snapshot must still grant artifacts.revise;
 *  4. a retried approval reads the settled attempt instead of appending
 *     a second version.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let proposals: typeof import("@/domains/knowledge/revision-proposals");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  proposals = await import("@/domains/knowledge/revision-proposals");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  return { auth: ownerAuth(userId, workspaceId), userId, workspaceId };
}

type RunState = typeof agentRuns.$inferInsert.state;

async function seedRun(workspaceId: string, userId: string, allowedTools: string[], state: RunState = "running") {
  const [profile] = await db
    .insert(agentProfiles)
    .values({ workspaceId, name: `alfred-${crypto.randomUUID()}` })
    .returning();
  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId,
      agentProfileId: profile.id,
      objective: "Tighten the architecture comparison",
      state,
      policySnapshot: { allowedTools },
      createdBy: userId,
    })
    .returning();
  return run.id;
}

async function seedArtifact(workspaceId: string, userId: string) {
  const [artifact] = await db
    .insert(artifacts)
    .values({ workspaceId, kind: "note", title: "Architecture comparison", status: "reviewed" })
    .returning();
  const [v1] = await db
    .insert(artifactVersions)
    .values({ workspaceId, artifactId: artifact.id, versionNumber: 1, content: { type: "doc", content: [] }, plainText: "v1", reason: "created", createdBy: userId })
    .returning();
  await db.update(artifacts).set({ currentVersionId: v1.id }).where(eq(artifacts.id, artifact.id));
  return { artifact, v1 };
}

async function propose(auth: ReturnType<typeof ownerAuth>, runId: string, artifactId: string, dedupeId = crypto.randomUUID()) {
  const { proposalId, deduplicated } = await proposals.proposeArtifactRevision(auth, {
    artifactId,
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "v2" }] }] },
    plainText: "v2",
    note: "Tightened the trade-off section",
    dedupeKey: `run-${runId}-${dedupeId}`,
    runId,
  });
  const [[row], [revision]] = await Promise.all([
    db.select().from(actionProposals).where(eq(actionProposals.id, proposalId)),
    db.select().from(actionRevisions).where(eq(actionRevisions.proposalId, proposalId)),
  ]);
  return { proposalId, deduplicated, version: row.version, revisionId: revision.id };
}

async function versionsFor(artifactId: string) {
  return db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, artifactId)).orderBy(artifactVersions.versionNumber);
}

suite("artifact revision proposals", () => {
  it("approval appends a new version and keeps the old; a replay appends nothing twice", async () => {
    const { auth, userId, workspaceId } = await seed("art-rev-ok");
    const runId = await seedRun(workspaceId, userId, ["artifacts.revise"]);
    const { artifact, v1 } = await seedArtifact(workspaceId, userId);
    const { proposalId, version, revisionId } = await propose(auth, runId, artifact.id);

    const first = await proposals.approveArtifactRevision(auth, { proposalId, expectedVersion: version, revisionId });
    expect(first).toMatchObject({ status: "executed" });
    const versions = await versionsFor(artifact.id);
    expect(versions).toHaveLength(2);
    expect(versions[1].plainText).toBe("v2");
    const [after] = await db.select().from(artifacts).where(eq(artifacts.id, artifact.id));
    expect(after.currentVersionId).toBe(versions[1].id);
    expect(versions[0].id).toBe(v1.id);

    const replay = await proposals.approveArtifactRevision(auth, { proposalId, expectedVersion: version, revisionId });
    expect(replay).toMatchObject({ status: "executed" });
    expect((replay as { versionId?: string }).versionId).toBe((first as { versionId?: string }).versionId);
    expect(await versionsFor(artifact.id)).toHaveLength(2);
  });

  it("refuses when the artifact changed after the proposal was made", async () => {
    const { auth, userId, workspaceId } = await seed("art-rev-stale");
    const runId = await seedRun(workspaceId, userId, ["artifacts.revise"]);
    const { artifact } = await seedArtifact(workspaceId, userId);
    const { proposalId, version, revisionId } = await propose(auth, runId, artifact.id);

    // The person edits between proposal and approval: v2 becomes current.
    const [persons] = await db
      .insert(artifactVersions)
      .values({ workspaceId, artifactId: artifact.id, versionNumber: 2, content: { type: "doc", content: [] }, plainText: "person edit", reason: "edited", createdBy: userId })
      .returning();
    await db.update(artifacts).set({ currentVersionId: persons.id }).where(eq(artifacts.id, artifact.id));

    await expect(
      proposals.approveArtifactRevision(auth, { proposalId, expectedVersion: version, revisionId }),
    ).rejects.toBeInstanceOf(proposals.ArtifactReviseNotAllowedError);
    expect(await versionsFor(artifact.id)).toHaveLength(2);
    const [after] = await db.select().from(artifacts).where(eq(artifacts.id, artifact.id));
    expect(after.currentVersionId).toBe(persons.id);
  });

  it("refuses when the run's snapshot does not grant artifacts.revise", async () => {
    const { auth, userId, workspaceId } = await seed("art-rev-cap");
    const runId = await seedRun(workspaceId, userId, ["tasks.read"]);
    const { artifact } = await seedArtifact(workspaceId, userId);
    const { proposalId, version, revisionId } = await propose(auth, runId, artifact.id);

    await expect(
      proposals.approveArtifactRevision(auth, { proposalId, expectedVersion: version, revisionId }),
    ).rejects.toBeInstanceOf(proposals.ArtifactReviseNotAllowedError);
    expect(await versionsFor(artifact.id)).toHaveLength(1);
    expect(await db.select().from(actionAttempts).where(eq(actionAttempts.proposalId, proposalId))).toHaveLength(0);
  });

  it("the same dedupe key resolves one proposal, not two", async () => {
    const { auth, userId, workspaceId } = await seed("art-rev-dedupe");
    const runId = await seedRun(workspaceId, userId, ["artifacts.revise"]);
    const { artifact } = await seedArtifact(workspaceId, userId);
    const a = await propose(auth, runId, artifact.id, "rev-1");
    const b = await propose(auth, runId, artifact.id, "rev-1");
    expect(a.proposalId).toBe(b.proposalId);
    expect(b.deduplicated).toBe(true);
    expect(await db.select().from(actionRevisions).where(eq(actionRevisions.proposalId, a.proposalId))).toHaveLength(1);
  });

  it("a foreign workspace cannot approve the proposal", async () => {
    const { auth, userId, workspaceId } = await seed("art-rev-home");
    const other = await seed("art-rev-away");
    const runId = await seedRun(workspaceId, userId, ["artifacts.revise"]);
    const { artifact } = await seedArtifact(workspaceId, userId);
    const { proposalId, version, revisionId } = await propose(auth, runId, artifact.id);

    await expect(
      proposals.approveArtifactRevision(other.auth, { proposalId, expectedVersion: version, revisionId }),
    ).rejects.toThrow();
    expect(await versionsFor(artifact.id)).toHaveLength(1);
  });
});
