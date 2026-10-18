import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, contacts } from "@/domains/crm/schema";
import {
  documentParties,
  documents,
  documentExtractions,
  fieldProposals,
  reviewedAssertions,
} from "@/domains/knowledge/schema";
import { users, workspaces } from "@/domains/identity/schema";

/*
 * The document-intelligence invariants that a mock would only pretend to hold:
 * tenant scoping, the one-target party constraint, dedupe keys, append-only
 * assertion history, and optimistic versions. Skipped without a scratch
 * database, same as reliability.test.ts.
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

suite("document intelligence schema", () => {
  beforeAll(async () => {
    if (!url) return;
    if (url === process.env.DATABASE_URL) {
      throw new Error(
        "TEST_DATABASE_URL equals DATABASE_URL. This suite truncates every table; use a scratch database or a Neon branch.",
      );
    }
    await client.unsafe(
      `do $$ declare t text; begin for t in
         select tablename from pg_tables where schemaname = 'public'
       loop execute format('truncate table %I cascade', t); end loop; end $$;`,
    );
  });

  async function seedWorkspace(slug: string) {
    const [user] = await db.insert(users).values({ clerkUserId: `clerk_${slug}` }).returning();
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: slug, slug, createdBy: user.id })
      .returning();
    return { user, workspace };
  }

  async function seedDocument(workspaceId: string) {
    const [document] = await db
      .insert(documents)
      .values({ workspaceId, title: "Acme services agreement" })
      .returning();
    const [extraction] = await db
      .insert(documentExtractions)
      .values({ workspaceId, documentId: document.id, contentHash: `hash-${crypto.randomUUID()}` })
      .returning();
    return { document, extraction };
  }

  it("a scoped query does not see another workspace's proposals", async () => {
    const a = await seedWorkspace("doc-a");
    const b = await seedWorkspace("doc-b");
    const docA = await seedDocument(a.workspace.id);

    await db.insert(fieldProposals).values({
      workspaceId: a.workspace.id,
      documentId: docA.document.id,
      extractionId: docA.extraction.id,
      fieldKind: "money",
      fieldName: "invoice_total",
      dedupeKey: "invoice_total:v1",
    });

    const visibleToB = await db
      .select()
      .from(fieldProposals)
      .where(
        and(
          eq(fieldProposals.fieldName, "invoice_total"),
          eq(fieldProposals.workspaceId, b.workspace.id),
        ),
      );
    expect(visibleToB).toHaveLength(0);

    const visibleToA = await db
      .select()
      .from(fieldProposals)
      .where(
        and(
          eq(fieldProposals.fieldName, "invoice_total"),
          eq(fieldProposals.workspaceId, a.workspace.id),
        ),
      );
    expect(visibleToA).toHaveLength(1);
  });

  it("a document party may hold at most one of contact or company", async () => {
    const { workspace } = await seedWorkspace("parties");
    const { document } = await seedDocument(workspace.id);

    // Both null: an unresolved party awaiting a human decision.
    await db.insert(documentParties).values({
      workspaceId: workspace.id,
      documentId: document.id,
      partyRole: "sender",
      partyKind: "contact",
      displayName: "Nobody",
    });

    // Both set: a double-counted party.
    const [company] = await db
      .insert(companies)
      .values({ workspaceId: workspace.id, name: "Acme" })
      .returning();
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: workspace.id, fullName: "Ada" })
      .returning();

    await expect(
      db.insert(documentParties).values({
        workspaceId: workspace.id,
        documentId: document.id,
        partyRole: "sender",
        partyKind: "contact",
        contactId: contact.id,
        companyId: company.id,
        displayName: "Both",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    // Exactly one is fine.
    await db.insert(documentParties).values({
      workspaceId: workspace.id,
      documentId: document.id,
      partyRole: "sender",
      partyKind: "contact",
      contactId: contact.id,
      displayName: "Ada",
    });
  });

  it("a dedupe key blocks a duplicate proposal for the same document", async () => {
    const { workspace } = await seedWorkspace("dedupe");
    const { document, extraction } = await seedDocument(workspace.id);
    const values = {
      workspaceId: workspace.id,
      documentId: document.id,
      extractionId: extraction.id,
      fieldKind: "money" as const,
      fieldName: "invoice_total",
      dedupeKey: "invoice_total:v1",
    };
    await db.insert(fieldProposals).values(values);

    const replay = await db.insert(fieldProposals).values(values).catch((e) => e);
    expect((replay as { cause?: { code?: string } }).cause?.code).toBe("23505");

    // A different field context on the same document is a new proposal.
    await db.insert(fieldProposals).values({ ...values, dedupeKey: "effective_date:v1" });
  });

  it("superseding an assertion leaves the original row untouched", async () => {
    const { workspace } = await seedWorkspace("assertions");
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: workspace.id, fullName: "Ada" })
      .returning();

    const [original] = await db
      .insert(reviewedAssertions)
      .values({
        workspaceId: workspace.id,
        subjectType: "contact",
        subjectId: contact.id,
        attribute: "employment_role",
        value: { title: "Engineer" },
        sourceAttribution: "supplied résumé v1",
      })
      .returning();
    expect(original.status).toBe("active");

    // The corrected belief is a new row that points back at the old one.
    const [correction] = await db
      .insert(reviewedAssertions)
      .values({
        workspaceId: workspace.id,
        subjectType: "contact",
        subjectId: contact.id,
        attribute: "employment_role",
        value: { title: "Senior Engineer" },
        sourceAttribution: "supplied résumé v2",
        supersedesAssertionId: original.id,
      })
      .returning();

    await db
      .update(reviewedAssertions)
      .set({ status: "superseded" })
      .where(eq(reviewedAssertions.id, original.id));

    // History is rows: the original keeps its own value; nothing was overwritten.
    const [before] = await db
      .select()
      .from(reviewedAssertions)
      .where(eq(reviewedAssertions.id, original.id));
    expect(before.value).toEqual({ title: "Engineer" });
    expect(before.status).toBe("superseded");
    expect(before.sourceAttribution).toBe("supplied résumé v1");
    expect(correction.supersedesAssertionId).toBe(original.id);
  });

  it("a stale version write is rejected", async () => {
    const { workspace } = await seedWorkspace("doc-versions");
    const { document, extraction } = await seedDocument(workspace.id);
    const [proposal] = await db
      .insert(fieldProposals)
      .values({
        workspaceId: workspace.id,
        documentId: document.id,
        extractionId: extraction.id,
        fieldKind: "money",
        fieldName: "invoice_total",
        dedupeKey: `total:${crypto.randomUUID()}`,
      })
      .returning();
    expect(proposal.version).toBe(1);

    const fresh = await db
      .update(fieldProposals)
      .set({ status: "accepted", version: 2, updatedAt: new Date() })
      .where(and(eq(fieldProposals.id, proposal.id), eq(fieldProposals.version, 1)))
      .returning();
    expect(fresh).toHaveLength(1);

    // The same guard from the same stale read now matches nothing.
    const stale = await db
      .update(fieldProposals)
      .set({ status: "rejected", version: 2, updatedAt: new Date() })
      .where(and(eq(fieldProposals.id, proposal.id), eq(fieldProposals.version, 1)))
      .returning();
    expect(stale).toHaveLength(0);
  });
});
