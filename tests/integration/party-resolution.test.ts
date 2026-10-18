import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { companies, contacts } from "@/domains/crm/schema";
import { documentExtractions, documents } from "@/domains/knowledge/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The party-resolution invariants a mock would only pretend to hold:
 * reprocessing never mints a second contact, the supersede chain keeps the
 * original row, and retracting evidence leaves the reviewed record intact.
 * Skipped without a scratch database, same as the other integration suites.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let parties: typeof import("@/domains/knowledge/parties");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  parties = await import("@/domains/knowledge/parties");
});

afterAll(async () => {
  await handle?.client.end();
});

const auth = (userId: string, workspaceId: string) => ({
  userId,
  workspaceId,
  role: "owner" as const,
});

async function seedDocument(workspaceId: string, title = "Acme services agreement") {
  const [document] = await db
    .insert(documents)
    .values({ workspaceId, title, mimeType: "application/pdf" })
    .returning();
  const [extraction] = await db
    .insert(documentExtractions)
    .values({ workspaceId, documentId: document.id, contentHash: `hash-${crypto.randomUUID()}` })
    .returning();
  return { document, extraction };
}

suite("party resolution", () => {
  it("email match beats name, and a name-only match never resolves", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `party-email-${Date.now()}`);
    const a = auth(userId, workspaceId);
    const { document, extraction } = await seedDocument(workspaceId);

    // Two contacts named differently from the document's rendering; one holds
    // the verified email.
    const [withEmail] = await db
      .insert(contacts)
      .values({
        workspaceId,
        fullName: "Ada Lovelace",
        primaryEmail: "a.lovelace@calc.dev",
        createdBy: userId,
      })
      .returning();
    await db.insert(contacts).values({ workspaceId, fullName: "Completely Different" });

    // Propose with the email hint: verified identity resolves at propose time.
    const proposed = await parties.proposeParties(a, {
      documentId: document.id,
      extractionId: extraction.id,
      candidates: [
        {
          partyRole: "sender",
          partyKind: "contact",
          displayName: "A. Lovelace",
          email: "a.lovelace@calc.dev",
        },
        {
          partyRole: "recipient",
          partyKind: "contact",
          displayName: "Ada Lovelace",
        },
      ],
    });
    expect(proposed).toEqual({ proposed: 2, skipped: 0 });

    const options = await parties.resolvePartyCandidates(a, { documentId: document.id });
    const sender = options.find((o) => o.partyRole === "sender");
    const recipient = options.find((o) => o.partyRole === "recipient");

    // Verified identity: matched, resolved to the email's contact.
    expect(sender?.resolutionStatus).toBe("matched");
    expect(sender?.resolvedTo?.id).toBe(withEmail.id);
    // Name alone: still unresolved, offered as options only — never merged.
    expect(recipient?.resolutionStatus).toBe("unresolved");
    expect(recipient?.resolvedTo).toBeUndefined();
    expect(recipient?.options.length).toBeGreaterThanOrEqual(1);
    expect(recipient?.options.every((o) => o.via === "name")).toBe(true);
  });

  it("issuer and recipient stay distinct parties", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `party-roles-${Date.now()}`);
    const a = auth(userId, workspaceId);
    const { document } = await seedDocument(workspaceId, "Invoice 2026-10");

    await parties.proposeParties(a, {
      documentId: document.id,
      candidates: [
        { partyRole: "issuer", partyKind: "company", displayName: "Acme Corp" },
        { partyRole: "recipient", partyKind: "company", displayName: "Acme Corp" },
      ],
    });
    const options = await parties.resolvePartyCandidates(a, { documentId: document.id });
    // Same name, different roles: two rows, never one "counterparty".
    expect(options.filter((o) => o.displayName === "Acme Corp").map((o) => o.partyRole)).toEqual([
      "issuer",
      "recipient",
    ]);
  });

  it("acceptParty create is idempotent on reprocess — no duplicate contact", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `party-create-${Date.now()}`);
    const a = auth(userId, workspaceId);
    const { document, extraction } = await seedDocument(workspaceId);

    const [before] = await db
      .select({ count: documents.id })
      .from(documents)
      .where(eq(documents.id, document.id));

    await parties.proposeParties(a, {
      documentId: document.id,
      extractionId: extraction.id,
      candidates: [
        { partyRole: "signatory", partyKind: "contact", displayName: "Grace Hopper" },
      ],
    });
    const first = await parties.resolvePartyCandidates(a, { documentId: document.id });
    const party = first.find((o) => o.displayName === "Grace Hopper");
    expect(party?.resolutionStatus).toBe("unresolved");

    const created = await parties.acceptParty(a, {
      partyId: party!.partyId,
      decision: { action: "create", contact: { fullName: "Grace Hopper" } },
    });
    expect(created.contactId).toBeDefined();
    void before;

    // The audit trail recorded the creation once.
    const audits = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "contact.created_from_document"),
          eq(auditEvents.subjectId, created.contactId!),
        ),
      );
    expect(audits).toHaveLength(1);

    // Reprocessing proposes the same candidate again: the decided twin is
    // found and skipped, and no second contact is minted.
    const reproposed = await parties.proposeParties(a, {
      documentId: document.id,
      extractionId: extraction.id,
      candidates: [
        { partyRole: "signatory", partyKind: "contact", displayName: "Grace Hopper" },
      ],
    });
    expect(reproposed).toEqual({ proposed: 0, skipped: 1 });

    const after = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.fullName, "Grace Hopper")));
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(created.contactId);

    // Resolution status was not reset by reprocessing.
    const options = await parties.resolvePartyCandidates(a, { documentId: document.id });
    expect(options.find((o) => o.displayName === "Grace Hopper")?.resolutionStatus).toBe(
      "created",
    );
  });

  it("an assertion supersede chain keeps the original row", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `party-assert-${Date.now()}`);
    const a = auth(userId, workspaceId);
    const { document } = await seedDocument(workspaceId);
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId, fullName: "Ada Lovelace" })
      .returning();

    await parties.acceptAssertions(a, {
      documentId: document.id,
      assertions: [
        {
          subjectType: "contact",
          subjectId: contact.id,
          attribute: "employment_role",
          value: { title: "Engineer" },
        },
      ],
    });
    const first = await parties.getAssertions(a, {
      subjectType: "contact",
      subjectId: contact.id,
    });
    expect(Object.keys(first.current)).toEqual(["employment_role"]);
    expect(first.current.employment_role.value).toEqual({ title: "Engineer" });
    expect(first.current.employment_role.sourceAttribution).toBe(
      "Acme services agreement (application/pdf)",
    );

    // The correction arrives marked as superseding: a new row, the old one
    // flipped, nothing overwritten.
    await parties.acceptAssertions(a, {
      documentId: document.id,
      assertions: [
        {
          subjectType: "contact",
          subjectId: contact.id,
          attribute: "employment_role",
          value: { title: "Senior Engineer" },
          supersedesAssertionId: first.current.employment_role.id,
        },
      ],
    });
    const second = await parties.getAssertions(a, {
      subjectType: "contact",
      subjectId: contact.id,
    });
    expect(second.current.employment_role.value).toEqual({ title: "Senior Engineer" });
    expect(second.current.employment_role.id).not.toBe(first.current.employment_role.id);
    expect(second.history).toHaveLength(2);
    const original = second.history.find((h) => h.id === first.current.employment_role.id);
    expect(original?.status).toBe("superseded");
    expect(original?.value).toEqual({ title: "Engineer" });
    expect(
      second.history.find((h) => h.id === second.current.employment_role.id)
        ?.supersedesAssertionId,
    ).toBe(first.current.employment_role.id);
  });

  it("retractEvidence marks sourced assertions retracted without deleting contacts", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `party-retract-${Date.now()}`);
    const a = auth(userId, workspaceId);
    const { document } = await seedDocument(workspaceId);
    const [company] = await db
      .insert(companies)
      .values({ workspaceId, name: "Analytical Engines Ltd" })
      .returning();

    await parties.acceptAssertions(a, {
      documentId: document.id,
      assertions: [
        {
          subjectType: "company",
          subjectId: company.id,
          attribute: "headcount",
          value: { count: 42 },
        },
        {
          subjectType: "company",
          subjectId: company.id,
          attribute: "industry",
          value: { sector: "computing" },
        },
      ],
    });

    const retracted = await parties.retractEvidence(a, { documentId: document.id });
    expect(retracted.retracted).toBe(2);

    // Rows survive with their values — the record of what was once accepted.
    const projection = await parties.getAssertions(a, {
      subjectType: "company",
      subjectId: company.id,
    });
    expect(projection.history).toHaveLength(2);
    expect(projection.history.every((h) => h.status === "retracted")).toBe(true);
    expect(projection.history.map((h) => h.value)).toEqual([
      { count: 42 },
      { sector: "computing" },
    ]);
    expect(Object.keys(projection.current)).toHaveLength(0);

    // The reviewed record itself was not touched.
    const [stillThere] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, company.id));
    expect(stillThere.id).toBe(company.id);

    // Re-retract is a no-op: nothing active remains.
    const again = await parties.retractEvidence(a, { documentId: document.id });
    expect(again.retracted).toBe(0);
  });
});
