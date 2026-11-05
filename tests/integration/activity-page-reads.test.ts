import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { users } from "@/domains/identity/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";
import { loadActivityPage } from "@/app/(workspace)/activity/actions";
import { ACTIVITY_PAGE_SIZE } from "@/app/(workspace)/activity/present-view";

/*
 * The Activity page's filtered read model against real Postgres: registry
 * visibility (technical rows hidden until asked), the registry-derived
 * category filter, the actor filter, wildcard-safe search, the filter/pager
 * composition over keyset pages, and the deep-link lookup's visibility rules
 * (foreign workspace, private thread subject, malformed id). Each test seeds
 * its own workspace, so tests stay isolated without truncation.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

const getAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>();
  return { ...original, getAuthContext };
});

import { getActivityEvent, listActivityActors, listActivityEvents } from "@/domains/audit/queries";

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

const authFor = async (label: string) => ({
  ...(await seedWorkspace(holder.db!, `activity-reads-${label}`)),
  role: "owner" as const,
});

type SeedRow = {
  action: string;
  subjectType: string;
  summary: string;
  actorId?: string | null;
  actorKind?: "user" | "system" | "agent";
  minutesAgo?: number;
};

async function seedRows(workspaceId: string, rows: SeedRow[]) {
  const now = Date.now();
  await holder.db!.insert(auditEvents).values(
    rows.map((row) => ({
      workspaceId,
      actorId: row.actorId ?? null,
      actorKind: row.actorKind ?? ("user" as const),
      action: row.action,
      subjectType: row.subjectType,
      summary: row.summary,
      createdAt: new Date(now - (row.minutesAgo ?? 0) * 60_000),
    })),
  );
}

async function firstRowId(workspaceId: string): Promise<string> {
  const [row] = await holder
    .db!.select({ id: auditEvents.id })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .limit(1);
  return row!.id;
}

suite("listActivityEvents filters (real Postgres)", () => {
  it("returns everything by default; only an explicit false hides technical rows", async () => {
    const auth = await authFor(crypto.randomUUID());
    await seedRows(auth.workspaceId, [
      { action: "capture.created", subjectType: "capture", summary: "Added a capture" },
      { action: "task.created", subjectType: "task", summary: "Created task" },
    ]);

    // No filters: the read returns everything it scopes - the page's toggle
    // owns hiding technical rows, never this read's default.
    const unfiltered = await listActivityEvents(auth, {});
    expect(unfiltered.rows.map((row) => row.action).sort()).toEqual(["capture.created", "task.created"]);

    const hidden = await listActivityEvents(auth, { filters: { includeTechnical: false } });
    expect(hidden.rows.map((row) => row.action)).toEqual(["capture.created"]);

    const shown = await listActivityEvents(auth, { filters: { includeTechnical: true } });
    expect(shown.rows.map((row) => row.action).sort()).toEqual(["capture.created", "task.created"]);
  });

  it("filters by registry category", async () => {
    const auth = await authFor(crypto.randomUUID());
    await seedRows(auth.workspaceId, [
      { action: "capture.created", subjectType: "capture", summary: "capture knowledge" },
      { action: "event.created", subjectType: "event", summary: "calendar work" },
      { action: "run.feedback.up", subjectType: "run", summary: "agents feedback" },
    ]);

    const knowledge = await listActivityEvents(auth, { filters: { category: "knowledge" } });
    expect(knowledge.rows.map((row) => row.action)).toEqual(["capture.created"]);
    const work = await listActivityEvents(auth, { filters: { category: "work" } });
    expect(work.rows.map((row) => row.action)).toEqual(["event.created"]);
  });

  it("filters by actor id", async () => {
    const auth = await authFor(crypto.randomUUID());
    const otherMember = crypto.randomUUID();
    await seedRows(auth.workspaceId, [
      { action: "capture.created", subjectType: "capture", summary: "the viewer's row", actorId: auth.userId },
      { action: "capture.created", subjectType: "capture", summary: "another member's row", actorId: otherMember },
    ]);

    const mine = await listActivityEvents(auth, { filters: { actorId: auth.userId } });
    expect(mine.rows.map((row) => row.summary)).toEqual(["the viewer's row"]);
  });

  it("searches the stored summary and the action name, with wildcards matched literally", async () => {
    const auth = await authFor(crypto.randomUUID());
    await seedRows(auth.workspaceId, [
      { action: "capture.created", subjectType: "capture", summary: "Quarterly roadmap capture" },
      { action: "capture.converted", subjectType: "capture", summary: "Capture converted to note" },
      { action: "capture.created", subjectType: "capture", summary: "Budget hit 100% of plan" },
    ]);

    const bySummary = await listActivityEvents(auth, { filters: { q: "roadmap" } });
    expect(bySummary.rows.map((row) => row.summary)).toEqual(["Quarterly roadmap capture"]);

    const byAction = await listActivityEvents(auth, { filters: { q: "converted" } });
    expect(byAction.rows.map((row) => row.action)).toEqual(["capture.converted"]);

    // A hand-typed wildcard matches itself, not everything.
    const literalPercent = await listActivityEvents(auth, { filters: { q: "100%" } });
    expect(literalPercent.rows.map((row) => row.summary)).toEqual(["Budget hit 100% of plan"]);
    const literalUnderscore = await listActivityEvents(auth, { filters: { q: "r_admap" } });
    expect(literalUnderscore.rows).toHaveLength(0);
  });

  it("composes a category filter with keyset pagination without gaps or duplicates", async () => {
    const auth = await authFor(crypto.randomUUID());
    const now = Date.now();
    await holder.db!.insert(auditEvents).values(
      Array.from({ length: 12 }, (_, i) => ({
        workspaceId: auth.workspaceId,
        actorKind: "user" as const,
        action: i % 2 === 0 ? "capture.created" : "task.created",
        subjectType: i % 2 === 0 ? "capture" : "task",
        summary: `row ${i}`,
        createdAt: new Date(now - i * 1000),
      })),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await listActivityEvents(auth, { limit: 3, cursor, filters: { category: "knowledge" } });
      seen.push(...result.rows.map((row) => row.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });
});

suite("getActivityEvent (deep-link lookup, real Postgres)", () => {
  it("returns a visible row by id", async () => {
    const auth = await authFor(crypto.randomUUID());
    await seedRows(auth.workspaceId, [{ action: "capture.created", subjectType: "capture", summary: "find me" }]);
    const found = await getActivityEvent(auth, await firstRowId(auth.workspaceId));
    expect(found?.summary).toBe("find me");
  });

  it("returns null for a private thread subject, a foreign workspace, and a malformed id", async () => {
    const auth = await authFor(crypto.randomUUID());
    await seedRows(auth.workspaceId, [
      { action: "conversation.navigation_answered", subjectType: "thread", summary: "private exchange" },
    ]);
    expect(await getActivityEvent(auth, await firstRowId(auth.workspaceId))).toBeNull();

    const foreign = await authFor(crypto.randomUUID());
    await seedRows(foreign.workspaceId, [{ action: "capture.created", subjectType: "capture", summary: "not yours" }]);
    expect(await getActivityEvent(auth, await firstRowId(foreign.workspaceId))).toBeNull();

    expect(await getActivityEvent(auth, "not-a-uuid")).toBeNull();
  });
});

suite("listActivityActors (real Postgres)", () => {
  it("lists distinct user actors with hydrated names, excluding system rows and thread subjects", async () => {
    const auth = await authFor(crypto.randomUUID());
    const [other] = await holder
      .db!.insert(users)
      .values({ clerkUserId: `tw_${crypto.randomUUID()}`, displayName: "Alex Rivera" })
      .returning();
    await seedRows(auth.workspaceId, [
      { action: "capture.created", subjectType: "capture", summary: "viewer", actorId: auth.userId },
      { action: "capture.created", subjectType: "capture", summary: "named member", actorId: other!.id },
      { action: "capture.created", subjectType: "capture", summary: "system row", actorId: null, actorKind: "system" },
      { action: "conversation.navigation_answered", subjectType: "thread", summary: "private", actorId: other!.id },
    ]);

    const actors = await listActivityActors(auth);
    expect(actors.map((actor) => actor.id).sort()).toEqual([auth.userId, other!.id].sort());
    expect(actors.find((actor) => actor.id === other!.id)?.label).toBe("Alex Rivera");
  });
});

/*
 * Spec W3 verification 5, against real Postgres: the incremental "Load more"
 * action must render exactly the rows the page's own first read + the action's
 * per-page fetches produce - same rows, same order, no duplicates, no gaps -
 * where the old code re-walked from page 0 on every click. A cursor the page
 * itself minted must always be accepted; a forged one must be a named
 * failure, never a thrown render.
 */
suite("loadActivityPage (the incremental Load-more action, real Postgres)", () => {
  it("appends exactly the next cursor page: same rows, order, no dupes or gaps versus one full walk", async () => {
    const auth = await authFor(crypto.randomUUID());
    getAuthContext.mockResolvedValue(auth);
    const now = Date.now();
    await holder.db!.insert(auditEvents).values(
      Array.from({ length: 57 }, (_, i) => ({
        workspaceId: auth.workspaceId,
        actorKind: "user" as const,
        action: "capture.created",
        subjectType: "capture",
        summary: `row ${i}`,
        createdAt: new Date(now - i * 1000),
      })),
    );

    // Page 1 the way the page renders it: one keyset read, no cursor.
    const first = await listActivityEvents(auth, { limit: ACTIVITY_PAGE_SIZE, filters: { includeTechnical: true } });
    expect(first.rows).toHaveLength(ACTIVITY_PAGE_SIZE);

    // Every later page through the action, appending until it reports the end.
    const flat: string[] = first.rows.map((row) => row.id);
    let cursor: string | null = first.nextCursor;
    for (let page = 0; page < 5 && cursor; page += 1) {
      const more = await loadActivityPage({}, cursor, "UTC");
      if (!more.ok) throw new Error("the action rejected a cursor the page itself minted");
      flat.push(...more.groups.flatMap((group) => group.items.map((item) => item.id)));
      cursor = more.nextCursor;
    }

    // Equivalence: identical to a single unpaginated read of the same rows.
    const whole = await listActivityEvents(auth, { limit: 200, filters: { includeTechnical: true } });
    expect(flat).toEqual(whole.rows.map((row) => row.id));
    expect(new Set(flat).size).toBe(flat.length);
  });

  it("degrades a forged or malformed cursor to a named failure", async () => {
    getAuthContext.mockResolvedValue(await authFor(crypto.randomUUID()));
    expect(await loadActivityPage({}, "not-a-cursor", "UTC")).toEqual({ ok: false, error: "invalid-cursor" });
  });
});
