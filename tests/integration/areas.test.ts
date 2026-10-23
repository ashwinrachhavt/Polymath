import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactLinks, artifacts, cardReviews, cards, claims } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Integration coverage for Areas: declaration guards (name required, one
 * tag minimum, duplicate live names refused, archived names reusable),
 * optimistic-lock updates and archive, tenancy isolation, and the
 * effort/confidence measurement - notes and zettels matched by tag
 * overlap, manual `reference` links, recall attempts from card_reviews,
 * claim decisions, the active/stale/empty states, and the documented
 * "study rather than read" suggestion rule.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database;
 * the migration under test is 0241_areas.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/knowledge/areas");
let queries: typeof import("@/domains/knowledge/area-queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/knowledge/areas");
  queries = await import("@/domains/knowledge/area-queries");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seedNote(workspaceId: string, tags: string[]) {
  const [note] = await db
    .insert(artifacts)
    .values({ workspaceId, kind: "note", title: "Area test note", tags })
    .returning({ id: artifacts.id });
  return note.id;
}

suite("areas", () => {
  it("declares, guards duplicates, updates with the version lock, and archives", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `areas-life-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    await expect(commands.declareArea(auth, { name: "  ", tags: ["distributed-systems"] })).rejects.toMatchObject({
      code: "invalid_area",
    });
    await expect(commands.declareArea(auth, { name: "Systems", tags: [] })).rejects.toMatchObject({
      code: "invalid_area",
    });

    // Tags normalize like note tags: trimmed, lowercased, deduplicated.
    const area = await commands.declareArea(auth, {
      name: "Distributed Systems",
      tags: [" Distributed-Systems ", "distributed-systems", "Raft"],
    });
    const declared = (await queries.listAreas(auth))[0];
    expect(declared.tags).toEqual(["distributed-systems", "raft"]);

    await expect(
      commands.declareArea(auth, { name: "distributed systems", tags: ["consensus"] }),
    ).rejects.toMatchObject({ code: "name_taken" });

    // Optimistic lock: a replayed version loses cleanly.
    await commands.updateArea(auth, { areaId: area.id, expectedVersion: 1, tags: ["consensus"] });
    await expect(commands.updateArea(auth, { areaId: area.id, expectedVersion: 1, name: "Renamed" })).rejects.toMatchObject({
      code: "stale_write",
    });

    // A rename to the other live name is refused.
    await commands.declareArea(auth, { name: "Language", tags: ["typescript"] });
    await expect(
      commands.updateArea(auth, { areaId: area.id, expectedVersion: 2, name: "language" }),
    ).rejects.toMatchObject({ code: "name_taken" });

    await commands.archiveArea(auth, { areaId: area.id, expectedVersion: 2 });
    // Archived areas leave the list, and their name becomes reusable.
    expect((await queries.listAreas(auth)).map((a) => a.name)).toEqual(["Language"]);
    await commands.declareArea(auth, { name: "Distributed Systems", tags: ["consensus"] });
    expect((await queries.listAreas(auth)).map((a) => a.name)).toEqual(["Distributed Systems", "Language"]);
  });

  it("keeps one workspace's areas invisible to another", async () => {
    const one = await seedWorkspace(db, `areas-ten-a-${Date.now()}`);
    const two = await seedWorkspace(db, `areas-ten-b-${Date.now()}`);
    const authOne = ownerAuth(one.userId, one.workspaceId);
    const authTwo = ownerAuth(two.userId, two.workspaceId);

    const area = await commands.declareArea(authOne, { name: "Systems", tags: ["consensus"] });
    expect(await queries.listAreas(authTwo)).toEqual([]);
    await expect(commands.updateArea(authTwo, { areaId: area.id, expectedVersion: 1, name: "X" })).rejects.toMatchObject({
      code: "stale_write",
    });
    await expect(commands.archiveArea(authTwo, { areaId: area.id, expectedVersion: 1 })).rejects.toMatchObject({
      code: "stale_write",
    });
  });

  it("measures effort and confidence from tagged content, links, reviews, and claims", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `areas-measure-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    await commands.declareArea(auth, { name: "Systems", tags: ["consensus"] });

    // Empty before anything links in.
    let [measured] = await queries.listAreas(auth);
    expect(measured.state).toBe("empty");
    expect(measured.suggestStudy).toBe(false);

    // Two notes in the area, one outside it.
    const noteA = await seedNote(workspaceId, ["consensus", "raft"]);
    const noteB = await seedNote(workspaceId, ["consensus"]);
    const noteOut = await seedNote(workspaceId, ["cooking"]);

    // One manual [[Title]] link from a linked note (targetId is polymorphic).
    await db.insert(artifactLinks).values({
      workspaceId,
      artifactId: noteA,
      targetType: "note",
      targetId: noteOut,
      linkType: "reference",
    });

    // A card on note A with three attempts: two correct, one wrong.
    const [card] = await db
      .insert(cards)
      .values({ workspaceId, prompt: "What does Raft guarantee?", answer: "Leader completeness.", artifactId: noteA, sourceTitle: "Area test note" })
      .returning({ id: cards.id });
    // Two of the three attempts carry typed text (only possible pre-reveal).
    await db.insert(cardReviews).values({ workspaceId, cardId: card.id, outcome: "correct", responseText: "Leader completeness" });
    await db.insert(cardReviews).values({ workspaceId, cardId: card.id, outcome: "correct", responseText: "One leader per term" });
    await db.insert(cardReviews).values({ workspaceId, cardId: card.id, outcome: "wrong" });

    // Claims on note B: one accepted, one rejected, one proposed (not decided).
    await db.insert(claims).values({ workspaceId, statement: "Raft elects a single leader.", status: "accepted", artifactId: noteB });
    await db.insert(claims).values({ workspaceId, statement: "Raft is Byzantine fault tolerant.", status: "rejected", artifactId: noteB });
    await db.insert(claims).values({ workspaceId, statement: "Raft uses randomized timeouts.", status: "proposed", artifactId: noteB });

    [measured] = await queries.listAreas(auth);
    expect(measured.state).toBe("active");
    expect(measured.effort).toEqual({ notes: 2, manualLinks: 1, recallAttempts: 3 });
    expect(measured.confidence).toEqual({
      recallCorrect: 2,
      recallTotal: 3,
      typedBeforeReveal: 2,
      claimsAccepted: 1,
      claimsDecided: 2,
    });
    // Effort score 6 >= 5, 3 attempts, accuracy 2/3 < 0.7: the study cue fires.
    expect(measured.suggestStudy).toBe(true);

    // The untagged note contributes nothing anywhere.
    expect(measured.effort.notes).toBe(2);

    // An untouched area shows stale, not active: backdate the note past the window.
    const { userId: u2, workspaceId: w2 } = await seedWorkspace(db, `areas-stale-${Date.now()}`);
    const auth2 = ownerAuth(u2, w2);
    await commands.declareArea(auth2, { name: "Old topic", tags: ["stale-tag"] });
    const oldNote = await seedNote(w2, ["stale-tag"]);
    await db.execute(sql`update artifacts set updated_at = now() - interval '30 days' where id = ${oldNote}`);
    const [stale] = await queries.listAreas(auth2);
    expect(stale.state).toBe("stale");
    expect(stale.suggestStudy).toBe(false);
  });
});
