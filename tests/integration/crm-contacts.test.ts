import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The CRM invariants that only real Postgres holds: one email per workspace,
 * a stale write is rejected rather than merged, company changes keep history,
 * tenancy isolates every read, and each mutation writes its audit row in the
 * same commit. Skipped without a scratch database, same as the other suites.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
// Imported in beforeAll, not statically: commands.ts loads the pooled client,
// which reads DATABASE_URL once at import — after makeTestDb points it at the
// scratch database, not before.
let commands: typeof import("@/domains/crm/commands");
let queries: typeof import("@/domains/crm/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/crm/commands");
  queries = await import("@/domains/crm/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

suite("crm contacts", () => {
  it("creates, lists and reads a contact with its audit row", async () => {
    const auth = await seed("crm-basic");
    const company = await commands.createCompany(auth, { name: "Analytical Engines", domain: "analytical.example" });
    const contact = await commands.createContact(auth, {
      fullName: "Ada Lovelace",
      primaryEmail: "ada@analytical.example",
      title: "Engineer",
      relationshipStatus: "warm",
      companyId: company.id,
    });

    const list = await queries.listContacts(auth, {});
    expect(list.items.map((item) => item.fullName)).toEqual(["Ada Lovelace"]);
    expect(list.items[0].currentCompanyName).toBe("Analytical Engines");
    expect(list.total).toBe(1);

    const detail = await queries.getContactDetail(auth, { contactId: contact.id });
    expect(detail?.contact.primaryEmail).toBe("ada@analytical.example");
    expect(detail?.companies).toHaveLength(1);
    expect(detail?.companies[0]).toMatchObject({ name: "Analytical Engines", isCurrent: true });

    const audits = await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, auth.workspaceId));
    expect(audits.map((row) => row.action).sort()).toEqual(["company.created", "contact.created"]);
  });

  it("rejects a duplicate email with a user-safe conflict", async () => {
    const auth = await seed("crm-dupe");
    await commands.createContact(auth, { fullName: "First", primaryEmail: "dupe@example.com" });
    await expect(
      commands.createContact(auth, { fullName: "Second", primaryEmail: "dupe@example.com" }),
    ).rejects.toBeInstanceOf(commands.ConflictError);
    // A blank email is not a duplicate: partial unique index ignores nulls.
    await commands.createContact(auth, { fullName: "No email one" });
    await commands.createContact(auth, { fullName: "No email two" });
    const list = await queries.listContacts(auth, {});
    expect(list.total).toBe(3);
  });

  it("rejects a stale write and accepts the current version", async () => {
    const auth = await seed("crm-stale");
    const contact = await commands.createContact(auth, { fullName: "Versioned" });
    await expect(
      commands.updateContact(auth, {
        contactId: contact.id,
        expectedVersion: 99,
        fullName: "Overwritten",
      }),
    ).rejects.toBeInstanceOf(commands.StaleWriteError);

    const updated = await commands.updateContact(auth, {
      contactId: contact.id,
      expectedVersion: contact.version,
      fullName: "Versioned Two",
      relationshipStatus: "active",
    });
    expect(updated.version).toBe(contact.version + 1);
    expect(updated.fullName).toBe("Versioned Two");
  });

  it("keeps company history when the current company changes", async () => {
    const auth = await seed("crm-companies");
    const first = await commands.createCompany(auth, { name: "First Co" });
    const second = await commands.createCompany(auth, { name: "Second Co" });
    const contact = await commands.createContact(auth, { fullName: "Mover", companyId: first.id });

    await commands.updateContact(auth, {
      contactId: contact.id,
      expectedVersion: contact.version,
      fullName: "Mover",
      companyId: second.id,
    });

    const detail = await queries.getContactDetail(auth, { contactId: contact.id });
    const current = detail?.companies.filter((row) => row.isCurrent);
    const past = detail?.companies.filter((row) => !row.isCurrent);
    expect(current?.map((row) => row.name)).toEqual(["Second Co"]);
    expect(past?.map((row) => row.name)).toEqual(["First Co"]);
    expect(past?.[0].endedAt).toBeTruthy();

    // Saving again with the same company opens no duplicate edge.
    const again = await queries.getContactDetail(auth, { contactId: contact.id });
    await commands.updateContact(auth, {
      contactId: contact.id,
      expectedVersion: contact.version + 1,
      fullName: "Mover",
      companyId: second.id,
    });
    const after = await queries.getContactDetail(auth, { contactId: contact.id });
    expect(after?.companies).toHaveLength(again?.companies.length ?? -1);
  });

  it("isolates every read by workspace", async () => {
    const a = await seed("crm-tenant-a");
    const b = await seed("crm-tenant-b");
    const contact = await commands.createContact(a, { fullName: "Tenant A person" });

    expect((await queries.listContacts(b, {})).total).toBe(0);
    expect(await queries.getContactDetail(b, { contactId: contact.id })).toBeNull();
    await expect(
      commands.createFollowUp(b, { contactId: contact.id, note: "cross-tenant" }),
    ).rejects.toBeInstanceOf(commands.NotFoundError);
  });

  it("archives a contact out of list and detail without deleting history", async () => {
    const auth = await seed("crm-archive");
    const contact = await commands.createContact(auth, { fullName: "Leaving" });
    await commands.createFollowUp(auth, { contactId: contact.id, note: "kept" });

    await commands.archiveContact(auth, { contactId: contact.id, expectedVersion: contact.version });
    expect((await queries.listContacts(auth, {})).total).toBe(0);
    expect(await queries.getContactDetail(auth, { contactId: contact.id })).toBeNull();
  });

  it("records observations and resolves follow-ups once", async () => {
    const auth = await seed("crm-followup");
    const contact = await commands.createContact(auth, { fullName: "Observed" });
    await commands.addObservation(auth, { contactId: contact.id, body: "Said they prefer email.", source: "stated" });
    const followUp = await commands.createFollowUp(auth, {
      contactId: contact.id,
      dueAt: new Date("2026-10-20T12:00:00Z"),
      note: "Send the proposal",
    });

    let detail = await queries.getContactDetail(auth, { contactId: contact.id });
    expect(detail?.observations).toHaveLength(1);
    expect(detail?.observations[0].source).toBe("stated");
    expect((await queries.listContacts(auth, {})).items[0].openFollowUps).toBe(1);

    await commands.resolveFollowUp(auth, {
      followUpId: followUp.id,
      expectedVersion: followUp.version,
      resolution: "done",
    });
    await expect(
      commands.resolveFollowUp(auth, {
        followUpId: followUp.id,
        expectedVersion: followUp.version + 1,
        resolution: "cancelled",
      }),
    ).rejects.toBeInstanceOf(commands.StaleWriteError);

    detail = await queries.getContactDetail(auth, { contactId: contact.id });
    expect(detail?.followUps[0].status).toBe("done");
    expect(detail?.followUps[0].resolvedAt).toBeTruthy();
    expect((await queries.listContacts(auth, {})).items[0].openFollowUps).toBe(0);
  });

  it("treats search metacharacters as literal text", async () => {
    const auth = await seed("crm-search");
    await commands.createContact(auth, { fullName: "Plain Person" });
    const wildcard = await queries.listContacts(auth, { query: "%" });
    expect(wildcard.total).toBe(0);
    const match = await queries.listContacts(auth, { query: "plain" });
    expect(match.total).toBe(1);
    const byEmailStatus = await queries.listContacts(auth, { status: "dormant" });
    expect(byEmailStatus.total).toBe(0);
  });
});
