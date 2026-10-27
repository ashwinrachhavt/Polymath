import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTaskWithNote } from "../helpers/task-note";
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
    for (const row of [
      { title: "a", status: "done" as const, completedAt: new Date("2026-10-13T03:00:00Z") }, // Oct 12 evening in LA
      { title: "b", status: "done" as const, completedAt: new Date("2026-10-14T18:00:00Z") },
      { title: "old", status: "done" as const, completedAt: new Date("2026-09-01T18:00:00Z") },
      { title: "open", status: "ready" as const },
    ]) {
      await seedTaskWithNote(db, { workspaceId: s.workspaceId, ...row });
    }
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
