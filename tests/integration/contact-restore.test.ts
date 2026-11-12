import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Restore is the undo behind "Archive contact". It brings the row back into
 * the list, stays inside its workspace, refuses a row that is not archived,
 * and writes its audit row in the same commit. An archived contact keeps its
 * email reserved, so a restore can never land on top of a live duplicate.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
// Imported in beforeAll: commands.ts reads DATABASE_URL at import, after makeTestDb sets it.
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

suite("contact restore", () => {
  it("archive then restore brings the contact back into the list", async () => {
    const auth = await seed("restore-basic");
    const contact = await commands.createContact(auth, {
      fullName: "Grace Hopper",
      primaryEmail: "grace@navy.example",
    });
    await commands.archiveContact(auth, { contactId: contact.id, expectedVersion: contact.version });
    expect((await queries.listContacts(auth, {})).total).toBe(0);

    await commands.restoreContact(auth, { contactId: contact.id });

    const list = await queries.listContacts(auth, {});
    expect(list.items.map((item) => item.fullName)).toEqual(["Grace Hopper"]);
    const detail = await queries.getContactDetail(auth, { contactId: contact.id });
    expect(detail?.contact.version).toBe(contact.version + 2);

    // Restoring a live contact finds nothing to restore.
    await expect(commands.restoreContact(auth, { contactId: contact.id })).rejects.toBeInstanceOf(
      commands.NotFoundError,
    );
  });

  it("refuses a restore from another workspace", async () => {
    const owner = await seed("restore-owner");
    const other = await seed("restore-other");
    const contact = await commands.createContact(owner, { fullName: "Tenant Bound" });
    await commands.archiveContact(owner, { contactId: contact.id, expectedVersion: contact.version });

    await expect(commands.restoreContact(other, { contactId: contact.id })).rejects.toBeInstanceOf(
      commands.NotFoundError,
    );
    expect((await queries.listContacts(owner, {})).total).toBe(0);
    expect((await queries.listContacts(other, {})).total).toBe(0);
  });

  it("keeps an archived contact's email reserved, so a restore cannot collide with a live one", async () => {
    const auth = await seed("restore-email");
    const contact = await commands.createContact(auth, { fullName: "Original", primaryEmail: "shared@example.com" });
    await commands.archiveContact(auth, { contactId: contact.id, expectedVersion: contact.version });

    // The live duplicate a restore would collide with cannot be created while the email is reserved.
    await expect(
      commands.createContact(auth, { fullName: "Newcomer", primaryEmail: "shared@example.com" }),
    ).rejects.toBeInstanceOf(commands.ConflictError);

    await commands.restoreContact(auth, { contactId: contact.id });
    const list = await queries.listContacts(auth, {});
    expect(list.items.map((item) => item.fullName)).toEqual(["Original"]);
  });

  it("writes the contact.restored audit row", async () => {
    const auth = await seed("restore-audit");
    const contact = await commands.createContact(auth, { fullName: "Audited" });
    await commands.archiveContact(auth, { contactId: contact.id, expectedVersion: contact.version });
    await commands.restoreContact(auth, { contactId: contact.id });

    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.action, "contact.restored")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectType: "contact", subjectId: contact.id });
  });
});
