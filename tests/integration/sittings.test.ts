import { drizzle } from "drizzle-orm/postgres-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifacts, zettelSittingCards } from "@/domains/knowledge/schema";
import {
  addCardToSitting,
  createSitting,
  deleteSitting,
  getSitting,
  getSittingWritingCard,
  listSittingCards,
  SittingError,
} from "@/domains/knowledge/sittings";
import { commitNoteSnapshot, createNote } from "@/domains/knowledge/notes";
import { auditEvents } from "@/domains/audit/schema";
import { and, eq } from "drizzle-orm";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Zettel sittings (plan 2026-10-29 §2, §15.4; Gate 2026-10-29) against real
 * Postgres, through migration 0261 itself: a sitting is created, joins cards
 * with roles, rejects foreign-workspace artifacts with the typed error, and
 * deleting a sitting cascades only the join rows - the artifacts survive and
 * the deletion is audit-evented. There is no lifecycle: ended_at is never
 * written and no end action exists.
 *
 * Value: protects=the sitting data model's tenancy invariants and the
 * no-lifecycle gate; fails_when=the migration shape drifts from the schema,
 * a foreign artifact joins, a code path writes ended_at, or a sitting
 * delete removes cards.
 */

const handle = makeTestDb();
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

const suite = handle ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(process.cwd(), "src/db/migrations/0261_zettel_sittings.sql"),
  "utf8",
);

suite("zettel sittings (migration 0261)", () => {
  let ws: { userId: string; workspaceId: string };
  let otherWs: { userId: string; workspaceId: string };

  beforeAll(async () => {
    holder.db = handle?.db;
    if (!handle) return;
    // Re-runnable: drop 0261's objects so the real file applies cleanly on
    // every local run (the drizzle journal owns once-only application).
    await handle.client.unsafe(
      'DROP TABLE IF EXISTS "zettel_sitting_cards"; DROP TABLE IF EXISTS "zettel_sittings"; DROP TYPE IF EXISTS "sitting_card_role"; ALTER TABLE "artifacts" DROP COLUMN IF EXISTS "metadata";',
    );
    for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
      const sql = stmt.trim();
      if (sql) await handle.client.unsafe(sql);
    }
    const stamp = Date.now();
    ws = await seedWorkspace(handle.db, `sitting-a-${stamp}`);
    otherWs = await seedWorkspace(handle.db, `sitting-b-${stamp}`);
  });

  afterAll(async () => {
    await handle?.client.end();
  });

  async function seedArtifact(workspaceId: string, title: string) {
    const [row] = await handle!.db
      .insert(artifacts)
      .values({ workspaceId, kind: "zettel", title })
      .returning();
    return row;
  }

  it("creates a sitting as a durable work context - ended_at is never written (Gate 2026-10-29)", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, { topic: "Idea garden", tags: ["a"] });
    expect(sitting.endedAt).toBeNull();
    expect(sitting.closingReflection).toBeNull();
    expect(sitting.topic).toBe("Idea garden");
    // The workspace is always there: revisiting later reads the same writable context.
    const revisited = await getSitting(auth, sitting.id);
    expect(revisited?.endedAt).toBeNull();
  });

  it("joins cards with roles and enforces one role per card per sitting", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, {});
    const card = await seedArtifact(ws.workspaceId, "card one");
    const join = await addCardToSitting(auth, { sittingId: sitting.id, artifactId: card.id, role: "created_here" });
    expect(join.roleInSitting).toBe("created_here");
    await expect(
      addCardToSitting(auth, { sittingId: sitting.id, artifactId: card.id, role: "referenced_here" }),
    ).rejects.toThrow();
    const cards = await listSittingCards(auth, sitting.id);
    expect(cards).toHaveLength(1);
  });

  it("rejects a foreign-workspace artifact with ARTIFACT_WORKSPACE_MISMATCH (§15.4)", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, {});
    const foreign = await seedArtifact(otherWs.workspaceId, "not yours");
    try {
      await addCardToSitting(auth, { sittingId: sitting.id, artifactId: foreign.id, role: "referenced_here" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SittingError);
      expect((err as SittingError).code).toBe("ARTIFACT_WORKSPACE_MISMATCH");
      expect((err as Error).message).toBe("That card belongs to another workspace.");
    }
    // And the join row never happened.
    const rows = await handle!.db
      .select()
      .from(zettelSittingCards)
      .where(eq(zettelSittingCards.sittingId, sitting.id));
    expect(rows).toHaveLength(0);
  });

  it("scopes getSitting by workspace - foreign sittings answer not-found", async () => {
    const sitting = await createSitting(ownerAuth(ws.userId, ws.workspaceId), { topic: "private" });
    const foreign = await getSitting(ownerAuth(otherWs.userId, otherWs.workspaceId), sitting.id);
    expect(foreign).toBeNull();
  });

  it("no domain path writes ended_at or closing_reflection (Gate 2026-10-29)", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, {});
    const card = await seedArtifact(ws.workspaceId, "context card");
    await addCardToSitting(auth, { sittingId: sitting.id, artifactId: card.id, role: "created_here" });
    const after = await getSitting(auth, sitting.id);
    expect(after?.endedAt).toBeNull();
    expect(after?.closingReflection).toBeNull();
    // Deleting a sitting is always allowed for a member - no ended records exist to protect.
    await deleteSitting(auth, sitting.id);
    expect(await getSitting(auth, sitting.id)).toBeNull();
  });

  it("deleting an open sitting cascades only join rows - artifacts survive, audit-evented", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, { topic: "doomed" });
    const card = await seedArtifact(ws.workspaceId, "survivor");
    await addCardToSitting(auth, { sittingId: sitting.id, artifactId: card.id, role: "created_here" });
    await deleteSitting(auth, sitting.id);
    expect(await getSitting(auth, sitting.id)).toBeNull();
    const joins = await handle!.db
      .select()
      .from(zettelSittingCards)
      .where(eq(zettelSittingCards.sittingId, sitting.id));
    expect(joins).toHaveLength(0);
    const [survivor] = await handle!.db.select().from(artifacts).where(eq(artifacts.id, card.id));
    expect(survivor.title).toBe("survivor");
    const [audit] = await handle!.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectId, sitting.id), eq(auditEvents.action, "sitting.deleted")));
    expect(audit.actorKind).toBe("user");
  });

  it("getSittingWritingCard hydrates the created_here card at its current version", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, { topic: "Reopen me", tags: [] });
    const note = await createNote(auth, {
      idempotencyKey: `swc-${Date.now()}`,
      title: "Working card",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "v1 body" }] }] },
      plainText: "v1 body",
      kind: "zettel",
    });
    await addCardToSitting(auth, { sittingId: sitting.id, artifactId: note.id, role: "created_here" });

    const first = await getSittingWritingCard(auth, sitting.id);
    expect(first?.artifactId).toBe(note.id);
    expect(first?.versionNumber).toBe(1);
    expect(first?.plainText).toBe("v1 body");

    // A later version must be what a reopen binds to - not the stale v1.
    await commitNoteSnapshot(auth, {
      idempotencyKey: `swc-v2-${Date.now()}`,
      artifactId: note.id,
      expectedVersion: 1,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "v2 body" }] }] },
      plainText: "v2 body",
    });
    const reopened = await getSittingWritingCard(auth, sitting.id);
    expect(reopened?.versionNumber).toBe(2);
    expect(reopened?.plainText).toBe("v2 body");

    // A sitting with no working card hydrates as absent, never an error.
    const empty = await createSitting(auth, { topic: "Empty", tags: [] });
    expect(await getSittingWritingCard(auth, empty.id)).toBeNull();
  });
});
