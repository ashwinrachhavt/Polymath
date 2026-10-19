import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * A10 reward-ledger invariants: definitions move with optimistic concurrency
 * and audit rows; the ledger accepts exactly one entry per idempotency key
 * (a replay is a conflict, never a second award); totals are derived from
 * the append-only ledger, never stored.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/gamification/commands");
let queries: typeof import("@/domains/gamification/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/gamification/commands");
  queries = await import("@/domains/gamification/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

async function auditCount(auth: { workspaceId: string }, subjectIds: string[]) {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, auth.workspaceId));
  return rows.filter((row) => row.subjectId && subjectIds.includes(row.subjectId)).length;
}

suite("reward definitions", () => {
  it("creates a definition with its audit row and rejects a duplicate key", async () => {
    const auth = await seed("rewards-create");
    const quartz = await commands.createRewardDefinition(auth, {
      key: "quartz",
      kind: "points",
      label: "Quartz",
      description: "Finish a task-linked focus interval.",
      points: 10,
    });
    expect(quartz.version).toBe(1);
    expect(await auditCount(auth, [quartz.id])).toBe(1);

    await expect(
      commands.createRewardDefinition(auth, { key: "quartz", kind: "points", label: "Again", points: 5 }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("updates only at the expected version, bumping the row", async () => {
    const auth = await seed("rewards-update");
    const quartz = await commands.createRewardDefinition(auth, {
      key: "quartz",
      kind: "points",
      label: "Quartz",
      points: 10,
    });
    await expect(
      commands.updateRewardDefinition(auth, {
        key: "quartz",
        kind: "points",
        label: "Quartz",
        points: 25,
        expectedVersion: quartz.version + 9,
      }),
    ).rejects.toMatchObject({ code: "stale_write" });

    const updated = await commands.updateRewardDefinition(auth, {
      key: "quartz",
      kind: "points",
      label: "Quartz",
      points: 25,
      expectedVersion: quartz.version,
    });
    expect(updated.points).toBe(25);
    expect(updated.version).toBe(quartz.version + 1);
    expect(await auditCount(auth, [quartz.id])).toBe(2);
  });
});

suite("reward ledger", () => {
  it("records one award per idempotency key and derives totals", async () => {
    const auth = await seed("rewards-ledger");
    await commands.createRewardDefinition(auth, { key: "quartz", kind: "points", label: "Quartz", points: 25 });

    const entry = await commands.awardReward(auth, {
      definitionKey: "quartz",
      reason: "focus_completed",
      idempotencyKey: "focus_session:test-0001",
      subjectType: "focus_session",
      subjectId: "11111111-2222-3333-4444-555555555555",
    });
    expect(entry.points).toBe(25); // snapshot of the definition at award time
    expect(await auditCount(auth, [entry.id])).toBe(1);

    await expect(
      commands.awardReward(auth, {
        definitionKey: "quartz",
        reason: "focus_completed",
        idempotencyKey: "focus_session:test-0001",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const overview = await queries.getRewardsOverview(auth);
    expect(overview.totalPoints).toBe(25);
    expect(overview.activeDays).toBe(1);
    expect(overview.ledger[0].definitionKey).toBe("quartz");
  });

  it("refuses awards against unknown or disabled definitions", async () => {
    const auth = await seed("rewards-guards");
    await expect(
      commands.awardReward(auth, { definitionKey: "nope", reason: "adjustment", idempotencyKey: "k-1" }),
    ).rejects.toMatchObject({ code: "conflict" });

    const quartz = await commands.createRewardDefinition(auth, { key: "quartz", kind: "points", label: "Quartz", points: 5 });
    await commands.updateRewardDefinition(auth, {
      key: "quartz",
      kind: "points",
      label: "Quartz",
      points: 5,
      active: false,
      expectedVersion: quartz.version,
    });
    await expect(
      commands.awardReward(auth, { definitionKey: "quartz", reason: "adjustment", idempotencyKey: "k-2" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
