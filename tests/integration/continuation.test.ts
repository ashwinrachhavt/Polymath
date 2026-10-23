import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { actionProposals } from "@/domains/actions/schema";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
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

import { deriveContinuation } from "@/domains/knowledge/continuation";
import { getDraftDetail } from "@/domains/knowledge/studio";

/*
 * Continue is proposal-aware (the audit's Leave gap): a pending revision
 * proposal surfaces its artifact even when the artifact row has not changed
 * lately, ranks it first, and points at Reviews. Decided proposals stop
 * surfacing it.
 */
suite("proposal-aware continuation (Neon)", () => {
  let auth: ReturnType<typeof ownerAuth>;
  let oldArtifactId: string;
  let freshArtifactId: string;

  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
    const seed = await seedWorkspace(handle.db, `continuation-${Date.now()}`);
    auth = ownerAuth(seed.userId, seed.workspaceId);

    const [fresh] = await handle.db
      .insert(artifacts)
      .values({ workspaceId: seed.workspaceId, kind: "report", title: "Fresh draft", status: "draft", createdBy: seed.userId, updatedBy: seed.userId })
      .returning();
    freshArtifactId = fresh.id;

    const [old] = await handle.db
      .insert(artifacts)
      .values({ workspaceId: seed.workspaceId, kind: "report", title: "Old kept output", status: "reviewed", createdBy: seed.userId, updatedBy: seed.userId })
      .returning();
    oldArtifactId = old.id;
    // Make the kept output genuinely stale: proposal activity must not depend on the artifact's updated_at.
    await handle.db.execute(
      `update artifacts set updated_at = now() - interval '30 days' where id = '${old.id}'`,
    );
    const [v1] = await handle.db
      .insert(artifactVersions)
      .values({ workspaceId: seed.workspaceId, artifactId: old.id, versionNumber: 1, content: { text: "v1" }, plainText: "v1", reason: "generated", createdBy: seed.userId })
      .returning();
    await handle.db.execute(`update artifacts set current_version_id = '${v1.id}' where id = '${old.id}'`);

    await handle.db.insert(actionProposals).values({
      workspaceId: seed.workspaceId,
      capability: "artifacts.revise",
      riskClass: "prepare",
      status: "pending",
      targetType: "artifact",
      targetId: old.id,
      title: "Revise: Old kept output",
      expectedEffect: "Appends a revised version on approval.",
      dedupeKey: `revise-${old.id}-1`,
      createdBy: seed.userId,
      updatedBy: seed.userId,
    });
  });

  it("a waiting proposal surfaces the stale artifact first and links to Reviews", async () => {
    if (!handle) return;
    const items = await deriveContinuation(auth);
    expect(items[0]).toMatchObject({
      artifactId: oldArtifactId,
      pendingRevisions: 1,
      href: "/reviews",
      suggestedNextStep: "Review the proposed revision in Reviews.",
    });
    expect(items.map((i) => i.artifactId)).toContain(freshArtifactId);
  });

  it("deciding the proposal hands the artifact back to plain recency", async () => {
    if (!handle) return;
    await handle.db
      .update(actionProposals)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(eq(actionProposals.targetId, oldArtifactId));
    const items = await deriveContinuation(auth);
    const old = items.find((i) => i.artifactId === oldArtifactId);
    // Stale and nothing waiting: the fresh draft outranks it now.
    expect(items[0].artifactId).toBe(freshArtifactId);
    expect(old?.pendingRevisions ?? 0).toBe(0);
  });

  it("getDraftDetail reports the waiting proposal count", async () => {
    if (!handle) return;
    await handle.db
      .insert(actionProposals)
      .values({
        workspaceId: auth.workspaceId,
        capability: "artifacts.revise",
        riskClass: "prepare",
        status: "pending",
        targetType: "artifact",
        targetId: oldArtifactId,
        title: "Revise again",
        expectedEffect: "Appends a revised version on approval.",
        dedupeKey: `revise-${oldArtifactId}-2`,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      });
    const detail = (await getDraftDetail(auth, oldArtifactId))!;
    expect(detail!.pendingRevisions).toBe(1);
  });
});
