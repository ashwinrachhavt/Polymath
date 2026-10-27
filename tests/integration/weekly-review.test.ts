import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let reports: typeof import("@/domains/work/reports");
beforeAll(async () => { if (!handle) return; ({ db } = handle); reports = await import("@/domains/work/reports"); });
afterAll(async () => { await handle?.client.end(); });

suite("weekly review (D15)", () => {
  it("buckets completions by real timestamp in the user's timezone", async () => {
    const s = await seedWorkspace(db, `weekly-${Date.now()}`);
    const auth = ownerAuth(s.userId, s.workspaceId);
    await db.insert(tasks).values([
      { workspaceId: s.workspaceId, title: "a", status: "done", completedAt: new Date("2026-10-13T03:00:00Z") }, // Oct 12 evening in LA
      { workspaceId: s.workspaceId, title: "b", status: "done", completedAt: new Date("2026-10-14T18:00:00Z") },
      { workspaceId: s.workspaceId, title: "old", status: "done", completedAt: new Date("2026-09-01T18:00:00Z") },
      { workspaceId: s.workspaceId, title: "open", status: "ready" },
    ]);
    const r = await reports.getWeeklyReview(auth, { start: "2026-10-12", timezone: "America/Los_Angeles" });
    expect(r.totals.completedTasks).toBe(2);
    expect(r.days[0].completedTasks).toBe(1);
    expect(r.days[2].completedTasks).toBe(1);
  });
  it("week start and streak helpers", () => {
    expect(reports.weekStartFor("2026-10-14", 1)).toBe("2026-10-12");
    expect(reports.weekStartFor("2026-10-14", 7)).toBe("2026-10-11");
    expect(reports.computeStreak(new Set(["2026-10-18", "2026-10-17"]), "2026-10-18", 7)).toBe(2);
  });
});
