import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import {
  companies,
  contactCompanies,
  contactObservations,
  contacts,
  followUps,
} from "./schema";
import { RELATIONSHIP_STATUSES, type RelationshipStatus } from "./status";

export { RELATIONSHIP_STATUSES };
export type { RelationshipStatus };

/*
 * Read queries for the relationships surface. The page composes exactly these
 * — it never joins CRM tables itself (agents/engineering.md). Company names
 * and open follow-up counts ride along as subqueries so the list stays one
 * round trip instead of one per row.
 */

/* Qualified table names are written literally inside the correlated
 * subqueries: drizzle renders ${table.column} there as an unqualified "id",
 * which binds to the subquery's own table instead of the outer one. */

/** LIKE metacharacters in a search box are literal text, not patterns. */
function escapeLike(value: string) {
  return value.replace(/[%_\\]/g, (match) => `\\${match}`);
}

export type ContactListItem = {
  id: string;
  fullName: string;
  primaryEmail: string | null;
  title: string | null;
  relationshipStatus: RelationshipStatus;
  currentCompanyName: string | null;
  openFollowUps: number;
  version: number;
  updatedAt: Date;
};

export const CONTACT_PAGE_SIZE = 100;

export async function listContacts(
  auth: AuthContext,
  input: { query?: string; status?: RelationshipStatus; offset?: number; limit?: number } = {},
): Promise<{ items: ContactListItem[]; total: number }> {
  const filters = [eq(contacts.workspaceId, auth.workspaceId), isNull(contacts.archivedAt)];
  if (input.status) filters.push(eq(contacts.relationshipStatus, input.status));
  if (input.query?.trim()) {
    const like = `%${escapeLike(input.query.trim())}%`;
    filters.push(or(ilike(contacts.fullName, like), ilike(contacts.primaryEmail, like))!);
  }
  const where = and(...filters);

  const [items, [totalRow]] = await Promise.all([
    db
      .select({
        id: contacts.id,
        fullName: contacts.fullName,
        primaryEmail: contacts.primaryEmail,
        title: contacts.title,
        relationshipStatus: contacts.relationshipStatus,
        currentCompanyName: sql<string | null>`(
          select c.name from ${companies} c
          join ${contactCompanies} cc on cc.company_id = c.id and cc.workspace_id = ${auth.workspaceId}
          where cc.contact_id = "contacts"."id" and cc.is_current
          order by cc.created_at desc limit 1
        )`.as("current_company_name"),
        openFollowUps: sql<number>`(
          select count(*)::int from ${followUps} f
          where f.contact_id = "contacts"."id" and f.workspace_id = ${auth.workspaceId} and f.status = 'open'
        )`.as("open_follow_ups"),
        version: contacts.version,
        updatedAt: contacts.updatedAt,
      })
      .from(contacts)
      .where(where)
      .orderBy(asc(contacts.fullName), asc(contacts.id))
      .limit(input.limit ?? CONTACT_PAGE_SIZE)
      .offset(input.offset ?? 0),
    db.select({ total: count() }).from(contacts).where(where),
  ]);
  return { items, total: totalRow?.total ?? 0 };
}

export type ContactDetail = {
  contact: typeof contacts.$inferSelect;
  companies: Array<{
    linkId: string;
    companyId: string;
    name: string;
    title: string | null;
    isCurrent: boolean;
    startedAt: Date | null;
    endedAt: Date | null;
  }>;
  observations: Array<typeof contactObservations.$inferSelect>;
  followUps: Array<typeof followUps.$inferSelect>;
};

/** Detail reads are bounded and parallel; none depends on another's rows. */
export async function getContactDetail(
  auth: AuthContext,
  input: { contactId: string },
): Promise<ContactDetail | null> {
  const [contact] = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.id, input.contactId),
        eq(contacts.workspaceId, auth.workspaceId),
        isNull(contacts.archivedAt),
      ),
    )
    .limit(1);
  if (!contact) return null;

  const [companyRows, observationRows, followUpRows] = await Promise.all([
    db
      .select({
        linkId: contactCompanies.id,
        companyId: companies.id,
        name: companies.name,
        title: contactCompanies.title,
        isCurrent: contactCompanies.isCurrent,
        startedAt: contactCompanies.startedAt,
        endedAt: contactCompanies.endedAt,
      })
      .from(contactCompanies)
      .innerJoin(companies, eq(companies.id, contactCompanies.companyId))
      .where(
        and(
          eq(contactCompanies.contactId, contact.id),
          eq(contactCompanies.workspaceId, auth.workspaceId),
        ),
      )
      .orderBy(desc(contactCompanies.isCurrent), desc(contactCompanies.createdAt)),
    db
      .select()
      .from(contactObservations)
      .where(
        and(
          eq(contactObservations.contactId, contact.id),
          eq(contactObservations.workspaceId, auth.workspaceId),
        ),
      )
      .orderBy(desc(contactObservations.observedAt))
      .limit(50),
    db
      .select()
      .from(followUps)
      .where(and(eq(followUps.contactId, contact.id), eq(followUps.workspaceId, auth.workspaceId)))
      .orderBy(asc(followUps.status), asc(followUps.dueAt))
      .limit(50),
  ]);

  return { contact, companies: companyRows, observations: observationRows, followUps: followUpRows };
}

export type CompanyListItem = {
  id: string;
  name: string;
  domain: string | null;
  description: string | null;
  contactCount: number;
  version: number;
};

export async function listCompanies(
  auth: AuthContext,
  input: { query?: string } = {},
): Promise<CompanyListItem[]> {
  const filters = [eq(companies.workspaceId, auth.workspaceId), isNull(companies.archivedAt)];
  if (input.query?.trim()) {
    const like = `%${escapeLike(input.query.trim())}%`;
    filters.push(or(ilike(companies.name, like), ilike(companies.domain, like))!);
  }
  return db
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      description: companies.description,
      contactCount: sql<number>`(
        select count(*)::int from ${contactCompanies} cc
        where cc.company_id = "companies"."id" and cc.workspace_id = ${auth.workspaceId} and cc.is_current
      )`.as("contact_count"),
      version: companies.version,
    })
    .from(companies)
    .where(and(...filters))
    .orderBy(asc(companies.name))
    .limit(CONTACT_PAGE_SIZE);
}

/** One page of companies for the list, with the unpaged total for the pager. */
export async function pageCompanies(
  auth: AuthContext,
  input: { limit: number; offset: number },
): Promise<{ items: CompanyListItem[]; total: number }> {
  const where = and(eq(companies.workspaceId, auth.workspaceId), isNull(companies.archivedAt));
  const [items, [totalRow]] = await Promise.all([
    db
      .select({
        id: companies.id,
        name: companies.name,
        domain: companies.domain,
        description: companies.description,
        contactCount: sql<number>`(
          select count(*)::int from ${contactCompanies} cc
          where cc.company_id = "companies"."id" and cc.workspace_id = ${auth.workspaceId} and cc.is_current
        )`.as("contact_count"),
        version: companies.version,
      })
      .from(companies)
      .where(where)
      .orderBy(asc(companies.name), asc(companies.id))
      .limit(input.limit)
      .offset(input.offset),
    db.select({ total: count() }).from(companies).where(where),
  ]);
  return { items, total: totalRow?.total ?? 0 };
}

export type CompanyDetail = {
  company: typeof companies.$inferSelect;
  contacts: Array<{
    linkId: string;
    contactId: string;
    fullName: string;
    title: string | null;
    isCurrent: boolean;
  }>;
};

/** The company profile read: the record plus its linked contacts, current roles first. */
export async function getCompanyDetail(
  auth: AuthContext,
  input: { companyId: string },
): Promise<CompanyDetail | null> {
  const [company] = await db
    .select()
    .from(companies)
    .where(
      and(
        eq(companies.id, input.companyId),
        eq(companies.workspaceId, auth.workspaceId),
        isNull(companies.archivedAt),
      ),
    )
    .limit(1);
  if (!company) return null;

  const contactRows = await db
    .select({
      linkId: contactCompanies.id,
      contactId: contacts.id,
      fullName: contacts.fullName,
      title: contactCompanies.title,
      isCurrent: contactCompanies.isCurrent,
    })
    .from(contactCompanies)
    .innerJoin(contacts, and(eq(contacts.id, contactCompanies.contactId), isNull(contacts.archivedAt)))
    .where(
      and(
        eq(contactCompanies.companyId, company.id),
        eq(contactCompanies.workspaceId, auth.workspaceId),
      ),
    )
    .orderBy(desc(contactCompanies.isCurrent), asc(contacts.fullName))
    .limit(50);

  return { company, contacts: contactRows };
}

/*
 * Read-side seam for other domains: the relationship status a CRM contact
 * carries, keyed by the contact's primary email. The People surface joins on
 * this — email is the one key both domains already agree on (ASH-135 owns the
 * eventual merge). Returns only what the caller needs; nothing here writes.
 */
export async function listContactStatusesByEmail(
  auth: AuthContext,
  emails: string[],
): Promise<Map<string, { id: string; relationshipStatus: RelationshipStatus }>> {
  const addresses = [...new Set(emails.filter(Boolean))];
  const byEmail = new Map<string, { id: string; relationshipStatus: RelationshipStatus }>();
  if (!addresses.length) return byEmail;
  // Addresses arrive lowercased (imports store them that way), but a CRM row
  // may hold mixed case: compare on lower(primary_email) so a casing
  // difference still links the record instead of reading as Unknown.
  const rows = await db
    .select({ id: contacts.id, primaryEmail: contacts.primaryEmail, relationshipStatus: contacts.relationshipStatus })
    .from(contacts)
    .where(
      and(
        eq(contacts.workspaceId, auth.workspaceId),
        isNull(contacts.archivedAt),
        inArray(sql`lower(${contacts.primaryEmail})`, addresses.map((address) => address.toLowerCase())),
      ),
    );
  for (const row of rows) {
    if (row.primaryEmail) byEmail.set(row.primaryEmail.toLowerCase(), { id: row.id, relationshipStatus: row.relationshipStatus });
  }
  return byEmail;
}
