import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifactLinks } from "@/domains/knowledge/schema";
import { createNote } from "@/domains/knowledge/notes";
import { addCardToSitting, createSitting, listSittingSuggestedLinks } from "@/domains/knowledge/sittings";
import { dismissSemanticLink } from "@/domains/knowledge/relations";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * §14.9: the sitting's suggested-links read is scoped to the sitting's own
 * cards, carries target titles for the batch review, and drops dismissed
 * edges (the canonical dismissed store, §11 no-reappear).
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

suite("sitting suggested links (integration)", () => {
  let ws: { userId: string; workspaceId: string };

  beforeAll(async () => {
    holder.db = handle?.db;
    ws = await seedWorkspace(handle!.db, `ssl-${Date.now()}`);
  });

  afterAll(async () => {
    await handle?.client.end();
  });

  it("lists only semantic edges on the sitting's cards, excluding dismissed ones", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, { topic: "links" });
    const inCard = await createNote(auth, { idempotencyKey: `ssl-in-${Date.now()}`, title: "In sitting", content: { type: "doc", content: [] }, plainText: "a", kind: "zettel" });
    const outCard = await createNote(auth, { idempotencyKey: `ssl-out-${Date.now()}`, title: "Not in sitting", content: { type: "doc", content: [] }, plainText: "b", kind: "zettel" });
    const target = await createNote(auth, { idempotencyKey: `ssl-t-${Date.now()}`, title: "Target card", content: { type: "doc", content: [] }, plainText: "c", kind: "zettel" });
    await addCardToSitting(auth, { sittingId: sitting.id, artifactId: inCard.id, role: "created_here" });
    await handle!.db.insert(artifactLinks).values([
      { workspaceId: ws.workspaceId, artifactId: inCard.id, targetType: "note", targetId: target.id, linkType: "semantic", label: "Target card", score: 0.9 },
      { workspaceId: ws.workspaceId, artifactId: outCard.id, targetType: "note", targetId: target.id, linkType: "semantic", label: "Target card", score: 0.8 },
    ]);
    const listed = await listSittingSuggestedLinks(auth, sitting.id);
    expect(listed.length).toBe(1);
    expect(listed[0].artifactId).toBe(inCard.id);
    expect(listed[0].targetTitle).toBe("Target card");
    // Dismiss it: the list empties (the edge stays as "dismissed", never re-proposed).
    expect(await dismissSemanticLink(auth, { artifactId: inCard.id, targetId: target.id })).toBe(true);
    expect(await listSittingSuggestedLinks(auth, sitting.id)).toEqual([]);
  });
});
