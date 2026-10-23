import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { artifacts } from "@/domains/knowledge/schema";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { discardDraft, draftsForRuns, listDrafts, saveDraft } from "@/domains/knowledge/studio";

suite("generated drafts (Neon)", () => {
  let auth: ReturnType<typeof ownerAuth>;
  let runId: string;

  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
    const seed = await seedWorkspace(handle.db, `drafts-${Date.now()}`);
    auth = ownerAuth(seed.userId, seed.workspaceId);
    const [profile] = await handle.db
      .insert(agentProfiles)
      .values({ workspaceId: seed.workspaceId, name: "alfred", createdBy: seed.userId, updatedBy: seed.userId })
      .returning();
    const [run] = await handle.db
      .insert(agentRuns)
      .values({ workspaceId: seed.workspaceId, agentProfileId: profile.id, objective: "draft a brief", policySnapshot: {}, state: "succeeded", createdBy: seed.userId, updatedBy: seed.userId })
      .returning();
    runId = run.id;
  });

  it("draftsForRuns keys artifacts by their producing run", async () => {
    if (!handle) return;
    const [artifact] = await handle.db
      .insert(artifacts)
      .values({ workspaceId: auth.workspaceId, kind: "report", title: "Brief", status: "draft", producedByRunId: runId, createdBy: auth.userId, updatedBy: auth.userId })
      .returning();
    const map = await draftsForRuns(auth, [runId, crypto.randomUUID()]);
    expect(map.get(runId)).toEqual({ artifactId: artifact.id, status: "draft", version: artifact.version });
    expect(map.size).toBe(1);
  });

  it("listDrafts returns open drafts only, and decisions move them out", async () => {
    if (!handle) return;
    const map = await draftsForRuns(auth, [runId]);
    const artifactId = map.get(runId)!.artifactId;
    expect((await listDrafts(auth)).map((d) => d.artifactId)).toContain(artifactId);
    await saveDraft(auth, { artifactId });
    expect((await listDrafts(auth)).map((d) => d.artifactId)).not.toContain(artifactId);
    expect((await draftsForRuns(auth, [runId])).get(runId)!.status).toBe("reviewed");
    // A decided draft cannot be decided again.
    await expect(discardDraft(auth, { artifactId })).rejects.toThrow(/not found|already decided/i);
  });

  it("discard archives and hides the artifact", async () => {
    if (!handle) return;
    const [artifact] = await handle.db
      .insert(artifacts)
      .values({ workspaceId: auth.workspaceId, kind: "report", title: "Second", status: "draft", producedByRunId: runId, createdBy: auth.userId, updatedBy: auth.userId })
      .returning();
    await discardDraft(auth, { artifactId: artifact.id });
    expect((await listDrafts(auth)).map((d) => d.artifactId)).not.toContain(artifact.id);
    const [row] = await handle.db.select({ status: artifacts.status, archivedAt: artifacts.archivedAt }).from(artifacts).where(eq(artifacts.id, artifact.id));
    expect(row.status).toBe("archived");
    expect(row.archivedAt).not.toBeNull();
  });
});
