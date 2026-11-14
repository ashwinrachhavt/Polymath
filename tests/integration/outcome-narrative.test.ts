import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { focusSessions } from "@/domains/focus/schema";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let reports: typeof import("@/domains/work/reports");
let narrative: typeof import("@/domains/work/outcome-narrative");
beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  reports = await import("@/domains/work/reports");
  narrative = await import("@/domains/work/outcome-narrative");
});
afterAll(async () => {
  await handle?.client.end();
});

const TZ = "America/Los_Angeles";
const WEEK = { start: "2026-10-12", end: "2026-10-18", timezone: TZ };

suite("weekly outcome narrative (ASH-280)", () => {
  it("composes from the week's finished sessions only, scoped to the workspace", async () => {
    const s = await seedWorkspace(db, `narr-${Date.now()}`);
    const other = await seedWorkspace(db, `narr-other-${Date.now()}`);
    const auth = ownerAuth(s.userId, s.workspaceId);
    const [task] = await db
      .insert(tasks)
      .values({ workspaceId: s.workspaceId, title: "Draft the roadmap", status: "ready" })
      .returning();

    const session = (workspaceId: string, over: Partial<typeof focusSessions.$inferInsert>) => ({
      workspaceId,
      state: "finished" as const,
      accumulatedSeconds: 1500,
      startedAt: new Date("2026-10-14T17:00:00Z"),
      endedAt: new Date("2026-10-14T17:25:00Z"),
      ...over,
    });
    await db.insert(focusSessions).values([
      session(s.workspaceId, { taskId: task.id, outcome: "Outlined three quarters" }),
      session(s.workspaceId, {
        endedAt: new Date("2026-10-13T03:00:00Z"),
        subject: "Evening read",
        outcome: "Finished chapter 4",
      }), // Oct 12 in LA: inside
      session(s.workspaceId, { endedAt: new Date("2026-10-20T17:25:00Z"), outcome: "Next week" }), // outside
      session(s.workspaceId, { state: "abandoned", outcome: "Never finished" }),
      session(other.workspaceId, { outcome: "Someone else's week" }),
    ]);

    const sessions = await reports.listFinishedSessionsInWeek(auth, { start: WEEK.start, timezone: TZ });
    expect(sessions.map((x) => x.outcome)).toEqual(["Finished chapter 4", "Outlined three quarters"]);
    expect(sessions.find((x) => x.outcome === "Outlined three quarters")!.taskTitle).toBe("Draft the roadmap");

    const n = narrative.composeOutcomeNarrative({ start: WEEK.start, end: WEEK.end, sessions })!;
    expect(n.markdown).toContain("finished 2 focus sessions (50 minutes in all).");
    expect(n.markdown).not.toMatch(/Next week|Never finished|Someone else/);
  });

  it("an empty week produces no narrative", async () => {
    const s = await seedWorkspace(db, `narr-empty-${Date.now()}`);
    const auth = ownerAuth(s.userId, s.workspaceId);
    const sessions = await reports.listFinishedSessionsInWeek(auth, { start: WEEK.start, timezone: TZ });
    expect(narrative.composeOutcomeNarrative({ start: WEEK.start, end: WEEK.end, sessions })).toBeNull();
  });
});
