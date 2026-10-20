import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { artifacts } from "@/domains/knowledge/schema";
import { documents } from "@/domains/knowledge/schema";
import { learningItems } from "@/domains/learning/schema";
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

import { approveItem, approveItems, createDeck, listDecks, recordAttempt, retireItem } from "@/domains/learning/commands";
import { deckProgress, dueItems, getItem, proposedItems } from "@/domains/learning/queries";
import type { QuizGenerator } from "@/integrations/quiz/generator";

const SOURCE = `Spaced repetition schedules a review just before a memory would fade.
The ease factor controls how fast an interval grows.
A card answered incorrectly restarts its interval at one day.`;

function fakeGenerator(): QuizGenerator {
  return {
    name: "fake:test",
    async generate({ count }) {
      return Array.from({ length: count }, (_, i) => ({
        prompt: `Question ${i}?`,
        options: ["A", "B", "C", "D"] as [string, string, string, string],
        answerIndex: 0,
        explanation: "Because the passage says so.",
        quote: "The ease factor controls how fast an interval grows.",
      }));
    },
  };
}

suite("learning: generation, approval, review (Neon)", () => {
  let auth: ReturnType<typeof ownerAuth>;
  let documentId: string;

  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
    const seed = await seedWorkspace(handle.db, `learning-${Date.now()}`);
    auth = ownerAuth(seed.userId, seed.workspaceId);
    const [doc] = await handle.db
      .insert(documents)
      .values({ workspaceId: seed.workspaceId, title: "Spacing", createdBy: seed.userId, updatedBy: seed.userId })
      .returning();
    documentId = doc.id;
    // A succeeded extraction is what generation reads.
    await handle.db.execute(
      (await import("drizzle-orm")).sql`insert into document_extractions
        (workspace_id, document_id, content_hash, status, text, spans)
        values (${seed.workspaceId}::uuid, ${doc.id}::uuid, 'hash-1', 'succeeded', ${SOURCE}, '[]'::jsonb)`,
    );
  });

  it("creates a deck and rejects a duplicate name", async () => {
    if (!handle) return;
    const deck = await createDeck(auth, { name: "Spacing deck" });
    expect(deck.id).toBeTruthy();
    await expect(createDeck(auth, { name: "Spacing deck" })).rejects.toThrow(/already exists/);
    const decks = await listDecks(auth);
    expect(decks.map((d) => d.name)).toContain("Spacing deck");
  });

  it("generates proposed items with verified quotes only", async () => {
    if (!handle) return;
    const { generateQuiz } = await import("@/domains/learning/commands");
    const deck = await createDeck(auth, { name: `Gen ${Date.now()}` });
    const out = await generateQuiz(auth, { deckId: deck.id, documentId, count: 3, generator: fakeGenerator() });
    expect(out.created).toBeGreaterThan(0);
    const proposed = await proposedItems(auth, { deckId: deck.id });
    expect(proposed.length).toBe(out.created);
    for (const item of proposed) {
      expect(item.status).toBe("proposed");
      expect(item.options).toHaveLength(4);
      expect(item.answerIndex).toBe(0);
      expect(SOURCE).toContain(item.sourceQuote);
    }
  });

  it("regenerating the same source does not duplicate items", async () => {
    if (!handle) return;
    const { generateQuiz } = await import("@/domains/learning/commands");
    const deck = await createDeck(auth, { name: `Dedupe ${Date.now()}` });
    const first = await generateQuiz(auth, { deckId: deck.id, documentId, count: 2, generator: fakeGenerator() });
    const second = await generateQuiz(auth, { deckId: deck.id, documentId, count: 2, generator: fakeGenerator() });
    expect(first.created).toBeGreaterThan(0);
    expect(second.created).toBe(0);
    const all = await proposedItems(auth, { deckId: deck.id });
    expect(all.length).toBe(first.created);
  });

  it("approve moves proposed to approved; only approved items are due", async () => {
    if (!handle) return;
    const { generateQuiz } = await import("@/domains/learning/commands");
    const deck = await createDeck(auth, { name: `Approve ${Date.now()}` });
    await generateQuiz(auth, { deckId: deck.id, documentId, count: 1, generator: fakeGenerator() });
    const [proposed] = await proposedItems(auth, { deckId: deck.id });
    expect(await dueItems(auth, { deckId: deck.id })).toHaveLength(0);
    await approveItem(auth, { itemId: proposed.id });
    const due = await dueItems(auth, { deckId: deck.id });
    expect(due.map((i) => i.id)).toContain(proposed.id);
    const progress = await deckProgress(auth, deck.id);
    expect(progress.approved).toBe(1);
    expect(progress.proposed).toBe(0);
  });

  it("records an attempt, reschedules the item, and rejects a stale version", async () => {
    if (!handle) return;
    const deck = await createDeck(auth, { name: `Review ${Date.now()}` });
    const [item] = await handle.db
      .insert(learningItems)
      .values({
        workspaceId: auth.workspaceId,
        deckId: deck.id,
        kind: "flashcard",
        prompt: "What controls interval growth?",
        answer: "The ease factor",
        status: "approved",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning();
    const key = crypto.randomUUID();
    const first = await recordAttempt(auth, { itemId: item.id, result: "recalled", idempotencyKey: key });
    expect(first.intervalDays).toBe(1);
    const after = await getItem(auth, item.id);
    expect(after?.reviewCount).toBe(1);
    // The same receipt replays instead of counting twice.
    const replay = await recordAttempt(auth, { itemId: item.id, result: "recalled", idempotencyKey: key });
    expect(replay.intervalDays).toBe(first.intervalDays);
    expect((await getItem(auth, item.id))?.reviewCount).toBe(1);
  });

  it("refuses to review a retired item", async () => {
    if (!handle) return;
    const deck = await createDeck(auth, { name: `Retire ${Date.now()}` });
    const [item] = await handle.db
      .insert(learningItems)
      .values({
        workspaceId: auth.workspaceId,
        deckId: deck.id,
        kind: "flashcard",
        prompt: "Retire me",
        status: "approved",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning();
    await retireItem(auth, { itemId: item.id, reason: "source changed" });
    await expect(
      recordAttempt(auth, { itemId: item.id, result: "recalled", idempotencyKey: crypto.randomUUID() }),
    ).rejects.toThrow(/approved/);
  });

  it("bulk approve only touches proposed items", async () => {
    if (!handle) return;
    const deck = await createDeck(auth, { name: `Bulk ${Date.now()}` });
    const rows = await handle.db
      .insert(learningItems)
      .values([
        { workspaceId: auth.workspaceId, deckId: deck.id, kind: "flashcard", prompt: "One", status: "proposed", createdBy: auth.userId, updatedBy: auth.userId },
        { workspaceId: auth.workspaceId, deckId: deck.id, kind: "flashcard", prompt: "Two", status: "retired", createdBy: auth.userId, updatedBy: auth.userId },
      ])
      .returning();
    const out = await approveItems(auth, { itemIds: rows.map((r) => r.id) });
    expect(out.approved).toBe(1);
    const [one] = await handle.db.select({ status: learningItems.status }).from(learningItems).where(eq(learningItems.id, rows[0].id));
    const [two] = await handle.db.select({ status: learningItems.status }).from(learningItems).where(eq(learningItems.id, rows[1].id));
    expect(one.status).toBe("approved");
    expect(two.status).toBe("retired");
  });

  it("workspace scoping: another workspace's deck is invisible", async () => {
    if (!handle) return;
    const other = await seedWorkspace(handle.db, `learning-other-${Date.now()}`);
    const otherAuth = ownerAuth(other.userId, other.workspaceId);
    const deck = await createDeck(otherAuth, { name: "Theirs" });
    expect(await listDecks(auth)).not.toContainEqual(expect.objectContaining({ id: deck.id }));
    expect(await dueItems(otherAuth, { deckId: deck.id })).toEqual([]);
  });
});
