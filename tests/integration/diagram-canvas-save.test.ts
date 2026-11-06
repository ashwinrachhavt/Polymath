import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import { canvases, canvasVersions } from "@/domains/knowledge/schema";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { DiagramError, appendCanvasScene, persistDiagram } from "@/domains/diagrams/diagrams";
import { getCanvasSceneView } from "@/domains/diagrams/canvas-queries";

/*
 * The canvas editor's save contract: a checkpoint appends one row to the
 * canvas's version chain (the generated Mermaid envelope stays fetchable),
 * the version numbers climb max+1 inside the transaction, and a foreign
 * canvasId is the same denial as a bogus one. Real Postgres — the
 * (canvasId, versionNumber) unique index is exactly what a mock cannot prove.
 */

suite("canvas scene save (append-only editor checkpoints)", () => {
  let ownerA: ReturnType<typeof ownerAuth>;
  let ownerB: ReturnType<typeof ownerAuth>;

  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
    const a = await seedWorkspace(handle.db, `canvas-save-a-${Date.now()}`);
    const b = await seedWorkspace(handle.db, `canvas-save-b-${Date.now()}`);
    ownerA = ownerAuth(a.userId, a.workspaceId);
    ownerB = ownerAuth(b.userId, b.workspaceId);
  });

  async function seededCanvas(auth: ReturnType<typeof ownerAuth>): Promise<string> {
    const created = await persistDiagram(auth, {
      title: "System diagram",
      mermaid: "graph LR\na-->b",
      diagramType: "flowchart",
      runId: null,
    });
    return created.canvasId;
  }

  it("a save appends an Excalidraw version; the generated Mermaid v1 stays fetchable", async () => {
    if (!handle) return;
    const canvasId = await seededCanvas(ownerA);

    const saved = await appendCanvasScene(ownerA, {
      canvasId,
      scene: { elements: [{ id: "e1", type: "rectangle" }], appState: { viewBackgroundEnabled: true } },
    });
    expect(saved.versionNumber).toBe(2);

    const rows = await holder
      .db!.select({ versionNumber: canvasVersions.versionNumber, scene: canvasVersions.scene })
      .from(canvasVersions)
      .where(eq(canvasVersions.canvasId, canvasId))
      .orderBy(canvasVersions.versionNumber);
    expect(rows).toHaveLength(2);
    expect(rows[0].scene).toMatchObject({ format: "mermaid" });
    expect(rows[1].scene).toMatchObject({
      format: "excalidraw",
      scene: { elements: [{ id: "e1", type: "rectangle" }] },
    });

    // The read model serves the whole chain, newest last.
    const view = await getCanvasSceneView(ownerA, canvasId);
    expect(view?.versions.map((v) => v.versionNumber)).toEqual([1, 2]);
  });

  it("a second save climbs to v3 and a rename moves the canvas title", async () => {
    if (!handle) return;
    const canvasId = await seededCanvas(ownerA);
    await appendCanvasScene(ownerA, { canvasId, scene: { elements: [] } });
    const saved = await appendCanvasScene(ownerA, {
      canvasId,
      scene: { elements: [{ id: "e2" }] },
      title: "Renamed diagram",
    });
    expect(saved.versionNumber).toBe(3);
    const [canvas] = await holder.db!.select({ title: canvases.title }).from(canvases).where(eq(canvases.id, canvasId));
    expect(canvas.title).toBe("Renamed diagram");
  });

  it("a cross-workspace save fails cleanly and writes nothing", async () => {
    if (!handle) return;
    const canvasId = await seededCanvas(ownerA);
    await expect(appendCanvasScene(ownerB, { canvasId, scene: { elements: [] } })).rejects.toBeInstanceOf(DiagramError);
    const rows = await holder.db!.select().from(canvasVersions).where(eq(canvasVersions.canvasId, canvasId));
    expect(rows).toHaveLength(1);
    // And the read model denies the foreign workspace the same way.
    expect(await getCanvasSceneView(ownerB, canvasId)).toBeNull();
  });

  it("an unknown canvasId in the right workspace fails with the same denial", async () => {
    if (!handle) return;
    await expect(
      appendCanvasScene(ownerA, { canvasId: crypto.randomUUID(), scene: { elements: [] } }),
    ).rejects.toBeInstanceOf(DiagramError);
  });
});
