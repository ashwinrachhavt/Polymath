import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTaskWithNote } from "../helpers/task-note";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * A01 briefing reads: outcomes are canonical tasks tagged Outcome:<workspace
 * day>, suggestions fill up to three ordered by due date, the due list is
 * workspace-day aware, and waiting work stays out of the candidate pools.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let briefing: typeof import("@/domains/work/briefing");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  briefing = await import("@/domains/work/briefing");
});

afterAll(async () => {
  await handle?.client.end();
});

function noonUtc(isoDay: string) {
  return new Date(`${isoDay}T12:00:00Z`);
}

suite("briefing", () => {
  it("partitions the canonical task record into outcomes, suggestions, due and waiting", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `briefing-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    // Workspace timezone defaults to UTC, so the workspace day is the UTC day.
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const outcomeTag = `Outcome:${today}`;

    const seed = [
      { title: "Accepted outcome", rank: "a", status: "ready" as const, tags: [outcomeTag], dueAt: noonUtc(today) },
      { title: "Due today", rank: "b", status: "ready" as const, dueAt: noonUtc(today) },
      { title: "Overdue", rank: "c", status: "in_progress" as const, dueAt: noonUtc(yesterday) },
      { title: "Undated", rank: "d", status: "backlog" as const },
      { title: "Parked", rank: "e", status: "waiting" as const, dueAt: noonUtc(yesterday) },
      { title: "Finished", rank: "f", status: "done" as const, dueAt: noonUtc(yesterday) },
    ];
    for (const row of seed) {
      await seedTaskWithNote(db, {
        workspaceId,
        title: row.title,
        rank: row.rank,
        status: row.status,
        tags: row.tags ?? [],
        dueAt: row.dueAt ?? null,
        createdBy: userId,
        updatedBy: userId,
      });
    }

    const data = await briefing.getBriefing(auth);
    expect(data.today).toBe(today);

    expect(data.outcomes.map((t) => t.title)).toEqual(["Accepted outcome"]);
    // Suggestions fill to three minus the accepted count, most overdue first.
    expect(data.suggested.map((t) => t.title)).toEqual(["Overdue", "Due today"]);
    expect(data.dueTodayOrOverdue.map((t) => t.title)).toEqual(["Overdue", "Due today"]);
    expect(data.waiting.map((t) => t.title)).toEqual(["Parked"]);
    // Done work and accepted outcomes appear in no candidate pool.
    for (const list of [data.suggested, data.dueTodayOrOverdue, data.waiting]) {
      expect(list.map((t) => t.title)).not.toContain("Finished");
      expect(list.map((t) => t.title)).not.toContain("Accepted outcome");
    }
    // Versions ride along so outcome buttons can guard their writes.
    expect(data.outcomes[0].version).toBeGreaterThan(0);
    expect(data.outcomes[0].tags).toContain(outcomeTag);
  });
});
