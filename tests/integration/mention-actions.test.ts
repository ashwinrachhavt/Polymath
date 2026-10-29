import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, contactCompanies, contactObservations, contacts, followUps } from "@/domains/crm/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The @-mention context action (fetchMentionContext). The model's copy of a
 * message may carry this block, so what it proves:
 *  1. malformed input is a null, never a throw (the composer degrades to a
 *     plain message);
 *  2. tenant scoping — a person or company id from another workspace resolves
 *     to null, so a mention can never import a foreign record's context;
 *  3. the context mapping filters open follow-ups only and caps observations
 *     at five, because the block rides on every message and bloat is cost;
 *  4. malformed input is a null and a viewer is refused — the block names CRM
 *     records, and membership is the floor (ASH-120).
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
const authHolder: { ctx: { userId: string; workspaceId: string; role: "owner" | "member" | "viewer" } } = {
  ctx: { userId: "none", workspaceId: "none", role: "owner" },
};
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => authHolder.ctx) }));
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

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
    const [viewerContact] = await holder.db!
      .insert(contacts)
      .values({ workspaceId: viewerWs.workspaceId, fullName: "Dana Viewer" })
      .returning({ id: contacts.id });
    authHolder.ctx = { userId: viewerWs.userId, workspaceId: viewerWs.workspaceId, role: "viewer" };
    await expect(fetchMentionContext({ kind: "person", id: viewerContact.id })).rejects.toThrow(/Requires member/);
  });

  it("maps a person to its context: open follow-ups only, observations capped at five", async () => {
    const seed = await seedWorkspace(holder.db!, `mention-person-${Date.now()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "member" };
    const [contact] = await holder.db!
      .insert(contacts)
      .values({ workspaceId: seed.workspaceId, fullName: "Dana Mention", primaryEmail: "dana@axiom.test", title: "Ops lead" })
      .returning({ id: contacts.id });
    for (let i = 0; i < 7; i++) {
      await holder.db!.insert(contactObservations).values({
        workspaceId: seed.workspaceId, contactId: contact.id, body: `observation ${i}`, source: "stated",
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
    const [company] = await holder.db!
      .insert(companies)
      .values({ workspaceId: a.workspaceId, name: "Mention Co" })
      .returning({ id: companies.id });
    await holder.db!
      .insert(contacts)
      .values({ workspaceId: a.workspaceId, fullName: "Ada Link", title: "CEO" })
      .returning({ id: contacts.id });
    const [linkRow] = await holder.db!.select().from(contacts).where(eq(contacts.fullName, "Ada Link"));
    await holder.db!.insert(contactCompanies).values({
      workspaceId: a.workspaceId, contactId: linkRow.id, companyId: company.id, isCurrent: true,
    });
    // Another workspace's company, for the scoping claim.
    const [foreign] = await holder.db!
      .insert(companies)
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
});
