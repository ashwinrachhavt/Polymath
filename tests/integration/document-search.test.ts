import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { contacts } from "@/domains/crm/schema";
import {
  documentParties,
  documents,
  documentExtractions,
  files,
  reviewedAssertions,
} from "@/domains/knowledge/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Search invariants against real Postgres: tenant scoping, the OR-combined
 * full-text/name match (a failed extraction must not hide a document), and
 * assertion provenance with document titles. Skipped without
 * TEST_DATABASE_URL, same as the other suites. Suites here insert fresh
 * unique slugs rather than truncating, so it can share the scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const holder: {
  db: NonNullable<ReturnType<typeof makeTestDb>>["db"];
} = { db: undefined as never };

vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

import { explainAssertion, searchDocuments } from "@/domains/knowledge/search";

beforeAll(() => {
  if (!handle) return;
  holder.db = handle.db;
});

afterAll(async () => {
  await handle?.client.end();
});

suite("document search", () => {
  type Auth = { userId: string; workspaceId: string; role: "owner" };

  async function seedAuth(slug: string): Promise<Auth> {
    const db = holder.db;
    const { userId, workspaceId } = await seedWorkspace(db, `search-${slug}-${Date.now()}`);
    return { userId, workspaceId, role: "owner" };
  }

  async function seedDocument(
    auth: Auth,
    values: {
      title: string;
      filename?: string;
      extractionText?: string | null;
      extractionStatus?: "pending" | "succeeded" | "failed";
    },
  ) {
    const db = holder.db;
    let fileId: string | undefined;
    if (values.filename) {
      const [blob] = await db
        .insert(blobObjects)
        .values({
          workspaceId: auth.workspaceId,
          storageKey: `key-${crypto.randomUUID()}`,
          contentHash: `hash-${crypto.randomUUID()}`,
          sizeBytes: 1,
          mimeType: "application/pdf",
        })
        .returning();
      const [file] = await db
        .insert(files)
        .values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: values.filename })
        .returning();
      fileId = file.id;
    }
    const [document] = await db
      .insert(documents)
      .values({ workspaceId: auth.workspaceId, title: values.title, fileId: fileId ?? null })
      .returning();
    const [extraction] = await db
      .insert(documentExtractions)
      .values({
        workspaceId: auth.workspaceId,
        documentId: document.id,
        contentHash: `hash-${crypto.randomUUID()}`,
        status: values.extractionStatus ?? "succeeded",
        text: values.extractionText ?? null,
      })
      .returning();
    return { document, extraction };
  }

  it("a tenant cannot see another tenant's documents", async () => {
    const a = await seedAuth("a");
    const b = await seedAuth("b");
    await seedDocument(a, { title: `Acme invoice October ${Date.now()}`, extractionText: "invoice total due" });

    const seenByB = await searchDocuments(b, { query: "Acme" });
    expect(seenByB).toHaveLength(0);

    const seenByA = await searchDocuments(a, { query: "Acme" });
    expect(seenByA).toHaveLength(1);
  });

  it("extraction text finds a document whose title does not match", async () => {
    const auth = await seedAuth("text");
    await seedDocument(auth, {
      title: `Scan ${Date.now()}`,
      extractionText: "The vendor Ravelin Systems agrees to supply services.",
    });

    const hits = await searchDocuments(auth, { query: "Ravelin" });
    expect(hits).toHaveLength(1);
    expect(hits[0].extractionStatus).toBe("succeeded");
  });

  it("filename finds a document whose extraction failed", async () => {
    const auth = await seedAuth("filename");
    await seedDocument(auth, {
      title: "Untitled document",
      filename: `acme-invoice-final-${Date.now()}.pdf`,
      extractionText: null,
      extractionStatus: "failed",
    });

    const hits = await searchDocuments(auth, { query: "acme-invoice-final" });
    expect(hits).toHaveLength(1);
    expect(hits[0].extractionStatus).toBe("failed");
  });

  it("filters by party contact", async () => {
    const auth = await seedAuth("party");
    const db = holder.db;
    const marker = `nda-${Date.now()}`;
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: auth.workspaceId, fullName: "Ada Lovelace" })
      .returning();
    const { document } = await seedDocument(auth, { title: marker, extractionText: "nda" });
    await seedDocument(auth, { title: `unrelated ${marker}`, extractionText: "nda" });
    await db.insert(documentParties).values({
      workspaceId: auth.workspaceId,
      documentId: document.id,
      partyRole: "signatory",
      partyKind: "contact",
      contactId: contact.id,
      displayName: "Ada Lovelace",
    });

    const hits = await searchDocuments(auth, { filters: { contactId: contact.id } });
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe(marker);
  });

  it("paginates without overlap", async () => {
    const auth = await seedAuth("paging");
    for (let i = 0; i < 3; i++) {
      await seedDocument(auth, { title: `Paged doc ${Date.now()}-${i}`, extractionText: "paging" });
    }
    const page = await searchDocuments(auth, { query: "paging", limit: 2, offset: 0 });
    expect(page).toHaveLength(2);
    const next = await searchDocuments(auth, { query: "paging", limit: 2, offset: 2 });
    expect(next).toHaveLength(1);
    expect(page.map((r) => r.id)).not.toContain(next[0].id);
  });

  it("explainAssertion returns history with document titles and spans", async () => {
    const auth = await seedAuth("explain");
    const db = holder.db;
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: auth.workspaceId, fullName: "Ada" })
      .returning();
    const first = await seedDocument(auth, { title: "Résumé v1", extractionText: "engineer at Acme" });
    const second = await seedDocument(auth, { title: "Résumé v2", extractionText: "senior engineer at Acme" });

    await db.insert(reviewedAssertions).values([
      {
        workspaceId: auth.workspaceId,
        subjectType: "contact",
        subjectId: contact.id,
        attribute: "employment_role",
        value: { title: "Engineer" },
        documentId: first.document.id,
        extractionId: first.extraction.id,
        evidenceSpans: [{ page: 1, start: 10, end: 24 }],
        sourceAttribution: "supplied résumé v1",
      },
      {
        workspaceId: auth.workspaceId,
        subjectType: "contact",
        subjectId: contact.id,
        attribute: "employment_role",
        value: { title: "Senior Engineer" },
        documentId: second.document.id,
        extractionId: second.extraction.id,
        evidenceSpans: [{ page: 1, start: 12, end: 34 }],
        sourceAttribution: "supplied résumé v2",
      },
    ]);

    const history = await explainAssertion(auth, {
      subjectType: "contact",
      subjectId: contact.id,
      attribute: "employment_role",
    });
    expect(history).toHaveLength(2);
    expect(history[0].documentTitle).toBe("Résumé v1");
    expect(history[0].evidenceSpans).toEqual([{ page: 1, start: 10, end: 24 }]);
    expect(history[1].documentTitle).toBe("Résumé v2");

    // Another tenant gets nothing for the same subject id.
    const other = await seedAuth("explain-b");
    const foreign = await explainAssertion(other, {
      subjectType: "contact",
      subjectId: contact.id,
      attribute: "employment_role",
    });
    expect(foreign).toHaveLength(0);

    // A different attribute on the same subject returns nothing.
    const otherAttr = await explainAssertion(auth, {
      subjectType: "contact",
      subjectId: contact.id,
      attribute: "home_address",
    });
    expect(otherAttr).toHaveLength(0);
  });

  it("explainAssertion tolerates an assertion with no document", async () => {
    const auth = await seedAuth("explain-nodoc");
    const db = holder.db;
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: auth.workspaceId, fullName: "Grace" })
      .returning();
    await db.insert(reviewedAssertions).values({
      workspaceId: auth.workspaceId,
      subjectType: "contact",
      subjectId: contact.id,
      attribute: "preferred_name",
      value: { name: "Grace" },
      sourceAttribution: "entered by hand",
    });
    const history = await explainAssertion(auth, {
      subjectType: "contact",
      subjectId: contact.id,
      attribute: "preferred_name",
    });
    expect(history).toHaveLength(1);
    expect(history[0].documentId).toBeNull();
    expect(history[0].documentTitle).toBeNull();
  });
});
