import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contactCompanies, contactObservations, contacts, companies, followUps } from "@/domains/crm/schema";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * C01 dedupe controls: candidate detection is honest (case variants and
 * formatting doubles count), a merge re-points every child row and archives
 * the loser in one transaction, the kept record is claimed at the rendered
 * version, and nothing crosses a tenant boundary.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/crm/commands");
let dedupe: typeof import("@/domains/crm/dedupe");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/crm/commands");
  dedupe = await import("@/domains/crm/dedupe");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const seeded = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(seeded.userId, seeded.workspaceId);
}

suite("contact duplicates (C01)", () => {
  it("finds case-variant email doubles and same-name doubles, not distinct people", async () => {
    const auth = await seed("dedupe-find");
    const a = await commands.createContact(auth, { fullName: "Ada Lovelace", primaryEmail: "Ada@example.com" });
    const b = await commands.createContact(auth, { fullName: "Ada L", primaryEmail: "ada@example.com" });
    await commands.createContact(auth, { fullName: "Grace Hopper", primaryEmail: "grace@example.com" });
    const groups = await dedupe.findContactDuplicates(auth);
    const emailGroup = groups.find((group) => group.reason.startsWith("Same email"));
    expect(emailGroup?.rows.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());
    expect(groups.flatMap((group) => group.rows).map((row) => row.label)).not.toContain("Grace Hopper");
  });

  it("merge re-points observations and follow-ups, archives the loser, audits the winner", async () => {
    const auth = await seed("dedupe-merge");
    const keep = await commands.createContact(auth, { fullName: "Katherine Johnson", primaryEmail: "K@example.com" });
    const dupe = await commands.createContact(auth, { fullName: "K Johnson", primaryEmail: "k@example.com" });
    await commands.addObservation(auth, { contactId: dupe.id, body: "Met at the conference.", source: "observed" });
    const followUp = await commands.createFollowUp(auth, { contactId: dupe.id, note: "Send the notes." });

    const [targetRow] = await db.select().from(contacts).where(eq(contacts.id, keep.id));
    const result = await dedupe.mergeContacts(auth, {
      sourceId: dupe.id,
      targetId: keep.id,
      expectedTargetVersion: targetRow.version,
    });
    expect(result.into).toBe("Katherine Johnson");

    const [movedObservation] = await db.select().from(contactObservations).where(eq(contactObservations.workspaceId, auth.workspaceId));
    expect(movedObservation.contactId).toBe(keep.id);
    const [movedFollowUp] = await db.select().from(followUps).where(eq(followUps.id, followUp.id));
    expect(movedFollowUp.contactId).toBe(keep.id);

    const [loser] = await db.select().from(contacts).where(eq(contacts.id, dupe.id));
    expect(loser.archivedAt).not.toBeNull();
    const [winner] = await db.select().from(contacts).where(and(eq(contacts.id, keep.id), isNull(contacts.archivedAt)));
    expect(winner.version).toBe(targetRow.version + 1);

    const audits = await db.select().from(auditEvents).where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.action, "contact.merged")));
    expect(audits).toHaveLength(1);
    expect(audits[0].subjectId).toBe(keep.id);
  });

  it("a stale merge target version is refused and nothing moves", async () => {
    const auth = await seed("dedupe-stale");
    const keep = await commands.createContact(auth, { fullName: "Mary Jackson", primaryEmail: "m@example.com" });
    const dupe = await commands.createContact(auth, { fullName: "M Jackson", primaryEmail: "m2@example.com" });
    await commands.addObservation(auth, { contactId: dupe.id, body: "Still on the loser.", source: "stated" });
    await expect(
      dedupe.mergeContacts(auth, { sourceId: dupe.id, targetId: keep.id, expectedTargetVersion: 99 }),
    ).rejects.toThrow(/changed since you loaded it/);
    const [observation] = await db.select().from(contactObservations).where(eq(contactObservations.workspaceId, auth.workspaceId));
    expect(observation.contactId).toBe(dupe.id);
    const [loser] = await db.select().from(contacts).where(eq(contacts.id, dupe.id));
    expect(loser.archivedAt).toBeNull();
  });

  it("a record cannot merge into itself, nor across workspaces", async () => {
    const authA = await seed("dedupe-self-a");
    const authB = await seed("dedupe-self-b");
    const one = await commands.createContact(authA, { fullName: "Dorothy Vaughan", primaryEmail: "d@example.com" });
    const foreign = await commands.createContact(authB, { fullName: "Dorothy Vaughan", primaryEmail: "d@example.com" });
    await expect(
      dedupe.mergeContacts(authA, { sourceId: one.id, targetId: one.id, expectedTargetVersion: 1 }),
    ).rejects.toThrow(/itself/);
    await expect(
      dedupe.mergeContacts(authA, { sourceId: foreign.id, targetId: one.id, expectedTargetVersion: 1 }),
    ).rejects.toThrow(/not in this workspace/);
  });
});

suite("company duplicates (C01)", () => {
  it("finds same-domain doubles and merges membership links to the kept company", async () => {
    const auth = await seed("dedupe-company");
    const keep = await commands.createCompany(auth, { name: "Acme Corp", domain: "acme.com" });
    const dupe = await commands.createCompany(auth, { name: "Acme", domain: "ACME.com" });
    const person = await commands.createContact(auth, { fullName: "Paula Acme", companyId: dupe.id });

    const groups = await dedupe.findCompanyDuplicates(auth);
    expect(groups.some((group) => group.rows.map((row) => row.id).includes(dupe.id))).toBe(true);

    const [targetRow] = await db.select().from(companies).where(eq(companies.id, keep.id));
    await dedupe.mergeCompanies(auth, { sourceId: dupe.id, targetId: keep.id, expectedTargetVersion: targetRow.version });

    const links = await db.select().from(contactCompanies).where(eq(contactCompanies.contactId, person.id));
    expect(links).toHaveLength(1);
    expect(links[0].companyId).toBe(keep.id);
    const [loser] = await db.select().from(companies).where(eq(companies.id, dupe.id));
    expect(loser.archivedAt).not.toBeNull();
  });
});
