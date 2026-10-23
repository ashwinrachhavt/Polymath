import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifacts, cardReviews, cards } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Integration coverage for zettel cards and recall: the propose -> accept ->
 * review lifecycle, the state guards (only proposed accepts, only a due
 * scheduled card reviews, retired is terminal), idempotent replay of a
 * review, and tenancy (another workspace cannot see or move the card).
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database;
 * the migration under test is 0240_zettel_recall.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/knowledge/cards");
let queries: typeof import("@/domains/knowledge/card-queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/knowledge/cards");
  queries = await import("@/domains/knowledge/card-queries");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seedNote(workspaceId: string) {
  const [note] = await db
    .insert(artifacts)
    .values({ workspaceId, kind: "note", title: "Distributed systems notes" })
    .returning({ id: artifacts.id });
  return note.id;
}

suite("zettel cards and recall", () => {
  it("walks propose -> accept -> review with the guards at each step", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `cards-life-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const artifactId = await seedNote(workspaceId);

    const proposed = await commands.proposeCard(auth, {
      prompt: "What does idempotency guarantee?",
      answer: "A retried request has the same effect as one request.",
      artifactId,
    });

    // A proposed card is outside the queue: it cannot be reviewed and is not due.
    await expect(
      commands.reviewCard(auth, { cardId: proposed.id, expectedVersion: 1, outcome: "correct" }),
    ).rejects.toMatchObject({ code: "not_due" });
    expect(await queries.countDueCards(auth)).toBe(0);

    await commands.acceptCard(auth, { cardId: proposed.id, expectedVersion: 1 });
    expect(await queries.countDueCards(auth)).toBe(1);

    // Accepting twice is a stale write, not a second acceptance.
    await expect(commands.acceptCard(auth, { cardId: proposed.id, expectedVersion: 1 })).rejects.toMatchObject({
      code: "stale_write",
    });

    const reviewed = await commands.reviewCard(auth, { cardId: proposed.id, expectedVersion: 2, outcome: "correct" });
    const [card] = await db.select().from(cards).where(eq(cards.id, proposed.id));
    expect(card.reviewCount).toBe(1);
    expect(card.correctCount).toBe(1);
    expect(card.lastOutcome).toBe("correct");
    expect(card.intervalDays).toBe(1);
    expect(reviewed.nextDueAt.getTime()).toBeGreaterThan(Date.now());

    // Just reviewed: no longer due, so an immediate second review is refused.
    await expect(
      commands.reviewCard(auth, { cardId: proposed.id, expectedVersion: 3, outcome: "correct" }),
    ).rejects.toMatchObject({ code: "not_due" });

    const attempts = await db.select().from(cardReviews).where(eq(cardReviews.cardId, proposed.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe("correct");
  });

  it("replays a retried review instead of double-counting it", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `cards-idem-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const artifactId = await seedNote(workspaceId);
    const proposed = await commands.proposeCard(auth, { prompt: "p", answer: "a", artifactId });
    await commands.acceptCard(auth, { cardId: proposed.id, expectedVersion: 1 });

    const key = crypto.randomUUID();
    const attempt = { cardId: proposed.id, expectedVersion: 2, outcome: "wrong" as const, idempotencyKey: key };
    const first = await commands.reviewCard(auth, attempt);
    const replay = await commands.reviewCard(auth, attempt);
    // A replay returns the stored result (JSON: the date crosses as a string).
    expect(replay.id).toBe(first.id);
    expect(new Date(replay.nextDueAt).getTime()).toBe(first.nextDueAt.getTime());

    const [card] = await db.select().from(cards).where(eq(cards.id, proposed.id));
    expect(card.reviewCount).toBe(1);
    // A miss returns within the sitting, not tomorrow.
    expect(card.dueAt!.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    const attempts = await db.select().from(cardReviews).where(eq(cardReviews.cardId, proposed.id));
    expect(attempts).toHaveLength(1);
  });

  it("keeps another workspace out of the card entirely", async () => {
    const owner = await seedWorkspace(db, `cards-own-${Date.now()}`);
    const stranger = await seedWorkspace(db, `cards-str-${Date.now()}`);
    const ownerAuthCtx = ownerAuth(owner.userId, owner.workspaceId);
    const strangerAuthCtx = ownerAuth(stranger.userId, stranger.workspaceId);
    const artifactId = await seedNote(owner.workspaceId);

    // A foreign source cannot be cited.
    await expect(
      commands.proposeCard(strangerAuthCtx, { prompt: "p", answer: "a", artifactId }),
    ).rejects.toMatchObject({ code: "source_not_found" });

    const proposed = await commands.proposeCard(ownerAuthCtx, { prompt: "p", answer: "a", artifactId });
    await commands.acceptCard(ownerAuthCtx, { cardId: proposed.id, expectedVersion: 1 });

    // A foreign id is "not found", never fetched: the stranger's queue stays
    // empty and their review is a stale write.
    expect(await queries.countDueCards(strangerAuthCtx)).toBe(0);
    await expect(
      commands.reviewCard(strangerAuthCtx, { cardId: proposed.id, expectedVersion: 2, outcome: "correct" }),
    ).rejects.toMatchObject({ code: "stale_write" });
  });

  it("suspends and retires only from the states that allow it", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `cards-state-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const artifactId = await seedNote(workspaceId);
    const proposed = await commands.proposeCard(auth, { prompt: "p", answer: "a", artifactId });

    // Suspend requires scheduled.
    await expect(commands.suspendCard(auth, { cardId: proposed.id, expectedVersion: 1 })).rejects.toMatchObject({
      code: "stale_write",
    });

    await commands.acceptCard(auth, { cardId: proposed.id, expectedVersion: 1 });
    await commands.suspendCard(auth, { cardId: proposed.id, expectedVersion: 2 });
    expect(await queries.countDueCards(auth)).toBe(0);

    await commands.resumeCard(auth, { cardId: proposed.id, expectedVersion: 3 });
    expect(await queries.countDueCards(auth)).toBe(1);

    await commands.retireCard(auth, { cardId: proposed.id, expectedVersion: 4 });
    const [card] = await db.select().from(cards).where(eq(cards.id, proposed.id));
    expect(card.state).toBe("retired");
    expect(card.dueAt).toBeNull();

    // Retired is terminal: nothing moves it again.
    await expect(commands.resumeCard(auth, { cardId: proposed.id, expectedVersion: 5 })).rejects.toMatchObject({
      code: "stale_write",
    });
  });

  it("lists cards with their citation and filters by state", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `cards-list-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const artifactId = await seedNote(workspaceId);
    const a = await commands.proposeCard(auth, { prompt: "first", answer: "one", artifactId });
    await commands.proposeCard(auth, { prompt: "second", answer: "two", artifactId });
    await commands.acceptCard(auth, { cardId: a.id, expectedVersion: 1 });

    const proposed = await queries.pageCards(auth, { state: "proposed", limit: 24, offset: 0 });
    expect(proposed.total).toBe(1);
    expect(proposed.items[0].prompt).toBe("second");
    expect(proposed.items[0].sourceTitle).toBe("Distributed systems notes");

    const scheduled = await queries.pageCards(auth, { state: "scheduled", limit: 24, offset: 0 });
    expect(scheduled.total).toBe(1);

    const found = await queries.pageCards(auth, { state: "all", query: "first", limit: 24, offset: 0 });
    expect(found.total).toBe(1);
    expect(found.items[0].prompt).toBe("first");

    const stats = await queries.cardHeaderStats(auth);
    expect(stats.due).toBe(1);
    expect(stats.proposed).toBe(1);
  });
});
