import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { artifactLinks, artifacts } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Integration coverage for saving a message as a note or an idea (plan
 * Task 10): a replayed receipt key returns the first save instead of minting
 * a second artifact, and a saved idea is a `zettel` artifact written
 * directly — the owner's own act of authorship — with one `source` edge to
 * the run it came from, never a proposal row.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let saveMessage: typeof import("@/domains/knowledge/save-message");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  // Lazy: db-transaction reads DATABASE_URL at module load, and makeTestDb
  // points it at the scratch database only after the helper runs.
  saveMessage = await import("@/domains/knowledge/save-message");
});

afterAll(async () => {
  await handle?.client.end();
});

async function noteCount(title: string, workspaceId: string): Promise<number> {
  // Scoped to the workspace: the scratch db accumulates rows across runs
  // (no truncation here), so an unscoped count counts other suites' rows.
  const rows = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.title, title)));
  return rows.length;
}

async function artifactRow(id: string) {
  const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id));
  return row;
}

async function linkRows(artifactId: string) {
  return db.select().from(artifactLinks).where(eq(artifactLinks.artifactId, artifactId));
}

suite("save message as note or idea", () => {
  it("returns the first note for a replayed receipt key", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `svmsg-note-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const runId = "22222222-2222-4222-8222-222222222222";

    const a = await saveMessage.saveMessageAsNote(auth, {
      runId,
      title: "T",
      text: "Answer",
      citations: [],
      idempotencyKey: "33333333-3333-4333-8333-333333333331",
    });
    const b = await saveMessage.saveMessageAsNote(auth, {
      runId,
      title: "T",
      text: "Answer",
      citations: [],
      idempotencyKey: "33333333-3333-4333-8333-333333333331",
    });
    expect(b.id).toBe(a.id);
    expect(await noteCount("T", workspaceId)).toBe(1);
  });

  it("returns the first idea for a replayed receipt key", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `svmsg-idea-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const runId = "22222222-2222-4222-8222-222222222222";

    const a = await saveMessage.saveMessageAsIdea(auth, {
      runId,
      title: "Idea one",
      text: "Claim",
      idempotencyKey: "44444444-4444-4444-8444-444444444441",
    });
    const b = await saveMessage.saveMessageAsIdea(auth, {
      runId,
      title: "Idea one",
      text: "Claim",
      idempotencyKey: "44444444-4444-4444-8444-444444444441",
    });
    expect(b.id).toBe(a.id);
    expect(await noteCount("Idea one", workspaceId)).toBe(1);
  });

  it("writes a zettel artifact with a source edge to the run", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `svmsg-edge-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const runId = "22222222-2222-4222-8222-222222222222";

    const { id } = await saveMessage.saveMessageAsIdea(auth, {
      runId,
      title: "Edge idea",
      text: "Claim",
      idempotencyKey: "55555555-5555-4555-8555-555555555551",
    });
    const artifact = await artifactRow(id);
    expect(artifact.kind).toBe("zettel");
    const edges = await linkRows(id);
    expect(edges.some((e) => e.targetType === "run" && e.targetId === runId && e.linkType === "source")).toBe(true);
  });
});
