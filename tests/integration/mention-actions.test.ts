import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, contactCompanies, contactObservations, contacts, followUps } from "@/domains/crm/schema";
import { captures } from "@/domains/capture/schema";
import { contactPoints, organizations, people, partyEmployment } from "@/domains/identity/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The @-mention context action (fetchMentionContext). The model's copy of a
 * message may carry this block, so what it proves:
 *  1. malformed input is a null, never a throw (the composer degrades to a
 *     plain message);
 *  2. tenant scoping — a person or company id from another workspace resolves
 *     to null, so a mention can never import a foreign record's context
 *     (identity and CRM paths both);
 *  3. the context mapping filters open follow-ups only and caps observations
 *     at five, because the block rides on every message and bloat is cost;
 *  4. malformed input is a null and a viewer is refused — the block names CRM
 *     records, and membership is the floor (ASH-120);
 *  5. identity-domain ids (the picker's, from the LinkedIn CSV import)
 *     resolve with email, employer, and the CRM relationship status matched
 *     on the primary email.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
const authHolder: { ctx: { userId: string; workspaceId: string; role: "owner" | "member" | "viewer" } } = {
  ctx: { userId: "none", workspaceId: "none", role: "owner" },
};
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => authHolder.ctx) }));
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

import { fetchMentionContext } from "@/app/(workspace)/polymath/mention-actions";

beforeAll(async () => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

suite("fetchMentionContext", () => {
  it("returns null on malformed input and refuses a viewer", async () => {
    // Both are cheap guard paths the composer relies on: bad input degrades
    // to a plain message (never a thrown 500 under the send button), and a
    // viewer naming a CRM record gains nothing — membership is the floor.
    await expect(fetchMentionContext(null)).resolves.toBeNull();
    await expect(fetchMentionContext({ kind: "note", id: crypto.randomUUID() })).resolves.toBeNull();
    await expect(fetchMentionContext({ kind: "person", id: "not-a-uuid" })).resolves.toBeNull();
    const viewerWs = await seedWorkspace(holder.db!, `mention-viewer-${Date.now()}`);
    const [viewerContact] = await holder
      .db!.insert(contacts)
      .values({ workspaceId: viewerWs.workspaceId, fullName: "Dana Viewer" })
      .returning({ id: contacts.id });
    authHolder.ctx = { userId: viewerWs.userId, workspaceId: viewerWs.workspaceId, role: "viewer" };
    await expect(fetchMentionContext({ kind: "person", id: viewerContact.id })).rejects.toThrow(/Requires member/);
  });

  it("adds a bounded Inbox snapshot and a selected capture, scoped to the member workspace", async () => {
    const seed = await seedWorkspace(holder.db!, `mention-inbox-${Date.now()}`);
    const foreign = await seedWorkspace(holder.db!, `mention-inbox-foreign-${Date.now()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "member" };
    const [capture] = await holder
      .db!.insert(captures)
      .values({
        workspaceId: seed.workspaceId,
        kind: "text",
        captureMode: "authored",
        rawPayload: { text: "The latest Inbox capture should reach chat." },
        text: "The latest Inbox capture should reach chat.",
        createdBy: seed.userId,
        updatedBy: seed.userId,
      })
      .returning({ id: captures.id });

    await expect(fetchMentionContext({ kind: "capture", id: capture.id })).resolves.toMatchObject({
      capture: {
        id: capture.id,
        title: "The latest Inbox capture should reach chat.",
        text: "The latest Inbox capture should reach chat.",
      },
    });
    await expect(fetchMentionContext({ kind: "inbox", id: seed.workspaceId })).resolves.toMatchObject({
      total: 1,
      items: [{ id: capture.id, text: "The latest Inbox capture should reach chat." }],
    });
    await expect(fetchMentionContext({ kind: "inbox", id: foreign.workspaceId })).resolves.toBeNull();
    const [foreignCapture] = await holder
      .db!.insert(captures)
      .values({
        workspaceId: foreign.workspaceId,
        kind: "text",
        captureMode: "authored",
        rawPayload: { text: "Private capture" },
        text: "Private capture",
        createdBy: foreign.userId,
        updatedBy: foreign.userId,
      })
      .returning({ id: captures.id });
    await expect(fetchMentionContext({ kind: "capture", id: foreignCapture.id })).resolves.toBeNull();
  });

  it("maps a person to its context: open follow-ups only, observations capped at five", async () => {
    const seed = await seedWorkspace(holder.db!, `mention-person-${Date.now()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "member" };
    const [contact] = await holder
      .db!.insert(contacts)
      .values({
        workspaceId: seed.workspaceId,
        fullName: "Dana Mention",
        primaryEmail: "dana@axiom.test",
        title: "Ops lead",
      })
      .returning({ id: contacts.id });
    for (let i = 0; i < 7; i++) {
      await holder.db!.insert(contactObservations).values({
        workspaceId: seed.workspaceId,
        contactId: contact.id,
        body: `observation ${i}`,
        source: "stated",
      });
    }
    await holder.db!.insert(followUps).values([
      { workspaceId: seed.workspaceId, contactId: contact.id, note: "still open", status: "open" },
      { workspaceId: seed.workspaceId, contactId: contact.id, note: "already done", status: "done" },
    ]);

    const context = await fetchMentionContext({ kind: "person", id: contact.id });
    expect(context).toMatchObject({ name: "Dana Mention", email: "dana@axiom.test", title: "Ops lead" });
    expect(context!.recentObservations).toHaveLength(5);
    expect(context!.openFollowUps).toHaveLength(1);
    expect((context!.openFollowUps as Array<Record<string, unknown>>)[0]).toMatchObject({ note: "still open" });
  });

  it("maps a company to its people and refuses another workspace's ids", async () => {
    const a = await seedWorkspace(holder.db!, `mention-company-${Date.now()}`);
    const b = await seedWorkspace(holder.db!, `mention-foreign-${Date.now()}`);
    authHolder.ctx = { userId: a.userId, workspaceId: a.workspaceId, role: "member" };
    const [company] = await holder
      .db!.insert(companies)
      .values({ workspaceId: a.workspaceId, name: "Mention Co" })
      .returning({ id: companies.id });
    await holder
      .db!.insert(contacts)
      .values({ workspaceId: a.workspaceId, fullName: "Ada Link", title: "CEO" })
      .returning({ id: contacts.id });
    const [linkRow] = await holder.db!.select().from(contacts).where(eq(contacts.fullName, "Ada Link"));
    await holder.db!.insert(contactCompanies).values({
      workspaceId: a.workspaceId,
      contactId: linkRow.id,
      companyId: company.id,
      isCurrent: true,
    });
    // Another workspace's company, for the scoping claim.
    const [foreign] = await holder
      .db!.insert(companies)
      .values({ workspaceId: b.workspaceId, name: "Foreign Co" })
      .returning({ id: companies.id });

    const context = await fetchMentionContext({ kind: "company", id: company.id });
    expect(context).toMatchObject({ name: "Mention Co" });
    expect(context!.people).toHaveLength(1);
    expect((context!.people as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "Ada Link", isCurrent: true });

    // The foreign id shares the connection but not the tenant: null, and the
    // caller's message just goes without context.
    await expect(fetchMentionContext({ kind: "company", id: foreign.id })).resolves.toBeNull();
    await expect(fetchMentionContext({ kind: "person", id: foreign.id })).resolves.toBeNull();
  });

  it("resolves an identity person: email, current employer, and the CRM status matched on the email", async () => {
    // The picker hands identity ids (the LinkedIn CSV import's tables), so
    // this path is what a real mention takes. The relationship pill rides on
    // the CRM contact whose primary email matches, the same seam the People
    // table uses.
    const seed = await seedWorkspace(holder.db!, `mention-identity-person-${Date.now()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "member" };
    const [person] = await holder
      .db!.insert(people)
      .values({ workspaceId: seed.workspaceId, displayName: "Ada Identity", title: "Ops lead", createdBy: seed.userId })
      .returning({ id: people.id });
    await holder.db!.insert(contactPoints).values({
      workspaceId: seed.workspaceId,
      kind: "email",
      value: "ada-identity@axiom.test",
      isPrimary: true,
      personId: person.id,
      createdBy: seed.userId,
    });
    const [org] = await holder
      .db!.insert(organizations)
      .values({ workspaceId: seed.workspaceId, name: "Identity Co", createdBy: seed.userId })
      .returning({ id: organizations.id });
    await holder.db!.insert(partyEmployment).values({
      workspaceId: seed.workspaceId,
      personId: person.id,
      organizationId: org.id,
      title: "Ops lead",
      createdBy: seed.userId,
    });
    await holder.db!.insert(contacts).values({
      workspaceId: seed.workspaceId,
      fullName: "Ada Identity (crm)",
      primaryEmail: "ada-identity@axiom.test",
      relationshipStatus: "warm",
    });

    const context = await fetchMentionContext({ kind: "person", id: person.id });
    expect(context).toMatchObject({
      name: "Ada Identity",
      email: "ada-identity@axiom.test",
      title: "Ops lead",
      relationshipStatus: "warm",
    });
    expect(context!.companies).toHaveLength(1);
    expect((context!.companies as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "Identity Co",
      isCurrent: true,
    });
  });

  it("resolves an identity organization with its people", async () => {
    const seed = await seedWorkspace(holder.db!, `mention-identity-org-${Date.now()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "member" };
    const [org] = await holder
      .db!.insert(organizations)
      .values({
        workspaceId: seed.workspaceId,
        name: "Identity Org",
        domain: "identityorg.test",
        createdBy: seed.userId,
      })
      .returning({ id: organizations.id });
    const [person] = await holder
      .db!.insert(people)
      .values({ workspaceId: seed.workspaceId, displayName: "Rin Org", createdBy: seed.userId })
      .returning({ id: people.id });
    await holder.db!.insert(partyEmployment).values({
      workspaceId: seed.workspaceId,
      personId: person.id,
      organizationId: org.id,
      createdBy: seed.userId,
    });

    const context = await fetchMentionContext({ kind: "company", id: org.id });
    expect(context).toMatchObject({ name: "Identity Org", domain: "identityorg.test" });
    expect(context!.people).toHaveLength(1);
    expect((context!.people as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "Rin Org", isCurrent: true });

    // A foreign workspace's organization id resolves to null, same scoping
    // claim as the CRM path above.
    const foreign = await seedWorkspace(holder.db!, `mention-identity-foreign-${Date.now()}`);
    const [foreignOrg] = await holder
      .db!.insert(organizations)
      .values({ workspaceId: foreign.workspaceId, name: "Foreign Org", createdBy: foreign.userId })
      .returning({ id: organizations.id });
    await expect(fetchMentionContext({ kind: "company", id: foreignOrg.id })).resolves.toBeNull();
  });
});
