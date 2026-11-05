import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import { artifacts, artifactVersions, canvases, canvasVersions } from "@/domains/knowledge/schema";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { DiagramError, guardMermaidSource, persistDiagram } from "@/domains/diagrams/diagrams";

/*
 * The diagram tool's persistence contract (spec art_Yi8Fwsqn §2, locked
 * decisions 2-3): create-or-refine in one append-only transaction, run
 * provenance on the artifact, and cross-workspace canvasId attempts failing
 * cleanly. Real Postgres — the version-pointer moves and unique-index
 * backoffs are exactly what mocks cannot prove.
 */

suite("diagram persistence (append-only create-or-refine)", () => {
  let ownerA: ReturnType<typeof ownerAuth>;
  let ownerB: ReturnType<typeof ownerAuth>;

  async function seededRun(workspaceId: string, userId: string, objective: string): Promise<string> {
    const [profile] = await holder
      .db!.insert(agentProfiles)
      .values({ workspaceId, name: "polymath", createdBy: userId, updatedBy: userId })
      .onConflictDoNothing()
      .returning();
    const profileId =
      profile?.id ??
      (
        await holder
          .db!.select({ id: agentProfiles.id })
          .from(agentProfiles)
          .where(eq(agentProfiles.workspaceId, workspaceId))
          .limit(1)
      )[0].id;
    const [run] = await holder
      .db!.insert(agentRuns)
      .values({
        workspaceId,
        agentProfileId: profileId,
        objective,
        policySnapshot: {},
        state: "running",
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    return run.id;
  }

  async function artifactVersionCount(artifactId: string): Promise<number> {
    const rows = await holder
      .db!.select({ versionNumber: artifactVersions.versionNumber })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, artifactId));
    return rows.length;
  }

  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
    const a = await seedWorkspace(handle.db, `diagrams-a-${Date.now()}`);
    const b = await seedWorkspace(handle.db, `diagrams-b-${Date.now()}`);
    ownerA = ownerAuth(a.userId, a.workspaceId);
    ownerB = ownerAuth(b.userId, b.workspaceId);
  });

  it("create persists artifact(kind diagram, producedByRunId) + v1 rows in both chains", async () => {
    if (!handle) return;
    const runId = await seededRun(ownerA.workspaceId, ownerA.userId, "draw the auth flow");
    const source = guardMermaidSourceOrThrow("flowchart TD\n  user[User] --> api[API] --> db[(Database)]");

    const result = await persistDiagram(ownerA, {
      title: "Auth flow",
      mermaid: source,
      diagramType: "flowchart",
      runId,
    });

    expect(result.version).toBe(1);
    const [artifact] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, result.artifactId));
    expect(artifact.kind).toBe("diagram");
    expect(artifact.status).toBe("generated");
    expect(artifact.producedByRunId).toBe(runId);
    expect(artifact.workspaceId).toBe(ownerA.workspaceId);
    expect(artifact.currentVersionId).toBeTruthy();
    const [version] = await holder
      .db!.select()
      .from(artifactVersions)
      .where(eq(artifactVersions.id, artifact.currentVersionId!));
    expect(version.versionNumber).toBe(1);
    expect(version.reason).toBe("generated");
    expect(version.content).toEqual({ type: "diagram", mermaid: source, diagramType: "flowchart" });
    expect(version.plainText).toBe(source);

    const [canvas] = await holder.db!.select().from(canvases).where(eq(canvases.id, result.canvasId));
    expect(canvas.artifactId).toBe(result.artifactId);
    expect(canvas.title).toBe("Auth flow");
    const [scene] = await holder.db!.select().from(canvasVersions).where(eq(canvasVersions.canvasId, result.canvasId));
    expect(scene.versionNumber).toBe(1);
    expect(scene.scene).toEqual({ format: "mermaid", mermaid: source, diagramType: "flowchart" });
  });

  it("refinement appends v2 to both chains, keeps v1 fetchable, moves the pointer", async () => {
    if (!handle) return;
    const runId = await seededRun(ownerA.workspaceId, ownerA.userId, "draw the auth flow");
    const v1Source = guardMermaidSourceOrThrow("flowchart TD\n  user[User] --> api[API]");
    const created = await persistDiagram(ownerA, {
      title: "Auth flow",
      mermaid: v1Source,
      diagramType: "flowchart",
      runId,
    });

    const refineRunId = await seededRun(ownerA.workspaceId, ownerA.userId, "require 2FA for auth");
    const v2Source = guardMermaidSourceOrThrow("flowchart TD\n  user[User] --> mfa[2FA] --> api[API]");
    const refined = await persistDiagram(ownerA, {
      title: "Auth flow with 2FA",
      mermaid: v2Source,
      diagramType: "flowchart",
      runId: refineRunId,
      canvasId: created.canvasId,
    });

    expect(refined.canvasId).toBe(created.canvasId);
    expect(refined.artifactId).toBe(created.artifactId);
    expect(refined.version).toBe(2);

    const [artifact] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, created.artifactId));
    expect(artifact.title).toBe("Auth flow with 2FA");
    expect(artifact.producedByRunId).toBe(runId); // creation provenance never moves
    expect(artifact.currentVersionId).toBeTruthy();
    const [current] = await holder
      .db!.select()
      .from(artifactVersions)
      .where(eq(artifactVersions.id, artifact.currentVersionId!));
    expect(current.versionNumber).toBe(2);
    expect(current.content).toEqual({ type: "diagram", mermaid: v2Source, diagramType: "flowchart" });
    expect(current.note).toBe(`refined by diagram run ${refineRunId}`);

    // v1 remains fetchable — append-only, never mutated.
    const versions = await holder
      .db!.select({ versionNumber: artifactVersions.versionNumber, plainText: artifactVersions.plainText })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, created.artifactId))
      .orderBy(artifactVersions.versionNumber);
    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2]);
    expect(versions[0].plainText).toBe(v1Source);

    const scenes = await holder
      .db!.select({ versionNumber: canvasVersions.versionNumber, scene: canvasVersions.scene })
      .from(canvasVersions)
      .where(eq(canvasVersions.canvasId, created.canvasId))
      .orderBy(canvasVersions.versionNumber);
    expect(scenes.map((s) => s.versionNumber)).toEqual([1, 2]);
    expect(scenes[0].scene).toMatchObject({ mermaid: v1Source });
    expect(scenes[1].scene).toMatchObject({ mermaid: v2Source });

    // A third pass keeps appending in lockstep.
    const again = await persistDiagram(ownerA, {
      title: "Auth flow with 2FA",
      mermaid: v1Source,
      diagramType: "flowchart",
      runId: null,
      canvasId: created.canvasId,
    });
    expect(again.version).toBe(3);
    await expect(artifactVersionCount(created.artifactId)).resolves.toBe(3);
  });

  it("a cross-workspace canvasId fails cleanly and writes nothing", async () => {
    if (!handle) return;
    const runId = await seededRun(ownerA.workspaceId, ownerA.userId, "draw the auth flow");
    const source = guardMermaidSourceOrThrow("flowchart TD\n  a --> b");
    const created = await persistDiagram(ownerA, {
      title: "A's diagram",
      mermaid: source,
      diagramType: "flowchart",
      runId,
    });
    const versionsBefore = await artifactVersionCount(created.artifactId);

    await expect(
      persistDiagram(ownerB, {
        title: "Stolen refine",
        mermaid: source,
        diagramType: "flowchart",
        runId: null,
        canvasId: created.canvasId,
      }),
    ).rejects.toThrow(DiagramError);
    await expect(
      persistDiagram(ownerB, {
        title: "Stolen refine",
        mermaid: source,
        diagramType: "flowchart",
        runId: null,
        canvasId: created.canvasId,
      }),
    ).rejects.toThrow(/no canvas with this id in this workspace/);

    // The denial had no effect on either tenant.
    expect(await artifactVersionCount(created.artifactId)).toBe(versionsBefore);
    const bCanvases = await holder
      .db!.select({ id: canvases.id })
      .from(canvases)
      .where(eq(canvases.workspaceId, ownerB.workspaceId));
    expect(bCanvases).toEqual([]);
  });

  it("an unknown canvasId in the right workspace fails with the same denial", async () => {
    if (!handle) return;
    const source = guardMermaidSourceOrThrow("flowchart TD\n  a --> b");
    await expect(
      persistDiagram(ownerA, {
        title: "Ghost refine",
        mermaid: source,
        diagramType: "flowchart",
        runId: null,
        canvasId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(/no canvas with this id in this workspace/);
  });
});

function guardMermaidSourceOrThrow(source: string): string {
  const guarded = guardMermaidSource(source);
  if (!guarded.ok) throw new Error(`test fixture is not guarded-clean: ${guarded.error}`);
  return guarded.mermaid;
}
