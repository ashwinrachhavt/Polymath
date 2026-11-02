import { and, eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agentProfiles, agentRuns, repoCheckpoints } from "@/domains/agents/schema";
import { auditEvents, blobObjects } from "@/domains/audit/schema";
import { artifactLinks, artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import { CAPTURE_DISCLOSURE, buildCapturePlan, collectGitState } from "../../scripts/workbench/capture-core";

/*
 * Blob-dedupe integration: the same diff bytes must reuse one blob_objects
 * row across checkpoints (the append-only table never rewrites history, it
 * re-points at shared bytes). Runs against the real test database when
 * TEST_DATABASE_URL is set; skips otherwise, like the other db suites.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
type HandleDb = NonNullable<typeof handle>["db"];
const holder: { db: HandleDb | undefined } = { db: undefined };

vi.mock("@/lib/db", () => ({ get db() { return holder.db as never; } }));
vi.mock("@/lib/db-transaction", () => ({ withTransaction: async () => { throw new Error("script entrypoint is not used in tests"); } }));

const { captureToWorkspace } = await import("../../scripts/workbench/capture");

function git(repoPath: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

suite("workbench checkpoint capture", () => {
  let auth: ReturnType<typeof ownerAuth>;
  let profileId: string;

  beforeAll(async () => {
    if (!handle) return;
    // The local object-store root is read per putBlob call, so pointing it at
    // a throwaway directory here keeps real blob bytes out of the repo checkout.
    process.env.AXIOM_LOCAL_BLOB_DIR = mkdtempSync(join(tmpdir(), "wb-blobs-"));
    holder.db = handle.db;
    // Slug is unique per run: seedWorkspace inserts the user without an
    // upsert, so a fixed slug fails the second local run against one DB.
    const seed = await seedWorkspace(handle.db, `wb-checkpoint-${Date.now()}`);
    auth = ownerAuth(seed.userId, seed.workspaceId);
    await handle.db
      .insert(agentProfiles)
      .values({ workspaceId: auth.workspaceId, name: "polymath", createdBy: auth.userId, updatedBy: auth.userId })
      .onConflictDoNothing();
    const [profile] = await handle.db
      .select({ id: agentProfiles.id })
      .from(agentProfiles)
      .where(and(eq(agentProfiles.workspaceId, auth.workspaceId), eq(agentProfiles.name, "polymath")));
    profileId = profile.id;
  });

  async function createRun(objective: string): Promise<string> {
    const [run] = await holder.db!
      .insert(agentRuns)
      .values({
        workspaceId: auth.workspaceId,
        agentProfileId: profileId,
        objective,
        policySnapshot: {},
        state: "succeeded",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: agentRuns.id });
    return run.id;
  }

  /** A real fixture repo with one shell-made (sed) change; `variant` keeps diffs distinct per test. */
  async function makePlan(runId: string | null, variant: string) {
    const repoPath = mkdtempSync(join(tmpdir(), "wb-int-"));
    git(repoPath, "init", "-b", "main");
    git(repoPath, "config", "user.email", "fixture@example.com");
    git(repoPath, "config", "user.name", "Fixture");
    const filePath = join(repoPath, "app.ts");
    writeFileSync(filePath, `export const value = 'before'; // ${variant}\n`);
    git(repoPath, "add", ".");
    git(repoPath, "commit", "-m", "base");
    const baseSha = git(repoPath, "rev-parse", "HEAD").trim();
    execFileSync("sed", ["-i", "s/before/after/", filePath]);
    git(repoPath, "add", ".");
    git(repoPath, "commit", "-m", "shell-made change");
    const state = await collectGitState({ repoPath, baseSha });
    const plan = await buildCapturePlan({
      state,
      workspaceId: auth.workspaceId,
      runId,
      testResults: [{ name: "auth login", ok: true, runAt: "2026-11-02T00:00:00.000Z" }],
      decisionNote: null,
      decisionStatus: "inferred",
    });
    return { state, plan };
  }

  it("captures a checkpoint end to end: row, blob, artifact, run link, audit event", async () => {
    const runId = await createRun("understand the checkout change");
    const { plan } = await makePlan(runId, "e2e");
    const result = await holder.db!.transaction((tx) => captureToWorkspace(auth, plan, tx));

    const [checkpoint] = await holder.db!.select().from(repoCheckpoints).where(eq(repoCheckpoints.id, result.checkpointId));
    expect(checkpoint.workspaceId).toBe(auth.workspaceId);
    expect(checkpoint.runId).toBe(runId);
    expect(checkpoint.baseCommitSha).toBe(plan.baseSha);
    expect(checkpoint.commitSha).toBe(plan.headSha);
    expect(checkpoint.diffBlobId).toBe(result.blobId);
    expect(checkpoint.decisionStatus).toBe("inferred");
    expect(checkpoint.testResults).toEqual([{ name: "auth login", ok: true, runAt: "2026-11-02T00:00:00.000Z" }]);

    const [blob] = await holder.db!.select().from(blobObjects).where(eq(blobObjects.id, result.blobId));
    expect(blob.contentHash).toBe(plan.diffHash);
    expect(blob.sizeBytes).toBe(plan.diffByteLength);
    expect(blob.mimeType).toBe("text/x-diff");
    expect(result.diffBlobDeduped).toBe(false);

    const [artifact] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, result.artifactId));
    expect(artifact.kind).toBe("report");
    expect(artifact.status).toBe("generated");
    expect(artifact.producedByRunId).toBe(runId);
    const [version] = await holder.db!.select().from(artifactVersions).where(eq(artifactVersions.artifactId, artifact.id));
    expect(version.versionNumber).toBe(1);
    expect(version.plainText).toContain(CAPTURE_DISCLOSURE);

    const links = await holder.db!
      .select()
      .from(artifactLinks)
      .where(and(eq(artifactLinks.artifactId, artifact.id), eq(artifactLinks.targetType, "run"), eq(artifactLinks.targetId, runId)));
    expect(links).toHaveLength(1);
    expect(links[0].linkType).toBe("explains");
    expect(result.linkCreated).toBe(true);

    const events = await holder.db!.select().from(auditEvents).where(eq(auditEvents.subjectId, result.checkpointId));
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("workbench.checkpoint_captured");
    expect(events[0].actorKind).toBe("system");
  });

  it("dedupes the diff blob and appends a second checkpoint on re-capture", async () => {
    const { plan } = await makePlan(null, "dedupe");
    const first = await holder.db!.transaction((tx) => captureToWorkspace(auth, plan, tx));
    const second = await holder.db!.transaction((tx) => captureToWorkspace(auth, plan, tx));

    expect(second.diffBlobDeduped).toBe(true);
    expect(second.blobId).toBe(first.blobId);
    // Dedupe is per workspace: the lookup and the unique index are scoped by
    // workspace_id, so other workspaces may hold their own row for the same bytes.
    const blobs = await holder.db!
      .select()
      .from(blobObjects)
      .where(and(eq(blobObjects.workspaceId, auth.workspaceId), eq(blobObjects.contentHash, plan.diffHash)));
    expect(blobs).toHaveLength(1);
    const checkpoints = await holder.db!
      .select()
      .from(repoCheckpoints)
      .where(and(eq(repoCheckpoints.workspaceId, auth.workspaceId), eq(repoCheckpoints.commitSha, plan.headSha)));
    expect(checkpoints).toHaveLength(2);
  });

  it("captures without a run and writes no link", async () => {
    const { plan } = await makePlan(null, "no-run");
    const result = await holder.db!.transaction((tx) => captureToWorkspace(auth, plan, tx));

    expect(result.linkCreated).toBe(false);
    const [artifact] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, result.artifactId));
    expect(artifact.producedByRunId).toBeNull();
    const links = await holder.db!.select().from(artifactLinks).where(eq(artifactLinks.artifactId, artifact.id));
    expect(links).toHaveLength(0);
  });
});
