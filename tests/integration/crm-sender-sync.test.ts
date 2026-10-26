import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionProposals } from "@/domains/actions/schema";
import { externalAccounts, syncCursors, triggers } from "@/domains/integrations/schema";
import type { Transport } from "@/domains/integrations/transport";
import { fixtureTransport } from "../helpers/fixture-transport";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-287 arrival pass against a scratch database, with recorded Gmail
 * responses instead of the network:
 *  1. refuses until the owner opted the account in (no trigger, no read);
 *  2. refuses when read access is switched off on the account;
 *  3. an opted-in pass proposes new human senders, skips the mailbox owner and
 *     automated senders, sends the exclusion query, and advances the watermark;
 *  4. a provider failure keeps the watermark and records the error.
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let sync: typeof import("@/domains/crm/sender-sync");
let workspaceId: string;
let accountId: string;

/*
 * A tiny mailbox behind the Transport: evaluates Gmail's after:/before: on
 * internal date, returns newest-first and honours maxResults, like the real
 * search the sync relies on. The Date header is deliberately wrong (sender
 * controlled) so a pass that windows on it would skip mail.
 */
type Mail = { id: string; from: string; internalSec: number };
function mailbox(mails: Mail[], opts: { failAfterCalls?: number } = {}): { transport: Transport; queries: string[] } {
  const queries: string[] = [];
  let calls = 0;
  const transport: Transport = {
    async read(request) {
      calls += 1;
      if (opts.failAfterCalls !== undefined && calls > opts.failAfterCalls) return { ok: false, code: "provider_error", status: 500, message: "boom" };
      const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
      if (request.endpoint === base) {
        const q = request.query?.q ?? "";
        queries.push(q);
        const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
        const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Number.MAX_SAFE_INTEGER);
        const hits = mails.filter((m) => m.internalSec > after && m.internalSec < before).sort((x, y) => y.internalSec - x.internalSec).slice(0, Number(request.query?.maxResults));
        return { ok: true, status: 200, data: { messages: hits.map((m) => ({ id: m.id, threadId: `th-${m.id}` })) } };
      }
      const mail = mails.find((m) => request.endpoint === `${base}/${m.id}`);
      if (!mail) throw new Error(`no mail for ${request.endpoint}`);
      return {
        ok: true,
        status: 200,
        data: { id: mail.id, threadId: `th-${mail.id}`, internalDate: String(mail.internalSec * 1000), payload: { headers: [{ name: "From", value: mail.from }, { name: "Subject", value: "Hi" }, { name: "Date", value: "Mon, 01 Jan 2001 00:00:00 +0000" }] } },
      };
    },
  };
  return { transport, queries };
}

const NOW = new Date("2026-10-26T17:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);
const human = (n: number, sec: number): Mail => ({ id: `m${n}`, from: `Person ${n} <p${n}@co${n}.io>`, internalSec: sec });

async function proposedEmails(): Promise<string[]> {
  const rows = await db.select().from(actionProposals).where(and(eq(actionProposals.workspaceId, workspaceId), eq(actionProposals.capability, "crm.contact.create")));
  return rows.map((r) => r.dedupeKey.replace("crm-sender:", "")).sort();
}
// Mirrors the enable moment: the real switch writes this cursor when it is turned on.
const ENABLE_WATERMARK = nowSec - 7 * 86400;
async function resetCursor() {
  await db.delete(syncCursors).where(eq(syncCursors.externalAccountId, accountId));
  await db.insert(syncCursors).values({ workspaceId, externalAccountId: accountId, resource: "sender-proposals", cursor: JSON.stringify({ watermark: ENABLE_WATERMARK, pending: [] }), state: "idle" });
  await db.delete(actionProposals).where(eq(actionProposals.workspaceId, workspaceId));
}

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  sync = await import("@/domains/crm/sender-sync");
  ({ workspaceId } = await seedWorkspace(db, "crm-sync"));
  const [acct] = await db
    .insert(externalAccounts)
    .values({ workspaceId, provider: "gmail", alias: "work", composioConnectedAccountId: "ca_test", providerAccountId: "owner@mine.com", status: "active", accessTier: "read_only" })
    .returning();
  accountId = acct.id;
});
afterAll(async () => {
  await handle?.client.end();
});

suite("crm sender sync", () => {
  it("fails closed when an enabled account has no readable watermark instead of scanning earlier mail", async () => {
    await db.delete(syncCursors).where(eq(syncCursors.externalAccountId, accountId));
    await db.insert(triggers).values({ workspaceId, externalAccountId: accountId, provider: "gmail", eventType: sync.SENDER_PROPOSALS_EVENT, status: "enabled" }).onConflictDoNothing();
    const { transport, queries } = mailbox([{ id: "a", from: "Ada <ada@analytical.io>", internalSec: nowSec - 100 }]);
    await expect(sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport, now: NOW })).rejects.toMatchObject({ code: "cursor_lost" });
    expect(queries).toHaveLength(0);
  });

  it("refuses until the owner opts the account in", async () => {
    await expect(sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport: fixtureTransport([]) })).rejects.toMatchObject({ code: "not_enabled" });
  });

  it("refuses when read is off on the account", async () => {
    await db.insert(triggers).values({ workspaceId, externalAccountId: accountId, provider: "gmail", eventType: sync.SENDER_PROPOSALS_EVENT, status: "enabled" });
    await db.update(externalAccounts).set({ allowRead: false }).where(eq(externalAccounts.id, accountId));
    await expect(sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport: fixtureTransport([]) })).rejects.toMatchObject({ code: "read_not_allowed" });
    await db.update(externalAccounts).set({ allowRead: true }).where(eq(externalAccounts.id, accountId));
  });

  it("skips the mailbox owner and automated senders, and queries Gmail with the exclusions", async () => {
    await resetCursor();
    const { transport, queries } = mailbox([
      { id: "a", from: "Ada <ada@analytical.io>", internalSec: nowSec - 100 },
      { id: "b", from: "Owner <owner@mine.com>", internalSec: nowSec - 200 },
      { id: "c", from: "noreply@analytical.io", internalSec: nowSec - 300 },
    ]);
    const result = await sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport, now: NOW });
    expect(result.proposed.map((p) => p.email)).toEqual(["ada@analytical.io"]);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(["automated", "own_address"]);
    expect(queries[0]).toContain("-category:promotions");
    expect(queries[0]).toContain(`after:${nowSec - 7 * 86400}`);
    const [cursor] = await db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, accountId));
    expect(cursor.state).toBe("idle");
    expect(JSON.parse(cursor.cursor!)).toEqual({ watermark: nowSec - 120, pending: [] });
  });

  it("a burst larger than one page is read in full, with no skipped mail", async () => {
    await resetCursor();
    await db.update(triggers).set({ budget: { perRun: 10 } }).where(eq(triggers.externalAccountId, accountId));
    const mails = Array.from({ length: 95 }, (_, n) => human(n, nowSec - 1000 + n * 5));
    const { transport } = mailbox(mails);
    const result = await sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport, now: NOW });
    expect(result.complete).toBe(true);
    expect(await proposedEmails()).toHaveLength(95);
  });

  it("over the per-pass budget the rest is carried, and the next pass finishes it", async () => {
    await resetCursor();
    await db.update(triggers).set({ budget: { perRun: 50 } }).where(eq(triggers.externalAccountId, accountId));
    const mails = Array.from({ length: 260 }, (_, n) => human(n, nowSec - 5000 + n * 10));
    const first = await sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport: mailbox(mails).transport, now: NOW });
    expect(first.complete).toBe(false);
    const [mid] = await db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, accountId));
    expect(mid.state).toBe("partial");
    expect(JSON.parse(mid.cursor!).pending.length).toBeGreaterThan(0);
    expect((await proposedEmails()).length).toBeLessThan(260);
    const later = new Date(NOW.getTime() + 3600_000);
    const second = await sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport: mailbox(mails).transport, now: later });
    expect(second.complete).toBe(true);
    expect(await proposedEmails()).toHaveLength(260);
  });

  it("fails closed when one second holds more mail than a page", async () => {
    await resetCursor();
    await db.update(triggers).set({ budget: { perRun: 5 } }).where(eq(triggers.externalAccountId, accountId));
    const mails = Array.from({ length: 12 }, (_, n) => human(n, nowSec - 500));
    await expect(sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport: mailbox(mails).transport, now: NOW })).rejects.toThrow(/single second/);
    const [cursor] = await db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, accountId));
    expect(cursor.state).toBe("failed");
  });

  it("a provider failure mid-pass keeps the watermark and pending windows unchanged", async () => {
    await resetCursor();
    await db.update(triggers).set({ budget: { perRun: 5 } }).where(eq(triggers.externalAccountId, accountId));
    const mails = Array.from({ length: 30 }, (_, n) => human(n, nowSec - 900 + n * 10));
    await expect(sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport: mailbox(mails, { failAfterCalls: 8 }).transport, now: NOW })).rejects.toThrow(/boom/);
    const [cursor] = await db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, accountId));
    expect(cursor.state).toBe("failed");
    expect(JSON.parse(cursor.cursor ?? "{}")).toEqual({ watermark: ENABLE_WATERMARK, pending: [] });
    // Recovery: the same window is read again from scratch and completes.
    const ok = await sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport: mailbox(mails).transport, now: NOW });
    expect(ok.complete).toBe(true);
    expect(await proposedEmails()).toHaveLength(30);
  });
});
