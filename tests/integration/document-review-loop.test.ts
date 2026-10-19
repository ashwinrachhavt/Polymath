import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { companies, contacts } from "@/domains/crm/schema";
import {
  documentExtractions,
  documentObligations,
  documentParties,
  documents,
  fieldProposals,
  files,
  reviewedAssertions,
} from "@/domains/knowledge/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The document review loop's invariants against real Postgres: the proposal
 * pass is its own retry boundary, party facts land only on their party,
 * acceptance and its audit row commit together, and the action boundary
 * refuses viewers and foreign ids. Skipped without TEST_DATABASE_URL.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
type Auth = { userId: string; workspaceId: string; role: "owner" | "member" | "viewer" };
const holder: { auth?: Auth } = {};
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => holder.auth) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));

let extraction: typeof import("@/domains/knowledge/extraction");
let actions: typeof import("@/app/(workspace)/alfred/knowledge/actions");

beforeAll(async () => {
  if (!handle) return;
  extraction = await import("@/domains/knowledge/extraction");
  actions = await import("@/app/(workspace)/alfred/knowledge/actions");
});
afterAll(async () => {
  await handle?.client.end();
});

const INVOICE = [
  "INVOICE",
  "Invoice number: INV-2026-0142",
  "Due date: 11/10/2026",
  "Currency: EUR",
  "From:",
  "Harbor Lane Carpentry Ltd",
  "billing@harborlane.example",
  "Bill to:",
  "Maeve Brennan",
  "maeve.brennan@example.org",
  "Total due: EUR 1,248.50",
].join("\n");

/** A document whose text extraction already succeeded but whose proposal pass did not. */
async function seedReadDocument(proposalStatus: "failed" | null) {
  const db = handle!.db;
  const auth: Auth = { ...(await seedWorkspace(db, `loop-${crypto.randomUUID()}`)), role: "owner" };
  const [blob] = await db.insert(blobObjects).values({
    workspaceId: auth.workspaceId, storageKey: `private/${crypto.randomUUID()}`, contentHash: crypto.randomUUID(),
    sizeBytes: 4, mimeType: "application/pdf",
  }).returning();
  const [file] = await db.insert(files).values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: "invoice.pdf" }).returning();
  const [doc] = await db.insert(documents).values({
    workspaceId: auth.workspaceId, title: "Harbor Lane invoice", fileId: file.id, mimeType: "application/pdf",
  }).returning();
  const [row] = await db.insert(documentExtractions).values({
    workspaceId: auth.workspaceId, documentId: doc.id, contentHash: blob.contentHash, status: "succeeded",
    text: INVOICE, spans: [{ page: 1, start: 0, end: INVOICE.length }], extractor: "fixture@1", proposalStatus,
  }).returning();
  holder.auth = auth;
  return { auth, doc, extraction: row };
}

const proposalsOf = (documentId: string) =>
  handle!.db.select().from(fieldProposals).where(eq(fieldProposals.documentId, documentId));

suite("document review loop (real Postgres)", () => {
  it.each([null, "failed"] as const)(
    "reruns the proposal pass after text succeeded (prior pass %s), once and idempotently",
    async (prior) => {
      const { auth, doc } = await seedReadDocument(prior);
      const first = await extraction.extractDocument(auth, { documentId: doc.id });
      expect(first).toMatchObject({ ok: true, deduplicated: true, proposals: "succeeded" });
      const second = await extraction.extractDocument(auth, { documentId: doc.id });
      expect(second).toMatchObject({ ok: true, proposals: "already_done" });

      const fields = await proposalsOf(doc.id);
      expect(fields.map((f) => f.fieldName).sort()).toEqual(
        ["due_date", "invoice_number", "invoice_total", "issuer_email", "recipient_email"],
      );
      const parties = await handle!.db.select().from(documentParties).where(eq(documentParties.documentId, doc.id));
      expect(parties).toHaveLength(2);
      const obligations = await handle!.db.select().from(documentObligations).where(eq(documentObligations.documentId, doc.id));
      expect(obligations.map((o) => o.kind)).toEqual(["confirm_invoice_status"]);
      const [row] = await handle!.db.select().from(documentExtractions).where(eq(documentExtractions.documentId, doc.id));
      expect(row).toMatchObject({ proposalStatus: "succeeded", proposer: "text-rules@1", proposalError: null });
    },
  );

  it("attributes party fields to their own party only", async () => {
    const { doc } = await seedReadDocument(null);
    await extraction.extractDocument(holder.auth!, { documentId: doc.id });
    const fields = await proposalsOf(doc.id);
    for (const f of fields) await actions.acceptField(f.id, f.normalizedValue == null ? "2026-11-10" : undefined);

    const parties = await handle!.db.select().from(documentParties).where(eq(documentParties.documentId, doc.id));
    for (const party of parties) {
      await actions.acceptPartyDecision(party.id, party.partyKind === "company"
        ? { action: "create", company: { name: party.displayName } }
        : { action: "create", contact: { fullName: party.displayName } });
    }
    const [company] = await handle!.db.select().from(companies).where(eq(companies.workspaceId, holder.auth!.workspaceId));
    const [contact] = await handle!.db.select().from(contacts).where(eq(contacts.workspaceId, holder.auth!.workspaceId));
    const assertionsFor = (subjectId: string) =>
      handle!.db.select({ attribute: reviewedAssertions.attribute, value: reviewedAssertions.value })
        .from(reviewedAssertions).where(eq(reviewedAssertions.subjectId, subjectId));
    expect(await assertionsFor(company.id)).toEqual([{ attribute: "email", value: "billing@harborlane.example" }]);
    expect(await assertionsFor(contact.id)).toEqual([{ attribute: "email", value: "maeve.brennan@example.org" }]);
  });

  it("rolls back acceptance when its audit insert fails", async () => {
    const { doc } = await seedReadDocument(null);
    await extraction.extractDocument(holder.auth!, { documentId: doc.id });
    const [field] = (await proposalsOf(doc.id)).filter((f) => f.fieldName === "invoice_number");
    const fn = `fail_audit_${doc.id.replace(/-/g, "")}`;
    await handle!.client.unsafe(`
      create function ${fn}() returns trigger language plpgsql as $$ begin
        if new.metadata->>'documentId' = '${doc.id}' then raise exception 'audit unavailable'; end if;
        return new; end $$;
      create trigger ${fn} before insert on audit_events for each row execute function ${fn}();`);
    try {
      await expect(actions.acceptField(field.id)).rejects.toThrow(/insert into "audit_events"/);
    } finally {
      await handle!.client.unsafe(`drop trigger ${fn} on audit_events; drop function ${fn}();`);
    }
    const [after] = await handle!.db.select().from(fieldProposals).where(eq(fieldProposals.id, field.id));
    expect(after).toMatchObject({ status: "proposed", acceptedValue: null, version: field.version });
  });

  it("refuses viewers and foreign-workspace ids at the action boundary", async () => {
    const { auth, doc } = await seedReadDocument(null);
    await extraction.extractDocument(auth, { documentId: doc.id });
    const [field] = await proposalsOf(doc.id);
    const [party] = await handle!.db.select().from(documentParties).where(eq(documentParties.documentId, doc.id));

    holder.auth = { ...auth, role: "viewer" };
    await expect(actions.acceptField(field.id, "x")).rejects.toThrow(/Requires member/);
    await expect(actions.rejectField(field.id)).rejects.toThrow(/Requires member/);
    await expect(actions.acceptPartyDecision(party.id, { action: "reject" })).rejects.toThrow(/Requires member/);

    const other: Auth = { ...(await seedWorkspace(handle!.db, `foreign-${crypto.randomUUID()}`)), role: "owner" };
    holder.auth = other;
    await expect(actions.acceptField(field.id, "x")).rejects.toThrow("not found in workspace");
    await expect(actions.acceptPartyDecision(party.id, { action: "reject" })).rejects.toThrow("not found in workspace");

    // A match target from another workspace is refused even on the owner's own party.
    const [foreignContact] = await handle!.db.insert(contacts).values({ workspaceId: other.workspaceId, fullName: "Elsewhere" }).returning();
    holder.auth = auth;
    await expect(actions.acceptPartyDecision(party.id, { action: "match", contactId: foreignContact.id }))
      .rejects.toThrow("match target not found in workspace");

    const [unchanged] = await handle!.db.select().from(fieldProposals)
      .where(and(eq(fieldProposals.id, field.id), eq(fieldProposals.status, "proposed")));
    expect(unchanged).toBeDefined();
  });
});
