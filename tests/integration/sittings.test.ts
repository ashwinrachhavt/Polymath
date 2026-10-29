import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifacts, zettelSittingCards } from "@/domains/knowledge/schema";
import {
  addCardToSitting,
  createSitting,
  deleteSitting,
  endSitting,
  getSitting,
  listSittingCards,
  SittingError,
} from "@/domains/knowledge/sittings";
import { auditEvents } from "@/domains/audit/schema";
import { and, eq } from "drizzle-orm";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Zettel sittings (plan 2026-10-29 §2, §15.4, §15.8) against real Postgres,
 * through migration 0261 itself: a sitting is created open, joins cards with
 * roles, rejects foreign-workspace artifacts with the typed error, refuses to
 * delete an ended sitting, and deleting an open sitting cascades only the
 * join rows - the artifacts survive and the deletion is audit-evented.
 *
 * Value: protects=the sitting data model's tenancy and lifecycle invariants;
 * fails_when=the migration shape drifts from the schema, a foreign artifact
 * joins, an ended sitting deletes, or a sitting delete removes cards.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(process.cwd(), "src/db/migrations/0261_zettel_sittings.sql"),
  "utf8",
);

suite("zettel sittings (migration 0261)", () => {
  let ws: { userId: string; workspaceId: string };
  let otherWs: { userId: string; workspaceId: string };

  beforeAll(async () => {
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

  it("creates an open sitting and lists it before ended history", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, { topic: "Idea garden", tags: ["a"] });
    expect(sitting.endedAt).toBeNull();
    expect(sitting.topic).toBe("Idea garden");
    const ended = await endSitting(auth, (await createSitting(auth, { topic: "done" })).id);
    expect(ended.endedAt).not.toBeNull();
    // Ending twice is a no-op (idempotent), never an error.
    const again = await endSitting(auth, ended.id);
    expect(again.endedAt?.getTime()).toBe(ended.endedAt?.getTime());
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

  it("refuses to delete an ended sitting (§15.8)", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, {});
    await endSitting(auth, sitting.id);
    try {
      await deleteSitting(auth, sitting.id);
      expect.unreachable();
    } catch (err) {
      expect((err as SittingError).code).toBe("SITTING_ENDED");
      expect((err as Error).message).toBe("Ended sittings are records.");
    }
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
});
