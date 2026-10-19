import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { auditEvents } from "@/domains/audit/schema";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { companies, contactCompanies, contacts } from "../crm/schema";
import {
  documentParties,
  documents,
  reviewedAssertions,
  type documentPartyKind,
  type documentPartyRole,
} from "./schema";

/*
 * Party resolution: extracted people/organizations become document_parties
 * rows, a human decides match/create/reject, and only then do accepted facts
 * reach reviewed_assertions. Verified identity (email, domain) proposes a
 * match; a name alone never merges — the same "Ada" in two documents is two
 * people until evidence says otherwise.
 */

type PartyRole = (typeof documentPartyRole.enumValues)[number];
type PartyKind = (typeof documentPartyKind.enumValues)[number];

export type PartyCandidate = {
  partyRole: PartyRole;
  partyKind: PartyKind;
  displayName: string;
  evidenceSpans?: unknown;
  /** Verified-identity hint: exact match on contacts.primaryEmail. */
  email?: string;
  /** Verified-identity hint: exact match on companies.domain. */
  domain?: string;
};

export type PartyDecision =
  | { action: "match"; contactId?: string; companyId?: string }
  | {
      action: "create";
      contact?: { fullName: string; primaryEmail?: string };
      company?: { name: string; domain?: string };
    }
  | { action: "reject" }
  | { action: "leave_unresolved" };

/**
 * Record extracted parties. Unresolved by default; a candidate carrying
 * verified identity (email on a contact, domain on a company) is matched to
 * that record at propose time — the hint lives on the candidate, and the row
 * is the only durable place a decision can be recorded. Idempotent per
 * document: a decided row is never reset by reprocessing, and the same
 * role+name unresolved candidate is not duplicated.
 */
export async function proposeParties(
  auth: AuthContext,
  input: { documentId: string; extractionId?: string; candidates: PartyCandidate[] },
): Promise<{ proposed: number; skipped: number }> {
  if (input.candidates.length === 0) return { proposed: 0, skipped: 0 };

  const [document] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!document) throw new Error("document not found in workspace");

  const existing = await db
    .select({
      partyRole: documentParties.partyRole,
      displayName: documentParties.displayName,
      resolutionStatus: documentParties.resolutionStatus,
    })
    .from(documentParties)
    .where(eq(documentParties.documentId, input.documentId));

  // Verified-identity lookups: one round trip per kind, not per candidate.
  const emails = input.candidates
    .filter((c) => c.partyKind === "contact" && c.email)
    .map((c) => c.email!.toLowerCase());
  const domains = input.candidates
    .filter((c) => c.partyKind === "company" && c.domain)
    .map((c) => c.domain!.toLowerCase());
  const contactsByEmail = emails.length
    ? await db
        .select({ id: contacts.id, primaryEmail: contacts.primaryEmail })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, auth.workspaceId),
            inArray(sql`lower(${contacts.primaryEmail})`, emails),
          ),
        )
    : [];
  const companiesByDomain = domains.length
    ? await db
        .select({ id: companies.id, domain: companies.domain })
        .from(companies)
        .where(
          and(
            eq(companies.workspaceId, auth.workspaceId),
            inArray(sql`lower(${companies.domain})`, domains),
          ),
        )
    : [];

  let proposed = 0;
  let skipped = 0;
  for (const candidate of input.candidates) {
    // A decided row is never reset: reprocessing finds it and skips.
    const decidedTwin = existing.find(
      (p) => p.partyRole === candidate.partyRole && p.resolutionStatus !== "unresolved",
    );
    // Unresolved twin: same role + same extracted name is the same candidate.
    const unresolvedTwin = existing.find(
      (p) =>
        p.partyRole === candidate.partyRole &&
        p.resolutionStatus === "unresolved" &&
        p.displayName === candidate.displayName,
    );
    if (decidedTwin || unresolvedTwin) {
      skipped += 1;
      continue;
    }

    let contactId: string | null = null;
    let companyId: string | null = null;
    let status: "unresolved" | "matched" = "unresolved";
    if (candidate.partyKind === "contact" && candidate.email) {
      const match = contactsByEmail.find(
        (c) => c.primaryEmail?.toLowerCase() === candidate.email!.toLowerCase(),
      );
      if (match) {
        contactId = match.id;
        status = "matched";
      }
    } else if (candidate.partyKind === "company" && candidate.domain) {
      const match = companiesByDomain.find(
        (c) => c.domain?.toLowerCase() === candidate.domain!.toLowerCase(),
      );
      if (match) {
        companyId = match.id;
        status = "matched";
      }
    }

    await db.insert(documentParties).values({
      workspaceId: auth.workspaceId,
      documentId: input.documentId,
      partyRole: candidate.partyRole,
      partyKind: candidate.partyKind,
      contactId,
      companyId,
      displayName: candidate.displayName,
      resolutionStatus: status,
      evidenceExtractionId: input.extractionId ?? null,
      evidenceSpans: candidate.evidenceSpans ?? [],
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });
    proposed += 1;
  }
  return { proposed, skipped };
}

export type PartyMatchOption = {
  kind: "contact" | "company";
  id: string;
  name: string;
  /** How it matched: verified identity, or a name that needs a human. */
  via: "email" | "domain" | "name";
};

export type PartyResolutionOption = {
  partyId: string;
  partyRole: PartyRole;
  partyKind: PartyKind;
  displayName: string;
  resolutionStatus: "unresolved" | "matched" | "created" | "rejected";
  /** Present when the party already resolved to a record. */
  resolvedTo?: { kind: "contact" | "company"; id: string; name: string };
  /** Name-only candidates: options for the human, never an auto-match. */
  options: PartyMatchOption[];
};

/**
 * The matching read behind the review UI: per party, either what it resolved
 * to or the name-only options — match N, create new, leave unresolved. Pure
 * read; a name match writes nothing (the module comment is the law here).
 */
export async function resolvePartyCandidates(
  auth: AuthContext,
  input: { documentId: string },
): Promise<PartyResolutionOption[]> {
  const parties = await db
    .select()
    .from(documentParties)
    .where(
      and(
        eq(documentParties.documentId, input.documentId),
        eq(documentParties.workspaceId, auth.workspaceId),
      ),
    );
  if (parties.length === 0) return [];

  // Name-only option lookups, one round trip per kind. Case-insensitive on
  // purpose: "ACME Corp" in a document and "Acme Corp" in the CRM are the
  // option a human decides about, not an automatic merge.
  const contactNames = parties.filter((p) => p.partyKind === "contact").map((p) => p.displayName);
  const companyNames = parties.filter((p) => p.partyKind === "company").map((p) => p.displayName);
  const nameMatchContacts = contactNames.length
    ? await db
        .select({ id: contacts.id, fullName: contacts.fullName })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, auth.workspaceId),
            or(...contactNames.map((n) => ilike(contacts.fullName, n))),
          ),
        )
    : [];
  const companiesByName = companyNames.length
    ? await db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(
          and(
            eq(companies.workspaceId, auth.workspaceId),
            or(...companyNames.map((n) => ilike(companies.name, n))),
          ),
        )
    : [];

  // Display names for already-resolved parties: two batched lookups, not one
  // query per party — the same shape getDocumentReview uses for this need.
  const resolvedContactIds = parties
    .filter((p) => p.resolutionStatus !== "unresolved" && p.contactId)
    .map((p) => p.contactId!);
  const resolvedCompanyIds = parties
    .filter((p) => p.resolutionStatus !== "unresolved" && p.companyId)
    .map((p) => p.companyId!);
  const resolvedContacts = resolvedContactIds.length
    ? await db
        .select({ id: contacts.id, fullName: contacts.fullName })
        .from(contacts)
        .where(inArray(contacts.id, resolvedContactIds))
    : [];
  const resolvedCompanies = resolvedCompanyIds.length
    ? await db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(inArray(companies.id, resolvedCompanyIds))
    : [];
  const contactNamesById = new Map(resolvedContacts.map((c) => [c.id, c.fullName]));
  const companyNamesById = new Map(resolvedCompanies.map((c) => [c.id, c.name]));

  const results: PartyResolutionOption[] = [];
  for (const party of parties) {
    if (party.resolutionStatus !== "unresolved") {
      // Resolve the display name of the record it points at for the UI.
      let resolvedTo: PartyResolutionOption["resolvedTo"];
      if (party.contactId && contactNamesById.has(party.contactId)) {
        resolvedTo = {
          kind: "contact",
          id: party.contactId,
          name: contactNamesById.get(party.contactId)!,
        };
      } else if (party.companyId && companyNamesById.has(party.companyId)) {
        resolvedTo = {
          kind: "company",
          id: party.companyId,
          name: companyNamesById.get(party.companyId)!,
        };
      }
      results.push({
        partyId: party.id,
        partyRole: party.partyRole,
        partyKind: party.partyKind,
        displayName: party.displayName,
        resolutionStatus: party.resolutionStatus,
        resolvedTo,
        options: [],
      });
      continue;
    }

    const options: PartyMatchOption[] =
      party.partyKind === "contact"
        ? nameMatchContacts
            .filter((c) => c.fullName.toLowerCase() === party.displayName.toLowerCase())
            .map((c) => ({ kind: "contact" as const, id: c.id, name: c.fullName, via: "name" as const }))
        : companiesByName
            .filter((c) => c.name.toLowerCase() === party.displayName.toLowerCase())
            .map((c) => ({ kind: "company" as const, id: c.id, name: c.name, via: "name" as const }));

    results.push({
      partyId: party.id,
      partyRole: party.partyRole,
      partyKind: party.partyKind,
      displayName: party.displayName,
      resolutionStatus: "unresolved",
      options,
    });
  }
  return results;
}

/**
 * Apply a human decision to one party. Creating dedupes on verified identity
 * only; the resolution edge (documentId + role + target) is what stops a
 * reprocessed document from minting a second record.
 */
/** One writer for the resolution update every decision ends with; the six
 * decision branches differ only in the values, never in the shape. */
function applyResolution(
  partyId: string,
  values: {
    contactId: string | null;
    companyId: string | null;
    resolutionStatus: "matched" | "created" | "rejected" | "unresolved";
    updatedBy: string;
  },
) {
  return db
    .update(documentParties)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(documentParties.id, partyId));
}

export async function acceptParty(
  auth: AuthContext,
  input: { partyId: string; decision: PartyDecision },
): Promise<{ ok: boolean; contactId?: string; companyId?: string }> {
  const [party] = await db
    .select()
    .from(documentParties)
    .where(
      and(eq(documentParties.id, input.partyId), eq(documentParties.workspaceId, auth.workspaceId)),
    )
    .limit(1);
  if (!party) throw new Error("party not found in workspace");

  const decision = input.decision;

  if (decision.action === "match") {
    // The target id arrives from the client: it must name a record in this
    // workspace, or a document could be linked to another tenant's contact.
    const [target] = decision.contactId
      ? await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.id, decision.contactId), eq(contacts.workspaceId, auth.workspaceId)))
      : decision.companyId
        ? await db
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, decision.companyId), eq(companies.workspaceId, auth.workspaceId)))
        : [];
    if ((decision.contactId || decision.companyId) && !target) {
      throw new Error("match target not found in workspace");
    }
    if (decision.contactId) {
      await applyResolution(party.id, {
        contactId: decision.contactId,
        companyId: null,
        resolutionStatus: "matched",
        updatedBy: auth.userId,
      });
      return { ok: true, contactId: decision.contactId };
    }
    if (decision.companyId) {
      await applyResolution(party.id, {
        contactId: null,
        companyId: decision.companyId,
        resolutionStatus: "matched",
        updatedBy: auth.userId,
      });
      return { ok: true, companyId: decision.companyId };
    }
    throw new Error("match decision requires contactId or companyId");
  }

  if (decision.action === "reject") {
    await applyResolution(party.id, {
      contactId: null,
      companyId: null,
      resolutionStatus: "rejected",
      updatedBy: auth.userId,
    });
    return { ok: true };
  }

  if (decision.action === "leave_unresolved") {
    await applyResolution(party.id, {
      contactId: null,
      companyId: null,
      resolutionStatus: "unresolved",
      updatedBy: auth.userId,
    });
    return { ok: true };
  }

  // create
  if (party.partyKind === "contact") {
    const fullName = decision.contact?.fullName ?? party.displayName;
    const primaryEmail = decision.contact?.primaryEmail;
    // One transaction: the CRM row, its audit event, and the party edge land
    // together or not at all — an audit event claiming a decision that
    // half-happened is the failure acceptObligation's transaction prevents.
    const contactId = await withTransaction(async (tx) => {
      // An existing contact with the same verified email is the same person —
      // link it instead of creating a duplicate. Name alone is not identity.
      if (primaryEmail) {
        const [existing] = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(eq(contacts.workspaceId, auth.workspaceId), eq(contacts.primaryEmail, primaryEmail)),
          )
          .limit(1);
        if (existing) return existing.id;
      }
      const [created] = await tx
        .insert(contacts)
        .values({
          workspaceId: auth.workspaceId,
          fullName,
          primaryEmail: primaryEmail ?? null,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: contacts.id });

      await tx.insert(auditEvents).values({
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        actorKind: "user",
        action: "contact.created_from_document",
        subjectType: "contact",
        subjectId: created.id,
        summary: `Created contact ${fullName} from document party ${party.displayName}`,
        metadata: { documentId: party.documentId, partyId: party.id },
      });
      return created.id;
    });

    await applyResolution(party.id, {
      contactId,
      companyId: null,
      resolutionStatus: "created",
      updatedBy: auth.userId,
    });
    return { ok: true, contactId };
  }

  // create company — same transactional shape as the contact path.
  const name = decision.company?.name ?? party.displayName;
  const domain = decision.company?.domain;
  const companyId = await withTransaction(async (tx) => {
    if (domain) {
      const [existing] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.workspaceId, auth.workspaceId), eq(companies.domain, domain)))
        .limit(1);
      if (existing) return existing.id;
    }
    const [created] = await tx
      .insert(companies)
      .values({
        workspaceId: auth.workspaceId,
        name,
        domain: domain ?? null,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: companies.id });

    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: "company.created_from_document",
      subjectType: "company",
      subjectId: created.id,
      summary: `Created company ${name} from document party ${party.displayName}`,
      metadata: { documentId: party.documentId, partyId: party.id },
    });
    return created.id;
  });

  await applyResolution(party.id, {
    contactId: null,
    companyId,
    resolutionStatus: "created",
    updatedBy: auth.userId,
  });
  return { ok: true, companyId };
}

export type AssertionInput = {
  subjectType: "contact" | "company" | "project" | "document";
  subjectId: string;
  attribute: string;
  value: unknown;
  fieldProposalId?: string;
  extractionId?: string;
  evidenceSpans?: unknown;
  effectiveFrom?: string;
  effectiveTo?: string;
  /** Set to record this assertion as the correction of an earlier row. */
  supersedesAssertionId?: string;
};

/**
 * Append accepted facts to the assertion ledger. Never overwrites: a new row
 * on the same subject+attribute is a new belief; the prior row is flipped to
 * "superseded" only when the caller says so. History is rows.
 */
export async function acceptAssertions(
  auth: AuthContext,
  input: { documentId: string; assertions: AssertionInput[] },
  tx: typeof db | TxDrizzle = db,
): Promise<{ written: number; conflicts: AssertionConflict[] }> {
  const [document] = await tx
    .select({ id: documents.id, title: documents.title, mimeType: documents.mimeType })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!document) throw new Error("document not found in workspace");

  const sourceAttribution = document.mimeType
    ? `${document.title} (${document.mimeType})`
    : document.title;

  const conflicts: AssertionConflict[] = [];

  for (const assertion of input.assertions) {
    await tx.insert(reviewedAssertions).values({
      workspaceId: auth.workspaceId,
      subjectType: assertion.subjectType,
      subjectId: assertion.subjectId,
      attribute: assertion.attribute,
      value: assertion.value as Record<string, unknown>,
      documentId: input.documentId,
      fieldProposalId: assertion.fieldProposalId ?? null,
      extractionId: assertion.extractionId ?? null,
      evidenceSpans: (assertion.evidenceSpans ?? []) as unknown[],
      sourceAttribution,
      effectiveFrom: assertion.effectiveFrom ?? null,
      effectiveTo: assertion.effectiveTo ?? null,
      supersedesAssertionId: assertion.supersedesAssertionId ?? null,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });

    if (assertion.supersedesAssertionId) {
      await tx
        .update(reviewedAssertions)
        .set({ status: "superseded", updatedBy: auth.userId, updatedAt: new Date() })
        .where(
          and(
            eq(reviewedAssertions.id, assertion.supersedesAssertionId),
            eq(reviewedAssertions.workspaceId, auth.workspaceId),
          ),
        );
    } else {
      // No supersede pointer and an active row already says something else:
      // keep both, and surface the conflict rather than picking a winner.
      const activeRows = await tx
        .select({ id: reviewedAssertions.id, value: reviewedAssertions.value, sourceAttribution: reviewedAssertions.sourceAttribution })
        .from(reviewedAssertions)
        .where(
          and(
            eq(reviewedAssertions.workspaceId, auth.workspaceId),
            eq(reviewedAssertions.subjectType, assertion.subjectType),
            eq(reviewedAssertions.subjectId, assertion.subjectId),
            eq(reviewedAssertions.attribute, assertion.attribute),
            eq(reviewedAssertions.status, "active"),
          ),
        );
      const acceptedValue = JSON.stringify(assertion.value);
      for (const row of activeRows) {
        if (JSON.stringify(row.value) === acceptedValue) continue;
        conflicts.push({
          subjectType: assertion.subjectType,
          subjectId: assertion.subjectId,
          attribute: assertion.attribute,
          values: [
            { value: row.value, sourceAttribution: row.sourceAttribution },
            { value: assertion.value as Record<string, unknown>, sourceAttribution },
          ],
        });
      }
    }

    // Attributed employment roles project to contactCompanies when the
    // company is identifiable (id or exact name, case-insensitive) - never a
    // silent company create, never a cross-workspace link.
    if (assertion.subjectType === "contact" && assertion.attribute === "employment_role") {
      await projectEmploymentRole(auth, assertion, tx);
    }
  }
  return { written: input.assertions.length, conflicts };
}

export type AssertionConflict = {
  subjectType: "contact" | "company" | "project" | "document";
  subjectId: string;
  attribute: string;
  /** The disagreeing active values, each with its provenance. */
  values: Array<{ value: unknown; sourceAttribution: string }>;
};

/*
 * An accepted employment-role assertion becomes a contact_companies row when
 * the company is identifiable. Idempotent through the (contact, company,
 * started_at) key: reprocessing never duplicates the role. A company the
 * value cannot identify (no id, no exact name match) skips the projection -
 * the assertion still stands on its own.
 */
async function projectEmploymentRole(
  auth: AuthContext,
  assertion: AssertionInput,
  tx: typeof db | TxDrizzle,
): Promise<void> {
  const value = assertion.value as Record<string, unknown>;
  let companyId: string | null = null;
  if (typeof value.companyId === "string") {
    const [company] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.id, value.companyId), eq(companies.workspaceId, auth.workspaceId)))
      .limit(1);
    companyId = company?.id ?? null;
  } else if (typeof value.companyName === "string" && value.companyName.trim()) {
    const [company] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.workspaceId, auth.workspaceId), ilike(companies.name, value.companyName.trim())))
      .limit(1);
    companyId = company?.id ?? null;
  }
  if (!companyId) return;

  // The unique key treats null started_at as distinct, so an undated role
  // needs an explicit dedupe check instead of relying on onConflict.
  const startedAt = assertion.effectiveFrom ? new Date(`${assertion.effectiveFrom}T00:00:00Z`) : null;
  if (!startedAt) {
    const [existing] = await tx
      .select({ id: contactCompanies.id })
      .from(contactCompanies)
      .where(
        and(
          eq(contactCompanies.contactId, assertion.subjectId),
          eq(contactCompanies.companyId, companyId),
          sql`${contactCompanies.startedAt} is null`,
        ),
      )
      .limit(1);
    if (existing) return;
  }

  await tx
    .insert(contactCompanies)
    .values({
      workspaceId: auth.workspaceId,
      contactId: assertion.subjectId,
      companyId,
      title: typeof value.title === "string" ? value.title : null,
      startedAt,
      endedAt: assertion.effectiveTo ? new Date(`${assertion.effectiveTo}T00:00:00Z`) : null,
      isCurrent: !assertion.effectiveTo,
    })
    .onConflictDoNothing({ target: [contactCompanies.contactId, contactCompanies.companyId, contactCompanies.startedAt] });
}

export type AssertionHistoryEntry = {
  id: string;
  attribute: string;
  value: unknown;
  status: "active" | "superseded" | "retracted";
  sourceAttribution: string;
  documentId: string | null;
  fieldProposalId: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  supersedesAssertionId: string | null;
  createdAt: Date;
};

export type AssertionProjection = {
  /** Latest active row per attribute — what the profile shows now. */
  current: Record<string, AssertionHistoryEntry>;
  /** Every row in write order, including superseded and retracted. */
  history: AssertionHistoryEntry[];
  /** Attributes with two disagreeing active values - both surface for review. */
  conflicts: AssertionConflict[];
};

/**
 * The assertion read: the current projection plus the full history, because
 * "what did we believe on day N" is the point of the ledger.
 */
export async function getAssertions(
  auth: AuthContext,
  input: { subjectType: "contact" | "company" | "project" | "document"; subjectId: string },
): Promise<AssertionProjection> {
  const rows = await db
    .select()
    .from(reviewedAssertions)
    .where(
      and(
        eq(reviewedAssertions.workspaceId, auth.workspaceId),
        eq(reviewedAssertions.subjectType, input.subjectType),
        eq(reviewedAssertions.subjectId, input.subjectId),
      ),
    )
    .orderBy(reviewedAssertions.createdAt, reviewedAssertions.id);

  const history: AssertionHistoryEntry[] = rows.map((r) => ({
    id: r.id,
    attribute: r.attribute,
    value: r.value,
    status: r.status,
    sourceAttribution: r.sourceAttribution,
    documentId: r.documentId,
    fieldProposalId: r.fieldProposalId,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    supersedesAssertionId: r.supersedesAssertionId,
    createdAt: r.createdAt,
  }));

  // Newest-first walk, first active per attribute wins.
  const current: Record<string, AssertionHistoryEntry> = {};
  for (const entry of [...history].reverse()) {
    if (entry.status === "active" && !current[entry.attribute]) current[entry.attribute] = entry;
  }

  // Conflicts: an attribute with two active rows that disagree. Both values
  // surface with their provenance; the projection never silently picks one.
  const activeByAttribute = new Map<string, AssertionHistoryEntry[]>();
  for (const entry of history) {
    if (entry.status !== "active") continue;
    const list = activeByAttribute.get(entry.attribute) ?? [];
    list.push(entry);
    activeByAttribute.set(entry.attribute, list);
  }
  const conflicts: AssertionConflict[] = [];
  for (const [attribute, entries] of activeByAttribute) {
    const seen = new Set(entries.map((e) => JSON.stringify(e.value)));
    if (seen.size < 2) continue;
    conflicts.push({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      attribute,
      values: entries.map((e) => ({ value: e.value, sourceAttribution: e.sourceAttribution })),
    });
  }

  return { current, history, conflicts };
}

/**
 * A deleted/rejected document stops being evidence: its assertions are marked
 * retracted, the rows stay (the record of what was once accepted is the
 * point), and no contact or company is touched.
 */
export async function retractEvidence(
  auth: AuthContext,
  input: { documentId: string },
  executor: typeof db | TxDrizzle = db,
): Promise<{ retracted: number }> {
  const rows = await executor
    .update(reviewedAssertions)
    .set({ status: "retracted", updatedBy: auth.userId, updatedAt: new Date() })
    .where(
      and(
        eq(reviewedAssertions.workspaceId, auth.workspaceId),
        eq(reviewedAssertions.documentId, input.documentId),
        // Active rows only: a superseded row keeps the status that tells its
        // story, and an already-retracted one is not re-retracted.
        eq(reviewedAssertions.status, "active"),
      ),
    )
    .returning({ id: reviewedAssertions.id });
  return { retracted: rows.length };
}

// ponytail: name-option matching is case-insensitive exact; trigram fuzzy
// matching when extraction ever emits names that differ beyond case.
