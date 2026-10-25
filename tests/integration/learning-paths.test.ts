import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionProposals } from "@/domains/actions/schema";
import { artifacts, cards } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Learning paths (ASH-300), end to end against a scratch database:
 *  1. one goal becomes the path note plus a batch of note, task and card
 *     proposals - the notes and tasks wait in Reviews, the cards wait in
 *     the proposed state, and every card cites the path note;
 *  2. a retried generation resolves the same proposals instead of doubling
 *     the queue;
 *  3. an unusable model answer writes nothing.
 *
 * The generation provider is a mock. Skipped unless TEST_DATABASE_URL points
 * at a migrated scratch database.
 */

const DRAFT = JSON.stringify({
  pathTitle: "Understanding distributed consensus",
  overview: "Start with the problem, then Raft, then practice.",
  notes: [{ title: "Why consensus is hard", markdown: "Failures first, then the FLP result." }],
  practiceTasks: [{ title: "Sketch Raft's election on paper", description: "No notes, ten minutes." }],
  cards: [{ prompt: "What does a quorum prevent?", answer: "Two leaders deciding differently." }],
});

const mockProvider = { name: "test:mock", registryId: "mock", generate: async () => ({ text: DRAFT }) };

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let paths: typeof import("@/domains/knowledge/learning-paths");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  paths = await import("@/domains/knowledge/learning-paths");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  return { auth: ownerAuth(userId, workspaceId), userId, workspaceId };
}

suite("learning paths", () => {
  it("turns one goal into the path note plus note, task and card proposals", async () => {
    const { auth, workspaceId } = await seed("path-happy");

    const result = await paths.generateLearningPath(auth, { goal: "understand distributed consensus" }, { provider: mockProvider });

    expect(result.noteProposalIds).toHaveLength(1);
    expect(result.taskProposalIds).toHaveLength(1);
    expect(result.cardIds).toHaveLength(1);
    expect(result.deduplicated).toBe(0);

    const [pathNote] = await db.select().from(artifacts).where(eq(artifacts.id, result.artifactId));
    expect(pathNote.title).toBe("Understanding distributed consensus");

    const proposals = await db
      .select({ capability: actionProposals.capability, dedupeKey: actionProposals.dedupeKey, status: actionProposals.status })
      .from(actionProposals)
      .where(eq(actionProposals.workspaceId, workspaceId));
    expect(proposals).toHaveLength(2);
    for (const p of proposals) {
      expect(p.status).toBe("pending");
      expect(p.dedupeKey).toMatch(/^.*learning-path:understand-distributed-consensus:/);
    }
    expect(proposals.map((p) => p.capability).sort()).toEqual(["notes.create", "tasks.create"]);

    const [card] = await db.select().from(cards).where(eq(cards.id, result.cardIds[0]!));
    expect(card.state).toBe("proposed");
    expect(card.artifactId).toBe(result.artifactId);
    expect(card.sourceTitle).toBe("Understanding distributed consensus");
  });

  it("resolves the same proposals on a retried generation", async () => {
    const { auth, workspaceId } = await seed("path-replay");

    await paths.generateLearningPath(auth, { goal: "understand distributed consensus" }, { provider: mockProvider });
    const second = await paths.generateLearningPath(auth, { goal: "understand distributed consensus" }, { provider: mockProvider });

    expect(second.noteProposalIds).toHaveLength(0);
    expect(second.taskProposalIds).toHaveLength(0);
    expect(second.deduplicated).toBe(2);
    // Cards dedupe by idempotency key: the replay returns the same card.
    expect(second.cardIds).toHaveLength(1);
    expect(await db.select({ id: cards.id }).from(cards).where(eq(cards.workspaceId, workspaceId))).toHaveLength(1);
  });

  it("writes nothing when the model's answer is unusable", async () => {
    const { auth, workspaceId } = await seed("path-bad");
    const bad = { ...mockProvider, generate: async () => ({ text: "cannot do that" }) };
    await expect(paths.generateLearningPath(auth, { goal: "understand X" }, { provider: bad })).rejects.toThrowError(/not JSON/);
    expect(await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select({ id: actionProposals.id }).from(actionProposals).where(eq(actionProposals.workspaceId, workspaceId))).toHaveLength(0);
  });
});
