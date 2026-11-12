import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { concepts } from "@/domains/knowledge/schema";
import { missionConcepts, missions } from "@/domains/learning/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Deleting a Mission from Learn archives it. Proves the list stops showing
 * it (and its planned concepts), the undo puts back the exact status it had,
 * another workspace cannot touch it, and both steps leave an audit row.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof makeTestDb>["db"] | undefined } = { db: undefined };

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

import { getConceptOverview } from "@/domains/learning/concept-overview";
import { archiveMission, restoreMission } from "@/domains/learning/mission-archive";
import { listMissions, MissionError } from "@/domains/learning/missions";

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

type Auth = ReturnType<typeof ownerAuth>;

async function signIn(label: string): Promise<Auth> {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `msa-${label}-${Date.now()}-${Math.random()}`);
  return ownerAuth(userId, workspaceId);
}

/** A Mission with one planned concept, in the given status. */
async function seedMission(auth: Auth, status: "draft" | "active", term: string) {
  const [mission] = await holder
    .db!.insert(missions)
    .values({ workspaceId: auth.workspaceId, goal: `Own ${term}`, status, requestKey: crypto.randomUUID() })
    .returning({ id: missions.id });
  const [concept] = await holder
    .db!.insert(concepts)
    .values({ workspaceId: auth.workspaceId, term, sense: "domain" })
    .returning({ id: concepts.id });
  await holder.db!.insert(missionConcepts).values({
    workspaceId: auth.workspaceId,
    missionId: mission.id,
    conceptId: concept.id,
    ordinal: 0,
    reason: "It is tested.",
  });
  return mission.id;
}

async function auditActions(auth: Auth, missionId: string) {
  const rows = await holder
    .db!.select({ action: auditEvents.action, metadata: auditEvents.metadata })
    .from(auditEvents)
    .where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.subjectId, missionId)));
  return rows;
}

suite("deleting a Mission (archive and restore)", () => {
  it("archive hides the Mission and its planned concepts from Learn", async () => {
    const auth = await signIn("hide");
    const kept = await seedMission(auth, "draft", "Backpressure");
    const deleted = await seedMission(auth, "active", "Idempotency");

    const { priorStatus } = await archiveMission(auth, { missionId: deleted });
    expect(priorStatus).toBe("active");

    const listed = await listMissions(auth);
    expect(listed.map((m) => m.id)).toEqual([kept]);
    const overview = await getConceptOverview(auth);
    expect(overview.concepts.map((c) => c.term)).toEqual(["Backpressure"]);
  });

  it("restore brings it back with its old status", async () => {
    const auth = await signIn("restore");
    const draft = await seedMission(auth, "draft", "Retries");
    const active = await seedMission(auth, "active", "Quorums");

    const fromDraft = await archiveMission(auth, { missionId: draft });
    const fromActive = await archiveMission(auth, { missionId: active });
    expect(await listMissions(auth)).toEqual([]);

    await restoreMission(auth, { missionId: draft, status: fromDraft.priorStatus });
    await restoreMission(auth, { missionId: active, status: fromActive.priorStatus });

    const listed = await listMissions(auth);
    expect(Object.fromEntries(listed.map((m) => [m.id, m.status]))).toEqual({ [draft]: "draft", [active]: "active" });
    // A second restore finds no archived row.
    await expect(restoreMission(auth, { missionId: draft, status: "draft" })).rejects.toBeInstanceOf(MissionError);
  });

  it("another workspace cannot archive or restore it", async () => {
    const owner = await signIn("owner");
    const stranger = await signIn("stranger");
    const missionId = await seedMission(owner, "draft", "Sharding");

    await expect(archiveMission(stranger, { missionId })).rejects.toMatchObject({ code: "mission_not_found" });
    expect((await listMissions(owner)).map((m) => m.id)).toEqual([missionId]);

    await archiveMission(owner, { missionId });
    await expect(restoreMission(stranger, { missionId, status: "draft" })).rejects.toMatchObject({
      code: "mission_not_found",
    });
    expect(await listMissions(owner)).toEqual([]);
    expect(await auditActions(stranger, missionId)).toEqual([]);
  });

  it("writes an audit row for the archive and the restore", async () => {
    const auth = await signIn("audit");
    const missionId = await seedMission(auth, "active", "Consensus");

    await archiveMission(auth, { missionId });
    await restoreMission(auth, { missionId, status: "active" });

    const rows = await auditActions(auth, missionId);
    expect(rows).toEqual(
      expect.arrayContaining([
        { action: "learning.mission_archived", metadata: { priorStatus: "active" } },
        { action: "learning.mission_restored", metadata: { status: "active" } },
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});
