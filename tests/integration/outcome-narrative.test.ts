import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { focusSessions } from "@/domains/focus/schema";
import { rewardDefinitions, rewardLedger } from "@/domains/gamification/schema";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let reports: typeof import("@/domains/work/reports");
let queries: typeof import("@/domains/gamification/queries");
let narrative: typeof import("@/domains/work/outcome-narrative");
beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  reports = await import("@/domains/work/reports");
  queries = await import("@/domains/gamification/queries");
  narrative = await import("@/domains/work/outcome-narrative");
});
afterAll(async () => { await handle?.client.end(); });

const TZ = "America/Los_Angeles";
const WEEK = { start: "2026-10-12", end: "2026-10-18", timezone: TZ };

suite("weekly outcome narrative (ASH-280)", () => {
  it("composes from the week's finished sessions and earned stones only, scoped to the workspace", async () => {
    const s = await seedWorkspace(db, `narr-${Date.now()}`);
    const other = await seedWorkspace(db, `narr-other-${Date.now()}`);
    const auth = ownerAuth(s.userId, s.workspaceId);
    const [task] = await db.insert(tasks).values({ workspaceId: s.workspaceId, title: "Draft the roadmap", status: "ready" }).returning();

    const session = (workspaceId: string, over: Partial<typeof focusSessions.$inferInsert>) => ({
      workspaceId, state: "finished" as const, accumulatedSeconds: 1500, startedAt: new Date("2026-10-14T17:00:00Z"), endedAt: new Date("2026-10-14T17:25:00Z"), ...over,
    });
    await db.insert(focusSessions).values([
      session(s.workspaceId, { taskId: task.id, outcome: "Outlined three quarters" }),
      session(s.workspaceId, { endedAt: new Date("2026-10-13T03:00:00Z"), subject: "Evening read", outcome: "Finished chapter 4" }), // Oct 12 in LA: inside
      session(s.workspaceId, { endedAt: new Date("2026-10-20T17:25:00Z"), outcome: "Next week" }), // outside
      session(s.workspaceId, { state: "abandoned", outcome: "Never finished" }),
      session(other.workspaceId, { outcome: "Someone else's week" }),
    ]);

    const defs = await db.insert(rewardDefinitions).values([
      { workspaceId: s.workspaceId, key: "quartz", kind: "collectible", label: "Quartz", points: 10 },
      { workspaceId: s.workspaceId, key: "shard", kind: "collectible", label: "Shard", points: 0 },
    ]).returning();
    const quartz = defs.find((d) => d.key === "quartz")!;
    const shard = defs.find((d) => d.key === "shard")!;
    await db.insert(rewardLedger).values([
      { workspaceId: s.workspaceId, rewardDefinitionId: quartz.id, reason: "task_completed", points: 10, idempotencyKey: "q1", createdAt: new Date("2026-10-14T18:00:00Z") },
      { workspaceId: s.workspaceId, rewardDefinitionId: quartz.id, reason: "task_completed", points: 10, idempotencyKey: "q2", createdAt: new Date("2026-10-22T18:00:00Z") }, // outside
      { workspaceId: s.workspaceId, rewardDefinitionId: shard.id, reason: "adjustment", points: 0, idempotencyKey: "s1", createdAt: new Date("2026-10-14T19:00:00Z") }, // a claim, not an earning
      { workspaceId: s.workspaceId, rewardDefinitionId: quartz.id, reason: "adjustment", points: 5, idempotencyKey: "a1", createdAt: new Date("2026-10-14T20:00:00Z") },
    ]);

    const sessions = await reports.listFinishedSessionsInWeek(auth, { start: WEEK.start, timezone: TZ });
    const stones = await queries.listStonesEarnedInRange(auth, WEEK);
    expect(sessions.map((x) => x.outcome)).toEqual(["Finished chapter 4", "Outlined three quarters"]);
    expect(sessions.find((x) => x.outcome === "Outlined three quarters")!.taskTitle).toBe("Draft the roadmap");
    expect(stones).toHaveLength(1);

    const n = narrative.composeOutcomeNarrative({ start: WEEK.start, end: WEEK.end, sessions, stones })!;
    expect(n.markdown).toContain("finished 2 focus sessions (50 minutes in all) and earned 1 stone");
    expect(n.markdown).not.toMatch(/Next week|Never finished|Someone else/);
  });

  it("an empty week produces no narrative", async () => {
    const s = await seedWorkspace(db, `narr-empty-${Date.now()}`);
    const auth = ownerAuth(s.userId, s.workspaceId);
    const sessions = await reports.listFinishedSessionsInWeek(auth, { start: WEEK.start, timezone: TZ });
    const stones = await queries.listStonesEarnedInRange(auth, WEEK);
    expect(narrative.composeOutcomeNarrative({ start: WEEK.start, end: WEEK.end, sessions, stones })).toBeNull();
  });
});
