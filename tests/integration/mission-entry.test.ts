import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generationJobs } from "@/domains/jobs/schema";
import { concepts } from "@/domains/knowledge/schema";
import { missionConcepts, missions } from "@/domains/learning/schema";
import type { ProposedMissionConcept } from "@/integrations/learning/mission-concepts";
import { seedReadDocument } from "../helpers/learning-fixtures";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Mission entry against real Postgres: a proposal is kept only when its quote
 * locates in the source it names, duplicates and near-duplicates collapse to
 * one concept, the count is capped, a double submit is one Mission and one
 * job, and another workspace sees none of it.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof makeTestDb>["db"] | undefined } = { db: undefined };
const authHolder: { ctx: { userId: string; workspaceId: string; role: "owner" | "member" } | undefined } = {
  ctx: undefined,
};
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => authHolder.ctx) }));
const kick = vi.hoisted(() => ({ kickGenerationJob: vi.fn() }));
vi.mock("@/domains/jobs/kick", () => kick);
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

import { createMissionAction } from "@/app/(workspace)/learn/mission-actions";
import { prepareMissionConcepts } from "@/domains/learning/missions";
import type { MissionConceptGenerator } from "@/integrations/learning/mission-concepts";

beforeAll(() => {
  holder.db = handle?.db;
  vi.stubEnv("GENERATION_PROVIDER", "fixture");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});

const TEXT =
  "An idempotency key lets a server recognise a repeated request. The write-ahead log records a change before it is applied, so a crash can be recovered. Backpressure slows a producer when the consumer cannot keep up. A lease renews on March 1. Rent rises unless notice is given.";

type Auth = ReturnType<typeof ownerAuth>;

async function signIn(label: string): Promise<Auth> {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `mis-${label}-${Date.now()}-${Math.random()}`);
  const auth = ownerAuth(userId, workspaceId);
  authHolder.ctx = auth;
  return auth;
}

function proposal(name: string, quote: string, sourceIndex = 0, reason = "It matters."): ProposedMissionConcept {
  return { name, quote, sourceIndex, reason };
}

function fakeGenerator(conceptsOut: ProposedMissionConcept[]) {
  const generator: MissionConceptGenerator = {
    name: "fake",
    propose: async () => ({ concepts: conceptsOut }),
  };
  return generator;
}

async function seedMissionWithSource(auth: Auth, label: string) {
  const { documentId } = await seedReadDocument(holder.db!, auth, TEXT, `${label} source`);
  return documentId;
}

suite("createMissionAction", () => {
  it("returns at once with a job and makes one Mission for a double submit", async () => {
    const auth = await signIn("double");
    const documentId = await seedMissionWithSource(auth, "double");
    const input = {
      goal: "Explain database transactions unaided",
      sources: [{ type: "document" as const, id: documentId }],
      idempotencyKey: crypto.randomUUID(),
    };
    const first = await createMissionAction(input);
    const second = await createMissionAction(input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.missionId).toBe(first.missionId);
    expect(kick.kickGenerationJob).toHaveBeenCalledTimes(1);
    const rows = await holder.db!.select().from(missions).where(eq(missions.workspaceId, auth.workspaceId));
    expect(rows).toHaveLength(1);
    const jobs = await holder
      .db!.select()
      .from(generationJobs)
      .where(and(eq(generationJobs.workspaceId, auth.workspaceId), eq(generationJobs.kind, "learning.mission")));
    expect(jobs).toHaveLength(1);
  });

  it("keeps only the proposals whose passage locates in the source", async () => {
    const auth = await signIn("grounding");
    const documentId = await seedMissionWithSource(auth, "grounding");
    const { missionId } = await createMission(auth, documentId, "grounding-goal");
    await prepareMissionConcepts(
      auth,
      missionId,
      fakeGenerator([
        proposal("Idempotency key", "An idempotency key lets a server recognise a repeated request."),
        proposal("Invented idea", "this sentence is nowhere in the source at all"),
        proposal("Write-ahead log", "The write-ahead log records a change before it is applied"),
      ]),
    );
    const rows = await holder
      .db!.select({ term: concepts.term })
      .from(missionConcepts)
      .innerJoin(concepts, eq(concepts.id, missionConcepts.conceptId))
      .where(eq(missionConcepts.missionId, missionId))
      .orderBy(missionConcepts.ordinal);
    expect(rows.map((row) => row.term)).toEqual(["Idempotency key", "Write-ahead log"]);
  });

  it("collapses duplicates and near-duplicates by name, keeping the first", async () => {
    const auth = await signIn("dedupe");
    const documentId = await seedMissionWithSource(auth, "dedupe");
    const { missionId } = await createMission(auth, documentId, "dedupe-goal");
    await prepareMissionConcepts(
      auth,
      missionId,
      fakeGenerator([
        proposal("Backpressure", "Backpressure slows a producer when the consumer cannot keep up."),
        proposal("  backpressure  ", "Backpressure slows a producer when the consumer cannot keep up."),
        proposal("Two words", "A lease renews on March 1."),
      ]),
    );
    const rows = await holder.db!.select().from(missionConcepts).where(eq(missionConcepts.missionId, missionId));
    expect(rows).toHaveLength(2);
  });

  it("caps the plan at the explicit bound", async () => {
    const auth = await signIn("bound");
    const documentId = await seedMissionWithSource(auth, "bound");
    const { missionId } = await createMission(auth, documentId, "bound-goal");
    const many = Array.from({ length: 25 }, (_, index) =>
      proposal(`Concept ${index}`, "An idempotency key lets a server recognise a repeated request."),
    );
    await prepareMissionConcepts(auth, missionId, fakeGenerator(many));
    const rows = await holder.db!.select().from(missionConcepts).where(eq(missionConcepts.missionId, missionId));
    expect(rows).toHaveLength(10);
  });

  it("refuses a proposal set with nothing grounded and keeps the Mission a draft", async () => {
    const auth = await signIn("nothing");
    const documentId = await seedMissionWithSource(auth, "nothing");
    const { missionId } = await createMission(auth, documentId, "nothing-goal");
    await expect(
      prepareMissionConcepts(
        auth,
        missionId,
        fakeGenerator([proposal("Unsupported", "words that do not appear anywhere in this fixture")]),
      ),
    ).rejects.toThrow(/grounded/);
    const rows = await holder.db!.select().from(missionConcepts).where(eq(missionConcepts.missionId, missionId));
    expect(rows).toHaveLength(0);
  });

  it("rejects an empty goal and a Mission with no sources", async () => {
    const auth = await signIn("invalid");
    const documentId = await seedMissionWithSource(auth, "invalid");
    const noGoal = await createMissionAction({
      goal: "   ",
      sources: [{ type: "document", id: documentId }],
      idempotencyKey: crypto.randomUUID(),
    });
    expect(noGoal.ok).toBe(false);
    const noSources = await createMissionAction({
      goal: "Something",
      sources: [],
      idempotencyKey: crypto.randomUUID(),
    });
    expect(noSources.ok).toBe(false);
  });

  it("isolates Missions by workspace", async () => {
    const mine = await signIn("iso-mine");
    const doc = await seedMissionWithSource(mine, "iso");
    const { missionId } = await createMission(mine, doc, "iso-goal");
    // A second member in another workspace cannot start or read this Mission.
    await signIn("iso-theirs");
    const { startMissionAction } = await import("@/app/(workspace)/learn/mission-actions");
    const result = await startMissionAction(missionId);
    expect(result.ok).toBe(false);
  });
});

/** A Mission with one source, made through the same path the action uses. */
async function createMission(auth: Auth, documentId: string, goal: string) {
  const result = await createMissionAction({
    goal,
    sources: [{ type: "document", id: documentId }],
    idempotencyKey: crypto.randomUUID(),
  });
  if (!result.ok) throw new Error(result.error);
  return { missionId: result.missionId };
}
