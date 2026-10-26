import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionProposals } from "@/domains/actions/schema";
import { auditEvents } from "@/domains/audit/schema";
import { externalAccounts, syncCursors, triggers } from "@/domains/integrations/schema";
import type { Transport } from "@/domains/integrations/transport";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The owner's opt-in switch for new-sender suggestions (ASH-287), on a scratch
 * database. Enabling needs the live gates and the owner role; disabling always
 * works; racing or stale toggles lose; enabling forgets the old watermark; and a
 * pass that is mid-read when the switch goes off writes nothing.
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let sync: typeof import("@/domains/crm/sender-sync");
let workspaceId: string;
let userId: string;
let accountId: string;

const owner = () => ownerAuth(userId, workspaceId);
async function account() {
  const [row] = await db.select().from(externalAccounts).where(eq(externalAccounts.id, accountId));
  return row;
}
async function trigger() {
  const [row] = await db.select().from(triggers).where(and(eq(triggers.externalAccountId, accountId), eq(triggers.eventType, "crm.sender_proposals")));
  return row;
}

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  sync = await import("@/domains/crm/sender-sync");
  ({ workspaceId, userId } = await seedWorkspace(db, "crm-toggle"));
  const [acct] = await db
    .insert(externalAccounts)
    .values({ workspaceId, provider: "gmail", alias: "work", composioConnectedAccountId: "ca_toggle", providerAccountId: "owner@mine.com", status: "active", accessTier: "read_only" })
    .returning();
  accountId = acct.id;
});
afterAll(async () => {
  await handle?.client.end();
});

suite("sender suggestion switch", () => {
  it("is owner-only", async () => {
    const a = await account();
    await expect(sync.setSenderProposals({ ...owner(), role: "member" }, { accountId, expectedVersion: a.version, enabled: true })).rejects.toThrow(/Requires owner/);
    expect(await trigger()).toBeUndefined();
  });

  it("enabling needs read access and a live connection", async () => {
    let a = await account();
    await db.update(externalAccounts).set({ allowRead: false }).where(eq(externalAccounts.id, accountId));
    await expect(sync.setSenderProposals(owner(), { accountId, expectedVersion: a.version, enabled: true })).rejects.toMatchObject({ code: "read_not_allowed" });
    await db.update(externalAccounts).set({ allowRead: true, status: "revoked" }).where(eq(externalAccounts.id, accountId));
    await expect(sync.setSenderProposals(owner(), { accountId, expectedVersion: a.version, enabled: true })).rejects.toMatchObject({ code: "no_connection" });
    await db.update(externalAccounts).set({ status: "active" }).where(eq(externalAccounts.id, accountId));
    a = await account();
    expect(await trigger()).toBeUndefined();
    const on = await sync.setSenderProposals(owner(), { accountId, expectedVersion: a.version, enabled: true });
    expect(on).toEqual({ enabled: true, version: a.version + 1 });
    expect((await trigger()).status).toBe("enabled");
    const audits = await db.select().from(auditEvents).where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.action, "crm.sender_proposals_enabled")));
    expect(audits).toHaveLength(1);
  });

  it("disabling works even with read revoked and the account disconnected", async () => {
    await db.update(externalAccounts).set({ allowRead: false, status: "revoked" }).where(eq(externalAccounts.id, accountId));
    const a = await account();
    await sync.setSenderProposals(owner(), { accountId, expectedVersion: a.version, enabled: false });
    expect((await trigger()).status).toBe("paused");
    await db.update(externalAccounts).set({ allowRead: true, status: "active" }).where(eq(externalAccounts.id, accountId));
  });

  it("a stale version loses, and of two racing toggles exactly one wins", async () => {
    const a = await account();
    await expect(sync.setSenderProposals(owner(), { accountId, expectedVersion: a.version - 1, enabled: true })).rejects.toThrow(/changed since you loaded/);
    const results = await Promise.allSettled([
      sync.setSenderProposals(owner(), { accountId, expectedVersion: a.version, enabled: true }),
      sync.setSenderProposals(owner(), { accountId, expectedVersion: a.version, enabled: false }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await account()).version).toBe(a.version + 1);
    const rows = await db.select().from(triggers).where(and(eq(triggers.externalAccountId, accountId), eq(triggers.eventType, "crm.sender_proposals")));
    expect(rows).toHaveLength(1);
  });

  it("enabling starts the watermark at that moment: mail from the off period is never read", async () => {
    let a = await account();
    if ((await trigger()).status === "enabled") {
      await sync.setSenderProposals(owner(), { accountId, expectedVersion: a.version, enabled: false });
      a = await account();
    }
    await db.delete(syncCursors).where(eq(syncCursors.externalAccountId, accountId));
    await db.insert(syncCursors).values({ workspaceId, externalAccountId: accountId, resource: "sender-proposals", cursor: JSON.stringify({ watermark: 1, pending: [] }), state: "idle" });
    const before = Math.floor(Date.now() / 1000);
    await sync.setSenderProposals(owner(), { accountId, expectedVersion: a.version, enabled: true });
    const [row] = await db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, accountId));
    const cursor = JSON.parse(row.cursor!) as { watermark: number; pending: unknown[] };
    expect(cursor.watermark).toBeGreaterThanOrEqual(before);
    expect(cursor.pending).toEqual([]);

    // One message from the off period (before enabling), one after: only the later one is read.
    const oldSec = cursor.watermark - 3600;
    const newSec = cursor.watermark + 5;
    const queries: string[] = [];
    const transport: Transport = {
      async read(request) {
        const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
        const mails = [{ id: "old", sec: oldSec, from: "Old <old@offperiod.io>" }, { id: "new", sec: newSec, from: "New <new@afterenable.io>" }];
        if (request.endpoint === base) {
          const q = request.query?.q ?? "";
          queries.push(q);
          const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
          return { ok: true, status: 200, data: { messages: mails.filter((m) => m.sec > after).map((m) => ({ id: m.id, threadId: `th-${m.id}` })) } };
        }
        const m = mails.find((x) => request.endpoint === `${base}/${x.id}`)!;
        return { ok: true, status: 200, data: { id: m.id, threadId: `th-${m.id}`, internalDate: String(m.sec * 1000), payload: { headers: [{ name: "From", value: m.from }, { name: "Subject", value: "Hi" }] } } };
      },
    };
    const result = await sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport, now: new Date((newSec + 10) * 1000) });
    expect(queries[0]).toContain(`after:${cursor.watermark}`);
    expect(result.proposed.map((p) => p.email)).toEqual(["new@afterenable.io"]);
    // The overlap never reaches back before the enable moment.
    const [after] = await db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, accountId));
    expect((JSON.parse(after.cursor!) as { watermark: number }).watermark).toBeGreaterThanOrEqual(cursor.watermark);
    await db.delete(actionProposals).where(eq(actionProposals.workspaceId, workspaceId));
    await db.delete(syncCursors).where(eq(syncCursors.externalAccountId, accountId));
  });

  it("a pass whose switch goes off mid-read proposes nothing and keeps the cursor", async () => {
    const transport: Transport = {
      async read(request) {
        if (request.endpoint.endsWith("/messages")) {
          // The owner flips the switch while the pass is reading.
          await db.update(triggers).set({ status: "paused" }).where(eq(triggers.externalAccountId, accountId));
          return { ok: true, status: 200, data: { messages: [{ id: "x", threadId: "th-x" }] } };
        }
        return { ok: true, status: 200, data: { id: "x", threadId: "th-x", internalDate: String(Date.now()), payload: { headers: [{ name: "From", value: "Ada <ada@analytical.io>" }, { name: "Subject", value: "Hi" }] } } };
      },
    };
    await expect(sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport })).rejects.toMatchObject({ code: "not_enabled" });
    expect(await db.select().from(actionProposals).where(eq(actionProposals.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, accountId))).toHaveLength(0);
  });

  it("the scheduler pass skips a paused account", async () => {
    const summary = await sync.syncAllGmailSenders({ async read() { throw new Error("must not read"); } });
    expect(summary.failed.filter((f) => f.externalAccountId === accountId)).toHaveLength(0);
  });
});
