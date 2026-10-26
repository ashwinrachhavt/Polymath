import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionProposals, actionRevisions } from "@/domains/actions/schema";
import { companies, contactCompanies, contacts, correspondence } from "@/domains/crm/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-287 against a scratch database:
 *  1. a new human sender becomes one pending proposal and writes no CRM row;
 *  2. automated senders, the owner's own address and existing contacts are skipped;
 *  3. a second email from the same sender resolves the same proposal;
 *  4. approval creates the contact, the company, the link and the thread record;
 *  5. a retried approval and a second sender at the same domain create no duplicates.
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let mod: typeof import("@/domains/crm/propose-from-senders");
let auth: ReturnType<typeof ownerAuth>;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  mod = await import("@/domains/crm/propose-from-senders");
  const ws = await seedWorkspace(db, "crm-senders");
  auth = ownerAuth(ws.userId, ws.workspaceId);
  await db.insert(contacts).values({ workspaceId: ws.workspaceId, fullName: "Known Person", primaryEmail: "Known@acme.com" });
});
afterAll(async () => {
  await handle?.client.end();
});

const msg = (id: string, from: string, thread = `t-${id}`) => ({ messageId: id, threadId: thread, from, subject: "Intro", date: "Mon, 26 Oct 2026 09:00:00 -0700" });

async function approve(proposalId: string) {
  const [p] = await db.select().from(actionProposals).where(eq(actionProposals.id, proposalId));
  const [r] = await db.select().from(actionRevisions).where(eq(actionRevisions.proposalId, proposalId));
  return mod.approveContactProposal(auth, { proposalId, expectedVersion: p.version, revisionId: r.id });
}

suite("crm sender proposals", () => {
  it("proposes new humans only and writes nothing until approved", async () => {
    const result = await mod.proposeContactsFromSenders(auth, {
      ownAddresses: ["me@mine.com"],
      messages: [
        msg("1", "Ada Lovelace <ada@analytical.io>"),
        msg("2", "noreply@analytical.io"),
        msg("3", "Me <me@mine.com>"),
        msg("4", "Known Person <known@acme.com>"),
        msg("5", "garbage"),
      ],
    });
    expect(result.proposed.map((p) => p.email)).toEqual(["ada@analytical.io"]);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(["already_in_crm", "automated", "own_address", "unparseable"]);
    const rows = await db.select().from(contacts).where(and(eq(contacts.workspaceId, auth.workspaceId), eq(contacts.fullName, "Ada Lovelace")));
    expect(rows).toHaveLength(0);
  });

  it("resolves the same proposal for a second email from the same sender", async () => {
    const again = await mod.proposeContactsFromSenders(auth, { ownAddresses: [], messages: [msg("6", "Ada Lovelace <ada@analytical.io>")] });
    expect(again.proposed[0].deduplicated).toBe(true);
  });

  it("approval creates contact, company, link and thread; retry and same-domain sender add no duplicates", async () => {
    const [pending] = await db.select().from(actionProposals).where(and(eq(actionProposals.workspaceId, auth.workspaceId), eq(actionProposals.dedupeKey, "crm-sender:ada@analytical.io")));
    const first = await approve(pending.id);
    expect(first.created).toBe(true);
    const retry = await approve(pending.id);
    expect(retry).toMatchObject({ contactId: first.contactId, companyId: first.companyId, created: false });

    const threads = await db.select().from(correspondence).where(eq(correspondence.contactId, first.contactId));
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ direction: "inbound", state: "received", threadId: "t-1" });
    const links = await db.select().from(contactCompanies).where(eq(contactCompanies.contactId, first.contactId));
    expect(links).toHaveLength(1);

    const second = await mod.proposeContactsFromSenders(auth, { ownAddresses: [], messages: [msg("7", "Charles <charles@analytical.io>")] });
    const [rev] = await db.select().from(actionRevisions).where(eq(actionRevisions.proposalId, second.proposed[0].proposalId));
    expect((rev.payload as { company: { existingId?: string } }).company.existingId).toBe(first.companyId);
    await approve(second.proposed[0].proposalId);
    const cos = await db.select().from(companies).where(and(eq(companies.workspaceId, auth.workspaceId), eq(companies.domain, "analytical.io")));
    expect(cos).toHaveLength(1);
  });
});
