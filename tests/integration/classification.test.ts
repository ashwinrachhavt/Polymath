import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentClassificationProposals, documentRenameEvents, documents } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * B02 invariants: classification proposes, never auto-accepts - except the
 * one ASH-202 scope, a high-confidence bank statement, which is accepted on
 * upload; accepting a proposal sets the one doc-type signal in the same
 * transaction; a decided proposal cannot be re-decided; every rename lands
 * in the manifest with its old and new titles.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let classify: typeof import("@/domains/knowledge/classify");
let naming: typeof import("@/domains/knowledge/naming");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  classify = await import("@/domains/knowledge/classify");
  naming = await import("@/domains/knowledge/naming");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const seeded = await seedWorkspace(db, `${slug}-${Date.now()}`);
  const auth = ownerAuth(seeded.userId, seeded.workspaceId);
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId: auth.workspaceId, title: `${slug}.pdf` })
    .returning();
  return { auth, doc };
}

suite("classification and rename manifest", () => {
  it("a high-confidence bank statement is accepted on upload; everything else still proposes", async () => {
    const { auth, doc } = await seed("classify-auto");
    const result = await classify.proposeClassification(auth, {
      documentId: doc.id,
      extractionId: null,
      text: "Monthly Statement Period\nJan 1 - Jan 31\nBeginning Balance $521.35\nEnding Balance $470.20",
      fieldNames: [],
    });
    expect(result).toMatchObject({ proposed: false, docType: "statement" });
    expect(await classify.getOpenClassification(auth, doc.id)).toBeNull();
    const [after] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(after.docType).toBe("statement");

    // The accepted proposal row still records the basis for the decision.
    const accepted = await db
      .select()
      .from(documentClassificationProposals)
      .where(eq(documentClassificationProposals.documentId, doc.id));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ status: "accepted", confidence: "high", proposedType: "statement" });

    // A high-confidence invoice is NOT auto-accepted: the scope is statements.
    const { auth: auth2, doc: doc2 } = await seed("classify-invoice-still-proposal");
    const invoice = await classify.proposeClassification(auth2, {
      documentId: doc2.id,
      extractionId: null,
      text: "INVOICE\nTotal due: EUR 100",
      fieldNames: ["invoice_number", "invoice_total"],
    });
    expect(invoice).toMatchObject({ proposed: true, docType: "invoice" });
    const [after2] = await db.select().from(documents).where(eq(documents.id, doc2.id));
    expect(after2.docType).toBeNull();
  });

  it("propose then accept sets documents.doc_type once", async () => {
    const { auth, doc } = await seed("classify-accept");
    const proposed = await classify.proposeClassification(auth, {
      documentId: doc.id,
      extractionId: null,
      text: "INVOICE\nTotal due: EUR 100",
      fieldNames: ["invoice_number", "invoice_total"],
    });
    expect(proposed).toMatchObject({ proposed: true, docType: "invoice" });

    const open = await classify.getOpenClassification(auth, doc.id);
    expect(open?.proposedType).toBe("invoice");

    await classify.acceptClassification(auth, { proposalId: open!.id, expectedVersion: open!.version });
    const [after] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(after.docType).toBe("invoice");

    // A decided proposal is done: re-deciding throws, re-proposing no-ops.
    await expect(
      classify.acceptClassification(auth, { proposalId: open!.id, expectedVersion: open!.version }),
    ).rejects.toThrow(/already decided/);
    const again = await classify.proposeClassification(auth, {
      documentId: doc.id,
      extractionId: null,
      text: "INVOICE",
      fieldNames: ["invoice_number"],
    });
    expect(again.proposed).toBe(false);
  });

  it("an unmatched document proposes nothing", async () => {
    const { auth, doc } = await seed("classify-none");
    const result = await classify.proposeClassification(auth, {
      documentId: doc.id,
      extractionId: null,
      text: "a quiet walk",
      fieldNames: [],
    });
    expect(result.proposed).toBe(false);
    expect(await classify.getOpenClassification(auth, doc.id)).toBeNull();
  });

  it("applyTitle writes the rename manifest and never re-types", async () => {
    const { auth, doc } = await seed("rename-manifest");
    const renamed = await naming.applyTitle(auth, {
      documentId: doc.id,
      title: "Harbor Lane - Invoice 1042",
      expectedVersion: doc.version,
      source: "suggested",
      basis: { issuer: "Harbor Lane", invoice_number: "1042" },
    });
    expect(renamed.title).toBe("Harbor Lane - Invoice 1042");

    const events = await db
      .select()
      .from(documentRenameEvents)
      .where(and(eq(documentRenameEvents.documentId, doc.id)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      oldTitle: "rename-manifest.pdf",
      newTitle: "Harbor Lane - Invoice 1042",
      source: "suggested",
    });

    const [after] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(after.docType).toBeNull();
    // Version-checked: a stale caller cannot rename.
    await expect(
      naming.applyTitle(auth, { documentId: doc.id, title: "stale", expectedVersion: doc.version }),
    ).rejects.toThrow(/stale version/);
  });
});
