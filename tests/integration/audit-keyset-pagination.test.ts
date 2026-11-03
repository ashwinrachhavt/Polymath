import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Keyset pagination over the extended activity read model against real
 * Postgres. The seed stacks every row on one timestamp so page boundaries
 * land inside a same-second group: ordering then falls to the id tiebreak,
 * and only a correct (created_at, id) tuple cursor can walk the pages with
 * no gaps and no duplicates. The privacy invariants ride along: thread
 * subjects never join the feed, another workspace's rows are invisible, the
 * raw stored summary comes back unprojected, and the metadata column is not
 * selected at all.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

import { decodeActivityCursor, encodeActivityCursor, listActivityEvents } from "@/domains/audit/queries";

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

const authFor = async (label: string) => ({
  ...(await seedWorkspace(holder.db!, `activity-${label}`)),
  role: "owner" as const,
});

const ROW_COUNT = 55;
const SAME_INSTANT = new Date("2026-11-03T12:00:00.000Z");

async function seedAuditRows(workspaceId: string, count: number, createdAt = SAME_INSTANT) {
  return holder
    .db!.insert(auditEvents)
    .values(
      Array.from({ length: count }, (_, i) => ({
        workspaceId,
        actorKind: "user" as const,
        action: "capture.created",
        subjectType: "capture",
        subjectId: crypto.randomUUID(),
        summary: `raw stored summary ${i}`,
        metadata: { secret: "never-selected" },
        createdAt,
      })),
    )
    .returning({ id: auditEvents.id });
}

suite("listActivityEvents keyset pagination (real Postgres)", () => {
  it("walks every page with no gaps and no duplicates across a same-second boundary", async () => {
    const auth = await authFor(crypto.randomUUID());
    const seeded = await seedAuditRows(auth.workspaceId, ROW_COUNT);
    expect(seeded).toHaveLength(ROW_COUNT);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await listActivityEvents(auth, { limit: 10, cursor });
      expect(result.rows.length).toBeLessThanOrEqual(10);
      seen.push(...result.rows.map((row) => row.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(seen).toHaveLength(ROW_COUNT);
    expect(new Set(seen).size).toBe(ROW_COUNT);
    expect(new Set(seen)).toEqual(new Set(seeded.map((row) => row.id)));
  });

  it("orders pages by created_at DESC with the id tiebreak", async () => {
    const auth = await authFor(crypto.randomUUID());
    await holder.db!.insert(auditEvents).values([
      {
        workspaceId: auth.workspaceId,
        action: "capture.created",
        subjectType: "capture",
        summary: "older",
        createdAt: new Date(SAME_INSTANT.getTime() - 60_000),
      },
      {
        workspaceId: auth.workspaceId,
        action: "capture.created",
        subjectType: "capture",
        summary: "newest",
        createdAt: new Date(SAME_INSTANT.getTime() + 60_000),
      },
      {
        workspaceId: auth.workspaceId,
        action: "capture.created",
        subjectType: "capture",
        summary: "pinned",
        createdAt: SAME_INSTANT,
      },
    ]);
    const { rows } = await listActivityEvents(auth, { limit: 10 });
    expect(rows.map((row) => row.summary)).toEqual(["newest", "pinned", "older"]);
  });

  it("never returns thread subjects, foreign rows, projected summaries, or metadata", async () => {
    const auth = await authFor(crypto.randomUUID());
    const other = await authFor(crypto.randomUUID());
    await seedAuditRows(other.workspaceId, 3);
    await seedAuditRows(auth.workspaceId, 3);
    await holder.db!.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      action: "supervisor.message_sent",
      subjectType: "thread",
      subjectId: crypto.randomUUID(),
      summary: "private thread exchange",
      createdAt: SAME_INSTANT,
    });

    const { rows } = await listActivityEvents(auth, { limit: 50 });
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.subjectType !== "thread")).toBe(true);
    expect(rows.every((row) => row.summary.startsWith("raw stored summary"))).toBe(true);
    for (const row of rows) {
      expect("metadata" in row).toBe(false);
    }
  });

  it("rejects a malformed cursor instead of silently restarting from the top", () => {
    expect(() => decodeActivityCursor("not-a-cursor")).toThrow("Malformed activity cursor");
  });

  it("round-trips the cursor through encode/decode", () => {
    const cursor = encodeActivityCursor({ createdAt: SAME_INSTANT, id: crypto.randomUUID() });
    const decoded = decodeActivityCursor(cursor);
    expect(decoded.createdAt.toISOString()).toBe(SAME_INSTANT.toISOString());
  });
});
