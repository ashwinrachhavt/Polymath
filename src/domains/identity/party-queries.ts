import { and, asc, count, eq, desc, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { contacts } from "@/domains/crm/schema";
import { listContactStatusesByEmail } from "@/domains/crm/queries";
import { RELATIONSHIP_STATUSES, type RelationshipStatus } from "@/domains/crm/status";
import type { AuthContext } from "./resolve";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import {
  contactPoints,
  organizations,
  partyEmployment,
  people,
} from "./schema";

/*
 * Read queries for the People and Companies tables. These are identity-domain
 * records — what the LinkedIn CSV import writes — read for display here and
 * never written from this folder; writes go through the domain's commands.
 *
 * The relationship status pill comes from the CRM domain's read seam
 * (listContactStatusesByEmail): a person's primary email matched against the
 * CRM contact's primary email, the one key both domains already agree on.
 * ASH-135 owns the eventual merge. A person with no CRM contact reads as
 * "Unknown", which is the honest state, not an error.
 */

export type PartyPersonRow = {
  id: string;
  displayName: string;
  title: string | null;
  email: string | null;
  currentOrganizationName: string | null;
  relationshipStatus: RelationshipStatus;
  /** CRM contact id when the email matched one; the table links there. */
  crmContactId: string | null;
  updatedAt: Date;
};

export const PARTY_PAGE_SIZE = 25;

export async function pagePeople(
  auth: AuthContext,
  input: { query?: string; limit?: number; offset?: number } = {},
): Promise<{ items: PartyPersonRow[]; total: number }> {
  const filters = [eq(people.workspaceId, auth.workspaceId), isNull(people.archivedAt)];
  if (input.query?.trim()) {
    const like = `%${escapeLike(input.query.trim())}%`;
    filters.push(
      or(
        ilike(people.displayName, like),
        // Email search reaches into contact_points via an exists, so the
        // count and the page stay one code path.
        sql`exists (
          select 1 from ${contactPoints} cp
          where cp.person_id = "people"."id"
            and cp.workspace_id = ${auth.workspaceId}
            and cp.kind = 'email'
            and cp.archived_at is null
            and cp.value ilike ${like}
        )`,
      )!,
    );
  }
  const where = and(...filters);

  const [pageRows, [totalRow]] = await Promise.all([
    db
      .select({
        id: people.id,
        displayName: people.displayName,
        title: people.title,
        updatedAt: people.updatedAt,
      })
      .from(people)
      .where(where)
      .orderBy(asc(people.displayName), asc(people.id))
      .limit(input.limit ?? PARTY_PAGE_SIZE)
      .offset(input.offset ?? 0),
    db.select({ total: count() }).from(people).where(where),
  ]);
  const total = totalRow?.total ?? 0;
  if (pageRows.length === 0) return { items: [], total };

  const ids = pageRows.map((row) => row.id);
  // Batch 2: everything the page's 25 person ids need, in parallel.
  const [emails, edges] = await Promise.all([
    db
      .select({ personId: contactPoints.personId, value: contactPoints.value, isPrimary: contactPoints.isPrimary })
      .from(contactPoints)
      .where(
        and(
          eq(contactPoints.workspaceId, auth.workspaceId),
          eq(contactPoints.kind, "email"),
          inArray(contactPoints.personId, ids),
          isNull(contactPoints.archivedAt),
        ),
      )
      .orderBy(desc(contactPoints.isPrimary), asc(contactPoints.value)),
    db
      .select({
        personId: partyEmployment.personId,
        organizationName: organizations.name,
      })
      .from(partyEmployment)
      .innerJoin(organizations, eq(organizations.id, partyEmployment.organizationId))
      .where(
        and(
          eq(partyEmployment.workspaceId, auth.workspaceId),
          inArray(partyEmployment.personId, ids),
          isNull(partyEmployment.endedAt),
        ),
      )
      .orderBy(desc(partyEmployment.createdAt)),
  ]);

  // Primary first, so the first row seen for a person is the one shown.
  const emailByPerson = new Map<string, string>();
  for (const email of emails) {
    if (email.personId && !emailByPerson.has(email.personId)) {
      emailByPerson.set(email.personId, email.value);
    }
  }
  const orgByPerson = new Map<string, string>();
  for (const edge of edges) {
    if (!orgByPerson.has(edge.personId)) orgByPerson.set(edge.personId, edge.organizationName);
  }

  const crmStatuses = await listContactStatusesByEmail(auth, [...emailByPerson.values()]);

  const items = pageRows.map((row) => {
    const email = emailByPerson.get(row.id) ?? null;
    const matched = email ? crmStatuses.get(email) : undefined;
    return {
      id: row.id,
      displayName: row.displayName,
      title: row.title,
      email,
      currentOrganizationName: orgByPerson.get(row.id) ?? null,
      relationshipStatus: matched?.relationshipStatus ?? "unknown",
      crmContactId: matched?.id ?? null,
      updatedAt: row.updatedAt,
    };
  });
  return { items, total };
}

export type PartyOrganizationRow = {
  id: string;
  name: string;
  domain: string | null;
  peopleCount: number;
  updatedAt: Date;
};

export async function pageOrganizations(
  auth: AuthContext,
  input: { query?: string; limit?: number; offset?: number } = {},
): Promise<{ items: PartyOrganizationRow[]; total: number }> {
  const filters = [eq(organizations.workspaceId, auth.workspaceId), isNull(organizations.archivedAt)];
  if (input.query?.trim()) {
    const like = `%${escapeLike(input.query.trim())}%`;
    filters.push(or(ilike(organizations.name, like), ilike(organizations.domain, like))!);
  }
  const where = and(...filters);

  const [items, [totalRow]] = await Promise.all([
    db
      .select({
        id: organizations.id,
        name: organizations.name,
        domain: organizations.domain,
        peopleCount: sql<number>`(
          select count(*)::int from ${partyEmployment} pe
          where pe.organization_id = "organizations"."id"
            and pe.workspace_id = ${auth.workspaceId}
            and pe.ended_at is null
        )`.as("people_count"),
        updatedAt: organizations.updatedAt,
      })
      .from(organizations)
      .where(where)
      .orderBy(asc(organizations.name), asc(organizations.id))
      .limit(input.limit ?? PARTY_PAGE_SIZE)
      .offset(input.offset ?? 0),
    db.select({ total: count() }).from(organizations).where(where),
  ]);
  return { items, total: totalRow?.total ?? 0 };
}

/*
 * Rail counts for the People table, computed in Postgres: one aggregate over
 * people left-joined to their primary email and the CRM contact holding it.
 * Rows never reach the app — the query returns at most six rows regardless
 * of workspace size. A person whose email matches no CRM contact lands in
 * the "unknown" bucket, same as the table's pill.
 */
const matchedStatusSql = sql<string | null>`(
  select c.relationship_status::text from ${contacts} c
  where c.workspace_id = people.workspace_id
    and c.archived_at is null
    and c.primary_email = (
      select cp.value from ${contactPoints} cp
      where cp.person_id = people.id
        and cp.workspace_id = people.workspace_id
        and cp.kind = 'email'
        and cp.archived_at is null
      order by cp.is_primary desc, cp.value asc
      limit 1
    )
)`;

export async function countPeopleByStatus(auth: AuthContext): Promise<{
  statuses: { value: RelationshipStatus; total: number }[];
  unmatched: number;
}> {
  const rows = await db
    .select({ status: matchedStatusSql.as("status"), total: count() })
    .from(people)
    .where(and(eq(people.workspaceId, auth.workspaceId), isNull(people.archivedAt)))
    .groupBy(matchedStatusSql);

  const counts = new Map<string, number>();
  let unmatched = 0;
  for (const row of rows) {
    if (row.status && (RELATIONSHIP_STATUSES as readonly string[]).includes(row.status)) {
      counts.set(row.status, row.total);
    } else {
      unmatched += row.total;
    }
  }
  return {
    statuses: RELATIONSHIP_STATUSES.map((value) => ({ value, total: counts.get(value) ?? 0 })),
    unmatched,
  };
}
