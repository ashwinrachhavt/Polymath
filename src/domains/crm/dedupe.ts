import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { eventAttendees } from "@/domains/calendar/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { documentExportManifests, documentParties } from "@/domains/knowledge/schema";
import { db } from "@/lib/db";
import { opportunities, opportunityLinks } from "@/domains/opportunities/schema";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import {
  companies,
  contactCompanies,
  contactObservations,
  contacts,
  correspondence,
  followUps,
} from "./schema";
import { NotFoundError, StaleWriteError } from "./commands";

/*
 * C01 dedupe controls. The unique indexes stop exact duplicates at write
 * time, but case variants, phone formatting and re-typed names still produce
 * doubles. These controls find candidate pairs and merge them the way the
 * schema says identity resolution must work: everything that pointed at the
 * loser is re-pointed at the winner inside one transaction, the loser is
 * archived (never deleted — history stays), and both sides get an audit row.
 * Merging is always the owner's explicit click; nothing here auto-merges.
 */

export type DuplicateCandidate = {
  id: string;
  label: string;
  detail: string | null;
  version: number;
  updatedAt: Date;
};

export type DuplicateGroup = {
  reason: string;
  rows: DuplicateCandidate[];
};

const normalizePhone = (value: string | null) => (value ?? "").replace(/\D/g, "");
const normalizeText = (value: string | null) => (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Group rows that share a normalized key; a group of one is not a duplicate. */
function groupBy(keys: Map<string, DuplicateCandidate[]>, reason: string): DuplicateGroup[] {
  return [...keys.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([, rows]) => ({ reason, rows: rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()) }));
}

export async function findContactDuplicates(auth: AuthContext): Promise<DuplicateGroup[]> {
  const rows = await db_selectContacts(auth);
  const byEmail = new Map<string, DuplicateCandidate[]>();
  const byPhone = new Map<string, DuplicateCandidate[]>();
  const byName = new Map<string, DuplicateCandidate[]>();
  for (const row of rows) {
    const candidate: DuplicateCandidate = {
      id: row.id,
      label: row.fullName,
      detail: row.primaryEmail ?? row.phone,
      version: row.version,
      updatedAt: row.updatedAt,
    };
    const email = normalizeText(row.primaryEmail);
    const phone = normalizePhone(row.phone);
    const name = normalizeText(row.fullName);
    if (email) byEmail.set(email, [...(byEmail.get(email) ?? []), candidate]);
    if (phone.length >= 7) byPhone.set(phone, [...(byPhone.get(phone) ?? []), candidate]);
    if (name) byName.set(name, [...(byName.get(name) ?? []), candidate]);
  }
  // One row can appear under several reasons; dedupe identical pairings by id set.
  const seen = new Set<string>();
  const groups: DuplicateGroup[] = [];
  for (const group of [...groupBy(byEmail, "Same email (different case)"), ...groupBy(byPhone, "Same phone number"), ...groupBy(byName, "Same name")]) {
    const key = group.rows.map((row) => row.id).sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(group);
  }
  return groups;
}

// Kept as a named helper so the query shape stays next to listContacts' rules:
// non-archived rows in this tenant only, bounded like the list surface.
async function db_selectContacts(auth: AuthContext) {
  return db
    .select({ id: contacts.id, fullName: contacts.fullName, primaryEmail: contacts.primaryEmail, phone: contacts.phone, version: contacts.version, updatedAt: contacts.updatedAt })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, auth.workspaceId), isNull(contacts.archivedAt)))
    .limit(5000);
}

export async function findCompanyDuplicates(auth: AuthContext): Promise<DuplicateGroup[]> {
  const rows = await db
    .select({ id: companies.id, name: companies.name, domain: companies.domain, version: companies.version, updatedAt: companies.updatedAt })
    .from(companies)
    .where(and(eq(companies.workspaceId, auth.workspaceId), isNull(companies.archivedAt)))
    .limit(5000);
  const byDomain = new Map<string, DuplicateCandidate[]>();
  const byName = new Map<string, DuplicateCandidate[]>();
  for (const row of rows) {
    const candidate: DuplicateCandidate = {
      id: row.id,
      label: row.name,
      detail: row.domain,
      version: row.version,
      updatedAt: row.updatedAt,
    };
    const domain = normalizeText(row.domain).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    const name = normalizeText(row.name);
    if (domain) byDomain.set(domain, [...(byDomain.get(domain) ?? []), candidate]);
    if (name) byName.set(name, [...(byName.get(name) ?? []), candidate]);
  }
  const seen = new Set<string>();
  const groups: DuplicateGroup[] = [];
  for (const group of [...groupBy(byDomain, "Same domain"), ...groupBy(byName, "Same name")]) {
    const key = group.rows.map((row) => row.id).sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(group);
  }
  return groups;
}

async function loadPair(
  tx: TxDrizzle,
  auth: AuthContext,
  sourceId: string,
  targetId: string,
) {
  if (sourceId === targetId) throw new StaleWriteError("A record cannot be merged into itself.");
  const rows = await tx
    .select({ id: contacts.id, fullName: contacts.fullName })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, auth.workspaceId), isNull(contacts.archivedAt), sql`${contacts.id} in (${sourceId}, ${targetId})`));
  const source = rows.find((row) => row.id === sourceId);
  const target = rows.find((row) => row.id === targetId);
  if (!source || !target) throw new NotFoundError("One of those contacts is not in this workspace.");
  return { source, target };
}

/*
 * Re-point a child row at the merge winner, except where a unique edge already
 * names the winner — there the loser's edge is a true double and goes away.
 * `edge` returns the conflict predicate for the row being considered.
 */
async function repointContactEdges(tx: TxDrizzle, auth: AuthContext, sourceId: string, targetId: string) {
  await tx
    .update(contactCompanies)
    .set({ contactId: targetId })
    .where(and(eq(contactCompanies.workspaceId, auth.workspaceId), eq(contactCompanies.contactId, sourceId)));
  // Collapse any (contact, company, startedAt) doubles the re-point created.
  await tx.execute(sql`
    delete from contact_companies a
    using contact_companies b
    where a.workspace_id = ${auth.workspaceId}
      and a.contact_id = ${targetId}
      and a.contact_id = b.contact_id
      and a.company_id = b.company_id
      and a.started_at is not distinct from b.started_at
      and a.created_at > b.created_at`);
  await tx.update(contactObservations).set({ contactId: targetId }).where(and(eq(contactObservations.workspaceId, auth.workspaceId), eq(contactObservations.contactId, sourceId)));
  await tx.update(correspondence).set({ contactId: targetId }).where(and(eq(correspondence.workspaceId, auth.workspaceId), eq(correspondence.contactId, sourceId)));
  await tx.update(followUps).set({ contactId: targetId }).where(and(eq(followUps.workspaceId, auth.workspaceId), eq(followUps.contactId, sourceId)));
  await tx.update(opportunities).set({ primaryContactId: targetId }).where(and(eq(opportunities.workspaceId, auth.workspaceId), eq(opportunities.primaryContactId, sourceId)));
  await tx.update(eventAttendees).set({ contactId: targetId }).where(and(eq(eventAttendees.workspaceId, auth.workspaceId), eq(eventAttendees.contactId, sourceId)));
  await tx.update(documentExportManifests).set({ contactId: targetId }).where(and(eq(documentExportManifests.workspaceId, auth.workspaceId), eq(documentExportManifests.contactId, sourceId)));
  // Unique-edged targets: drop the loser's row when the winner already has it.
  await tx.execute(sql`
    delete from document_parties a
    using document_parties b
    where a.workspace_id = ${auth.workspaceId} and a.contact_id = ${sourceId}
      and b.workspace_id = a.workspace_id and b.document_id = a.document_id
      and b.party_role = a.party_role and b.contact_id = ${targetId}`);
  await tx.update(documentParties).set({ contactId: targetId }).where(and(eq(documentParties.workspaceId, auth.workspaceId), eq(documentParties.contactId, sourceId)));
  await tx.execute(sql`
    delete from opportunity_links a
    using opportunity_links b
    where a.workspace_id = ${auth.workspaceId} and a.target_type = 'contact' and a.target_id = ${sourceId}
      and b.workspace_id = a.workspace_id and b.opportunity_id = a.opportunity_id
      and b.target_type = 'contact' and b.target_id = ${targetId}`);
  await tx
    .update(opportunityLinks)
    .set({ targetId })
    .where(and(eq(opportunityLinks.workspaceId, auth.workspaceId), eq(opportunityLinks.targetType, "contact"), eq(opportunityLinks.targetId, sourceId)));
}

export async function mergeContacts(
  auth: AuthContext,
  input: { sourceId: string; targetId: string; expectedTargetVersion: number },
) {
  return withTransaction(async (tx) => {
    const { source, target } = await loadPair(tx, auth, input.sourceId, input.targetId);
    await repointContactEdges(tx, auth, input.sourceId, input.targetId);
    // Claim the winner at the rendered version and archive the loser; both in
    // the same transaction, so a merge can never half-land.
    const [claimed] = await tx
      .update(contacts)
      .set({ version: sql`${contacts.version} + 1`, updatedAt: new Date(), updatedBy: auth.userId })
      .where(and(eq(contacts.id, input.targetId), eq(contacts.workspaceId, auth.workspaceId), isNull(contacts.archivedAt), eq(contacts.version, input.expectedTargetVersion)))
      .returning({ id: contacts.id });
    if (!claimed) throw new StaleWriteError("The contact you are merging into changed since you loaded it. Reload and try again.");
    await tx
      .update(contacts)
      .set({ archivedAt: new Date(), version: sql`${contacts.version} + 1`, updatedAt: new Date(), updatedBy: auth.userId })
      .where(and(eq(contacts.id, input.sourceId), eq(contacts.workspaceId, auth.workspaceId)));
    await recordAudit(auth, {
      action: "contact.merged",
      subjectType: "contact",
      subjectId: input.targetId,
      summary: `Contact merged: ${source.fullName} was merged into ${target.fullName}; the duplicate is archived, its history re-pointed`,
      metadata: { sourceId: input.sourceId },
    }, tx);
    return { merged: source.fullName, into: target.fullName };
  });
}

export async function mergeCompanies(
  auth: AuthContext,
  input: { sourceId: string; targetId: string; expectedTargetVersion: number },
) {
  return withTransaction(async (tx) => {
    if (input.sourceId === input.targetId) throw new StaleWriteError("A record cannot be merged into itself.");
    const rows = await tx
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(and(eq(companies.workspaceId, auth.workspaceId), isNull(companies.archivedAt), sql`${companies.id} in (${input.sourceId}, ${input.targetId})`));
    const source = rows.find((row) => row.id === input.sourceId);
    const target = rows.find((row) => row.id === input.targetId);
    if (!source || !target) throw new NotFoundError("One of those companies is not in this workspace.");

    await tx.update(contactCompanies).set({ companyId: input.targetId }).where(and(eq(contactCompanies.workspaceId, auth.workspaceId), eq(contactCompanies.companyId, input.sourceId)));
    await tx.execute(sql`
      delete from contact_companies a
      using contact_companies b
      where a.workspace_id = ${auth.workspaceId}
        and a.company_id = ${input.targetId}
        and a.contact_id = b.contact_id
        and a.company_id = b.company_id
        and a.started_at is not distinct from b.started_at
        and a.created_at > b.created_at`);
    await tx.update(correspondence).set({ companyId: input.targetId }).where(and(eq(correspondence.workspaceId, auth.workspaceId), eq(correspondence.companyId, input.sourceId)));
    await tx.update(followUps).set({ companyId: input.targetId }).where(and(eq(followUps.workspaceId, auth.workspaceId), eq(followUps.companyId, input.sourceId)));
    await tx.update(opportunities).set({ companyId: input.targetId }).where(and(eq(opportunities.workspaceId, auth.workspaceId), eq(opportunities.companyId, input.sourceId)));
    await tx.update(documentExportManifests).set({ companyId: input.targetId }).where(and(eq(documentExportManifests.workspaceId, auth.workspaceId), eq(documentExportManifests.companyId, input.sourceId)));
    await tx.execute(sql`
      delete from document_parties a
      using document_parties b
      where a.workspace_id = ${auth.workspaceId} and a.company_id = ${input.sourceId}
        and b.workspace_id = a.workspace_id and b.document_id = a.document_id
        and b.party_role = a.party_role and b.company_id = ${input.targetId}`);
    await tx.update(documentParties).set({ companyId: input.targetId }).where(and(eq(documentParties.workspaceId, auth.workspaceId), eq(documentParties.companyId, input.sourceId)));
    await tx.execute(sql`
      delete from opportunity_links a
      using opportunity_links b
      where a.workspace_id = ${auth.workspaceId} and a.target_type = 'company' and a.target_id = ${input.sourceId}
        and b.workspace_id = a.workspace_id and b.opportunity_id = a.opportunity_id
        and b.target_type = 'company' and b.target_id = ${input.targetId}`);
    await tx
      .update(opportunityLinks)
      .set({ targetId: input.targetId })
      .where(and(eq(opportunityLinks.workspaceId, auth.workspaceId), eq(opportunityLinks.targetType, "company"), eq(opportunityLinks.targetId, input.sourceId)));

    const [claimed] = await tx
      .update(companies)
      .set({ version: sql`${companies.version} + 1`, updatedAt: new Date(), updatedBy: auth.userId })
      .where(and(eq(companies.id, input.targetId), eq(companies.workspaceId, auth.workspaceId), isNull(companies.archivedAt), eq(companies.version, input.expectedTargetVersion)))
      .returning({ id: companies.id });
    if (!claimed) throw new StaleWriteError("The company you are merging into changed since you loaded it. Reload and try again.");
    await tx
      .update(companies)
      .set({ archivedAt: new Date(), version: sql`${companies.version} + 1`, updatedAt: new Date(), updatedBy: auth.userId })
      .where(and(eq(companies.id, input.sourceId), eq(companies.workspaceId, auth.workspaceId)));
    await recordAudit(auth, {
      action: "company.merged",
      subjectType: "company",
      subjectId: input.targetId,
      summary: `Company merged: ${source.name} was merged into ${target.name}; the duplicate is archived, its history re-pointed`,
      metadata: { sourceId: input.sourceId },
    }, tx);
    return { merged: source.name, into: target.name };
  });
}
