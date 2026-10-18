import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountPersonLinks,
  contactPoints,
  externalIdentities,
  organizations,
  partyRelationships,
  people,
} from "@/domains/identity/schema";
import { users, workspaces } from "@/domains/identity/schema";

/*
 * ASH-120 F02 invariants: one person serves every role without duplicate
 * rows, unverified email equality links nothing, and a composite FK makes a
 * cross-tenant endpoint impossible.
 *
 * These are database invariants, so they run against real Postgres (the
 * reliability.test.ts harness) and skip without TEST_DATABASE_URL. Unlike that
 * suite this one does not truncate: every test seeds its own workspace with a
 * random slug, so leftovers from previous runs collide on nothing.
 */

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;

beforeAll(() => {
  if (!url) return;
  client = postgres(url, { max: 1 });
  db = drizzle(client);
});

afterAll(async () => {
  await client?.end();
});

async function seedWorkspace() {
  const slug = `ash120-${crypto.randomUUID()}`;
  const [user] = await db.insert(users).values({ clerkUserId: `clerk_${slug}` }).returning();
  const [workspace] = await db
    .insert(workspaces)
    .values({ name: slug, slug, createdBy: user.id })
    .returning();
  return { user, workspace };
}

suite("canonical party model", () => {
  it("one person is contact, customer, account holder, and billing contact without duplicate rows", async () => {
    const { user, workspace } = await seedWorkspace();
    const [person] = await db
      .insert(people)
      .values({ workspaceId: workspace.id, displayName: "Ada Lovelace" })
      .returning();

    // Contact: an email contact point.
    await db.insert(contactPoints).values({
      workspaceId: workspace.id,
      personId: person.id,
      kind: "email",
      value: "ada@example.com",
      isPrimary: true,
    });
    // Customer: a party relationship edge.
    await db.insert(partyRelationships).values({
      workspaceId: workspace.id,
      personId: person.id,
      kind: "customer",
    });
    // Account holder: a verified provider identity, linked explicitly.
    await db.insert(externalIdentities).values({
      workspaceId: workspace.id,
      provider: "clerk",
      providerAccountId: `user_${crypto.randomUUID()}`,
      email: "ada@example.com",
      verified: true,
      accountId: user.id,
      createdBy: user.id,
    });
    await db.insert(accountPersonLinks).values({
      workspaceId: workspace.id,
      accountId: user.id,
      personId: person.id,
      method: "verified",
      createdBy: user.id,
    });
    // Billing contact: a second contact point, not primary.
    await db.insert(contactPoints).values({
      workspaceId: workspace.id,
      personId: person.id,
      kind: "email",
      value: "billing@example.com",
      label: "billing",
    });

    const rows = await db.select().from(people).where(eq(people.workspaceId, workspace.id));
    expect(rows).toHaveLength(1);
  });

  it("unverified email equality does not create an account_person_link", async () => {
    const { user, workspace } = await seedWorkspace();
    const [person] = await db
      .insert(people)
      .values({ workspaceId: workspace.id, displayName: "Grace Hopper" })
      .returning();
    await db.insert(contactPoints).values({
      workspaceId: workspace.id,
      personId: person.id,
      kind: "email",
      value: "grace@example.com",
    });

    // Same address, but the provider never confirmed it. The link is created
    // only by an explicit insert — nothing here makes one.
    await db.insert(externalIdentities).values({
      workspaceId: workspace.id,
      provider: "clerk",
      providerAccountId: `user_${crypto.randomUUID()}`,
      email: "grace@example.com",
      verified: false,
      accountId: user.id,
      createdBy: user.id,
    });

    const links = await db
      .select()
      .from(accountPersonLinks)
      .where(eq(accountPersonLinks.workspaceId, workspace.id));
    expect(links).toHaveLength(0);
  });

  it("a composite FK rejects a cross-workspace endpoint", async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    const [personA] = await db
      .insert(people)
      .values({ workspaceId: a.workspace.id, displayName: "In workspace A" })
      .returning();

    // A contact point in workspace B pointing at workspace A's person.
    const stray = await db
      .insert(contactPoints)
      .values({
        workspaceId: b.workspace.id,
        personId: personA.id,
        kind: "email",
        value: "stray@example.com",
      })
      .catch((e) => e);
    expect((stray as { cause?: { code?: string } }).cause?.code).toBe("23503");
  });

  it("a contact point or relationship must have exactly one side", async () => {
    const { workspace } = await seedWorkspace();
    const both = await db
      .insert(contactPoints)
      .values({
        workspaceId: workspace.id,
        kind: "email",
        value: "both@example.com",
        personId: crypto.randomUUID(),
        organizationId: crypto.randomUUID(),
      })
      .catch((e) => e);
    expect((both as { cause?: { code?: string } }).cause?.code).toBe("23514");
  });

  it("an organization dedupes on domain within a workspace, not across them", async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    await db
      .insert(organizations)
      .values({ workspaceId: a.workspace.id, name: "ACME", domain: "acme.test" });
    // Same domain in another workspace is a different organization.
    await db
      .insert(organizations)
      .values({ workspaceId: b.workspace.id, name: "ACME EU", domain: "acme.test" });

    const dupe = await db
      .insert(organizations)
      .values({ workspaceId: a.workspace.id, name: "ACME again", domain: "acme.test" })
      .catch((e) => e);
    expect((dupe as { cause?: { code?: string } }).cause?.code).toBe("23505");
  });
});

suite("unique invariants (ASH-120 review)", () => {
  it("only one primary contact point per party per kind", async () => {
    // The partial unique index fires only for is_primary rows of the same
    // party and kind; a non-primary duplicate must still insert.
    const { workspace } = await seedWorkspace();
    const [person] = await db
      .insert(people)
      .values({ workspaceId: workspace.id, displayName: "Primary Check" })
      .returning();
    const point = {
      workspaceId: workspace.id,
      personId: person.id,
      kind: "email" as const,
      isPrimary: true,
    };
    await db.insert(contactPoints).values({ ...point, value: "first@example.com" });

    const dupe = await db
      .insert(contactPoints).values({ ...point, value: "second@example.com" })
      .catch((e) => e);
    expect((dupe as { cause?: { code?: string } }).cause?.code).toBe("23505");

    // A non-primary email and a primary phone are not blocked.
    await db.insert(contactPoints).values({ ...point, isPrimary: false, value: "third@example.com" });
    await db.insert(contactPoints).values({ ...point, kind: "phone", value: "+1 555 0100" });
  });

  it("one person per account per workspace on account_person_links", async () => {
    const { user, workspace } = await seedWorkspace();
    const [person] = await db
      .insert(people)
      .values({ workspaceId: workspace.id, displayName: "Link Check" })
      .returning();
    const link = {
      workspaceId: workspace.id,
      accountId: user.id,
      personId: person.id,
    };
    await db.insert(accountPersonLinks).values(link);
    const dupe = await db.insert(accountPersonLinks).values(link).catch((e) => e);
    expect((dupe as { cause?: { code?: string } }).cause?.code).toBe("23505");
  });
});
