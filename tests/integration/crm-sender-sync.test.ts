import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionProposals } from "@/domains/actions/schema";
import { externalAccounts, syncCursors, triggers } from "@/domains/integrations/schema";
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

const header = (name: string, value: string) => ({ name, value });
const detail = (id: string, from: string) => ({ id, threadId: `th-${id}`, snippet: "hi", payload: { headers: [header("From", from), header("Subject", "Hello"), header("Date", "Mon, 26 Oct 2026 09:00:00 -0700")] } });

const routes = [
  { method: "GET" as const, endpointPrefix: "https://gmail.googleapis.com/gmail/v1/users/me/messages/a", status: 200, body: detail("a", "Ada Lovelace <ada@analytical.io>") },
  { method: "GET" as const, endpointPrefix: "https://gmail.googleapis.com/gmail/v1/users/me/messages/b", status: 200, body: detail("b", "Owner <owner@mine.com>") },
  { method: "GET" as const, endpointPrefix: "https://gmail.googleapis.com/gmail/v1/users/me/messages/c", status: 200, body: detail("c", "noreply@analytical.io") },
  { method: "GET" as const, endpointPrefix: "https://gmail.googleapis.com/gmail/v1/users/me/messages", status: 200, body: { messages: [{ id: "a", threadId: "th-a" }, { id: "b", threadId: "th-b" }, { id: "c", threadId: "th-c" }] } },
];

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
  it("refuses until the owner opts the account in", async () => {
    await expect(sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport: fixtureTransport([]) })).rejects.toMatchObject({ code: "not_enabled" });
  });

  it("refuses when read is off on the account", async () => {
    await db.insert(triggers).values({ workspaceId, externalAccountId: accountId, provider: "gmail", eventType: sync.SENDER_PROPOSALS_EVENT, status: "enabled" });
    await db.update(externalAccounts).set({ allowRead: false }).where(eq(externalAccounts.id, accountId));
    await expect(sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport: fixtureTransport([]) })).rejects.toMatchObject({ code: "read_not_allowed" });
    await db.update(externalAccounts).set({ allowRead: true }).where(eq(externalAccounts.id, accountId));
  });

  it("proposes only new human senders and advances the watermark", async () => {
    const seen: Array<{ endpoint: string; query?: Record<string, string> }> = [];
    const now = new Date("2026-10-26T17:00:00Z");
    const result = await sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport: fixtureTransport(routes, seen as never), now });
    expect(result.proposed.map((p) => p.email)).toEqual(["ada@analytical.io"]);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(["automated", "own_address"]);
    expect(seen[0].query?.q).toContain("-category:promotions");
    expect(seen[0].query?.q).toContain(`after:${Math.floor(now.getTime() / 1000) - 7 * 86400}`);
    const [cursor] = await db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, accountId));
    expect(cursor).toMatchObject({ cursor: String(Math.floor(now.getTime() / 1000)), state: "idle" });
    const [row] = await db.select().from(actionProposals).where(and(eq(actionProposals.workspaceId, workspaceId), eq(actionProposals.capability, "crm.contact.create")));
    expect(row.status).toBe("pending");
  });

  it("keeps the watermark when the provider fails", async () => {
    const before = (await db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, accountId)))[0].cursor;
    await expect(
      sync.syncGmailSenders(workspaceId, { externalAccountId: accountId, transport: fixtureTransport([{ method: "GET", endpointPrefix: "https://gmail.googleapis.com/", status: 500, body: {} }]) }),
    ).rejects.toThrow();
    const [cursor] = await db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, accountId));
    expect(cursor.cursor).toBe(before);
    expect(cursor.state).toBe("failed");
  });
});
