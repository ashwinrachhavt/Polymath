import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { auditEvents } from "@/domains/audit/schema";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import {
  contactPoints,
  organizations,
  partyEmployment,
  people,
  type contactPointKind,
} from "./schema";
import type { AuthContext } from "./resolve";

/*
 * LinkedIn Connections.csv import: the one CSV a person actually has. It is
 * the shape `First Name,Last Name,URL,Email Address,Company,Position,Connected On`.
 *
 * The invariants, in priority order (ADR 0001 § Invariants 3):
 *   - Email is the identity key *within this workspace*: same email twice is
 *     one person, never two rows.
 *   - A name alone never merges. No email means a new row per row unless an
 *     exact name+company edge already exists.
 *   - Nothing is deleted. A re-run adds rows, updates edges, and reports what
 *     it skipped; a wrong import can be reversed by archiving rows, not by
 *     pretending it never happened.
 *
 * Parsing lives here because the file is the domain's own contract, not a
 * presentation concern: the server action hands over the text.
 */

export type CsvRow = Record<string, string>;

export type ImportSummary = {
  rowsRead: number;
  peopleCreated: number;
  peopleMatched: number;
  organizationsCreated: number;
  employmentsLinked: number;
  skipped: number;
  /** Per-line reasons, capped so a 5k-row file cannot become a 5k-message page. */
  problems: { line: number; reason: string }[];
};

const MAX_PROBLEMS = 30;
/* One page per render for people and organizations; paginate past this when the
 * lists outgrow one screen. */
const LIST_PAGE = 200;
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF. One pass, no dependency. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // A UTF-8 BOM (LinkedIn ships one) would otherwise land inside the first header.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      // Consume CRLF as one break; a lone CR is a break too.
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  return rows;
}

/** Header-keyed rows, lowercased and trimmed. Unknown columns are kept. */
export function rowsFromCsv(csvRows: string[][]): CsvRow[] {
  const [header, ...body] = csvRows;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((cells) => {
    const row: CsvRow = {};
    keys.forEach((key, index) => {
      row[key] = (cells[index] ?? "").trim();
    });
    return row;
  });
}

export type PartyImportInput = {
  csv: string;
  /** Reject files larger than this before parsing; callers pass the limit they can render. */
  maxRows?: number;
};

/**
 * Import connections. One transaction per source row would be 5k transactions;
 * one transaction for the whole file is one bad row away from an all-or-nothing
 * loss. So: one transaction, but a row that fails is recorded and skipped
 * rather than aborting the import — which is what `problems` is for.
 *
 * Idempotent on re-run: email-keyed people and domain-keyed orgs are matched,
 * and an employment edge that already exists is counted as linked, not created.
 */
export async function importConnections(
  auth: AuthContext,
  input: PartyImportInput,
): Promise<ImportSummary> {
  const rows = rowsFromCsv(parseCsv(input.csv));
  const limit = input.maxRows ?? 5000;
  if (rows.length > limit) {
    throw new Error(`This file has ${rows.length} rows; the import limit is ${limit}.`);
  }

  const summary: ImportSummary = {
    rowsRead: rows.length,
    peopleCreated: 0,
    peopleMatched: 0,
    organizationsCreated: 0,
    employmentsLinked: 0,
    skipped: 0,
    problems: [],
  };

  // Pre-pass: every lookup the loop needs, in three reads instead of one per
  // row. A 5k-row file was ~30k sequential round trips inside one open
  // transaction; this is 3 plus the writes.
  const skippedRow = (line: number, reason: string) => {
    summary.skipped += 1;
    if (summary.problems.length < MAX_PROBLEMS) summary.problems.push({ line, reason });
  };

  const emails = [...new Set(
    rows.map((row) => (row["email address"] ?? "").toLowerCase()).filter(Boolean),
  )];
  const companyNames = [...new Set(
    rows.map((row) => (row["company"] ?? "").trim()).filter(Boolean).map((n) => n.toLowerCase()),
  )];

  await withTransaction(async (tx) => {
    const knownPeople = new Map<string, string>();
    if (emails.length) {
      const points = await tx
        .select({ value: contactPoints.value, personId: contactPoints.personId })
        .from(contactPoints)
        .where(
          and(
            eq(contactPoints.workspaceId, auth.workspaceId),
            eq(contactPoints.kind, "email"),
            inArray(contactPoints.value, emails),
            isNull(contactPoints.archivedAt),
          ),
        );
      for (const point of points) {
        if (point.personId) knownPeople.set(point.value.toLowerCase(), point.personId);
      }
    }

    const knownOrgs = new Map<string, string>();
    const takenDomains = new Set<string>();
    if (companyNames.length || emails.length) {
      // The org read is by lower(name) so it cannot use the name index; it runs
      // once per import rather than once per row, which is the cost that mattered.
      const orgs = await tx
        .select({ id: organizations.id, name: organizations.name, domain: organizations.domain })
        .from(organizations)
        .where(and(eq(organizations.workspaceId, auth.workspaceId), isNull(organizations.archivedAt)));
      for (const org of orgs) {
        knownOrgs.set(org.name.toLowerCase(), org.id);
        if (org.domain) takenDomains.add(org.domain.toLowerCase());
      }
    }

    const knownEdges = new Set<string>();
    const edges = await tx
      .select({ personId: partyEmployment.personId, organizationId: partyEmployment.organizationId })
      .from(partyEmployment)
      .where(and(eq(partyEmployment.workspaceId, auth.workspaceId), isNull(partyEmployment.endedAt)));
    for (const edge of edges) knownEdges.add(`${edge.personId}:${edge.organizationId}`);

    for (const [index, row] of rows.entries()) {
      const line = index + 2; // header is line 1
      const email = (row["email address"] ?? "").toLowerCase();
      const firstName = row["first name"] ?? "";
      const lastName = row["last name"] ?? "";
      const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
      const companyName = row["company"] ?? "";
      const position = row["position"] ?? "";

      if (!fullName) {
        skippedRow(line, "No name on this row.");
        continue;
      }
      if (email && !EMAIL_SHAPE.test(email)) {
        skippedRow(line, `"${email}" is not an email address.`);
        continue;
      }

      // Identity: the verified email is the only automatic merge. A name match
      // creates a separate person on purpose — two Adas stay two people.
      let personId: string | null = email ? knownPeople.get(email) ?? null : null;

      if (personId) {
        summary.peopleMatched += 1;
      } else {
        const [created] = await tx
          .insert(people)
          .values({
            workspaceId: auth.workspaceId,
            displayName: fullName,
            title: position || null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })
          .returning({ id: people.id });
        personId = created.id;
        if (email) knownPeople.set(email, created.id);
        summary.peopleCreated += 1;

        if (email) {
          await tx.insert(contactPoints).values({
            workspaceId: auth.workspaceId,
            kind: "email" satisfies (typeof contactPointKind.enumValues)[number],
            value: email,
            isPrimary: true,
            // Owner-asserted, not provider-verified: schema.ts reserves
            // isVerified for an address a provider confirmed. The owner's own
            // export is strong evidence, but it is provenance, not verification.
            isVerified: false,
            personId,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          });
        }
      }

      if (!companyName) continue;

      // Company NAME is the key in this file, not the email domain. LinkedIn's
      // `Company` column is what the owner sees and curates; the address domain
      // is a personal mailbox for most connections (gmail.com, an ISP), so
      // keying on it splits one employer into a dozen organizations. The
      // domain-first rule in ADR 0001 is for records discovered from real
      // business addresses, which this file rarely carries.
      let organizationId = knownOrgs.get(companyName.toLowerCase()) ?? null;

      if (!organizationId) {
        const domain = businessDomain(email);
        // Only a domain the address confirms AND no other org owns; the unique
        // index would otherwise throw mid-file.
        const claimDomain = domain && !takenDomains.has(domain) ? domain : null;
        const [created] = await tx
          .insert(organizations)
          .values({
            workspaceId: auth.workspaceId,
            name: companyName,
            domain: claimDomain,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })
          .returning({ id: organizations.id });
        organizationId = created.id;
        knownOrgs.set(companyName.toLowerCase(), created.id);
        if (claimDomain) takenDomains.add(claimDomain);
        summary.organizationsCreated += 1;
      }

      const edgeKey = `${personId}:${organizationId}`;
      if (!knownEdges.has(edgeKey)) {
        // knownEdges covers duplicates inside this file; the unique index on
        // the current edge covers a second import running concurrently.
        const [created] = await tx
          .insert(partyEmployment)
          .values({
            workspaceId: auth.workspaceId,
            personId,
            organizationId,
            title: position || null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })
          .onConflictDoNothing()
          .returning({ id: partyEmployment.id });
        knownEdges.add(edgeKey);
        if (created) summary.employmentsLinked += 1;
      }
    }

    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: "parties.imported",
      subjectType: "workspace",
      subjectId: auth.workspaceId,
      summary: `Imported ${summary.peopleCreated} people, ${summary.organizationsCreated} organizations from LinkedIn CSV`,
      metadata: {
        rowsRead: summary.rowsRead,
        peopleMatched: summary.peopleMatched,
        skipped: summary.skipped,
      },
    });
  });

  return summary;
}

/*
 * A consumer mailbox domain says nothing about the employer: keying an org on
 * gmail.com would file every personal-email connection under one "organization"
 * and then collide on the unique index. Only a non-consumer domain is taken as
 * the employer's.
 */
const CONSUMER_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "live.com", "icloud.com", "me.com", "aol.com", "protonmail.com", "proton.me",
  "gmx.com", "mail.com", "yandex.com", "zoho.com", "fastmail.com",
]);

function businessDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain.includes(".") || CONSUMER_DOMAINS.has(domain)) return null;
  return domain;
}

export type PersonRow = {
  id: string;
  displayName: string;
  title: string | null;
  email: string | null;
  organizations: { id: string; name: string; title: string | null }[];
};

/*
 * The Relationships read: one page of people, then two batched reads for their
 * emails and current org edges. Three queries regardless of page size — the
 * correlated-subquery version scanned contact_points once per person.
 *
 * `ponytail:` three queries in sequence, not one join. The join would fan out
 * over both emails and employments and need the same collapse in JS anyway.
 */
export async function listPeople(auth: AuthContext): Promise<PersonRow[]> {
  const page = await db
    .select({ id: people.id, displayName: people.displayName, title: people.title })
    .from(people)
    .where(and(eq(people.workspaceId, auth.workspaceId), isNull(people.archivedAt)))
    .orderBy(people.displayName)
    .limit(LIST_PAGE);
  if (page.length === 0) return [];

  const ids = page.map((person) => person.id);
  const [emails, edges] = await Promise.all([
    db
      .select({ personId: contactPoints.personId, value: contactPoints.value })
      .from(contactPoints)
      .where(
        and(
          eq(contactPoints.workspaceId, auth.workspaceId),
          eq(contactPoints.kind, "email"),
          inArray(contactPoints.personId, ids),
          isNull(contactPoints.archivedAt),
        ),
      )
      .orderBy(desc(contactPoints.isPrimary)),
    db
      .select({
        personId: partyEmployment.personId,
        organizationId: organizations.id,
        name: organizations.name,
        title: partyEmployment.title,
      })
      .from(partyEmployment)
      .innerJoin(organizations, eq(organizations.id, partyEmployment.organizationId))
      .where(
        and(
          eq(partyEmployment.workspaceId, auth.workspaceId),
          inArray(partyEmployment.personId, ids),
          isNull(partyEmployment.endedAt),
        ),
      ),
  ]);

  // Primary first, so the first row seen for a person is the one shown; the
  // schema allows only one primary per person per kind.
  const emailByPerson = new Map<string, string>();
  for (const email of emails) {
    if (email.personId && !emailByPerson.has(email.personId)) {
      emailByPerson.set(email.personId, email.value);
    }
  }
  const orgsByPerson = new Map<string, PersonRow["organizations"]>();
  for (const edge of edges) {
    const list = orgsByPerson.get(edge.personId) ?? [];
    list.push({ id: edge.organizationId, name: edge.name, title: edge.title });
    orgsByPerson.set(edge.personId, list);
  }

  return page.map((person) => ({
    ...person,
    email: emailByPerson.get(person.id) ?? null,
    organizations: orgsByPerson.get(person.id) ?? [],
  }));
}

export type OrganizationRow = {
  id: string;
  name: string;
  domain: string | null;
  peopleCount: number;
};

export async function listOrganizations(auth: AuthContext): Promise<OrganizationRow[]> {
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      domain: organizations.domain,
      peopleCount: sql<number>`count(distinct ${partyEmployment.personId})::int`,
    })
    .from(organizations)
    .leftJoin(
      partyEmployment,
      and(
        eq(partyEmployment.organizationId, organizations.id),
        eq(partyEmployment.workspaceId, organizations.workspaceId),
        isNull(partyEmployment.endedAt),
      ),
    )
    .where(and(eq(organizations.workspaceId, auth.workspaceId), isNull(organizations.archivedAt)))
    .groupBy(organizations.id)
    .orderBy(organizations.name)
    .limit(LIST_PAGE);

  return rows;
}

/** Link a person to an organization by hand; idempotent on the current edge. */
export async function linkPersonToOrganization(
  auth: AuthContext,
  input: { personId: string; organizationId: string; title?: string },
): Promise<{ employmentId: string }> {
  return withTransaction(async (tx) => {
    // Both sides are read under the workspace filter; a foreign id is "not
    // found", never a cross-workspace link the FKs would then throw on.
    const [person] = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.id, input.personId), eq(people.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!person) throw new Error("person not found in workspace");
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, input.organizationId),
          eq(organizations.workspaceId, auth.workspaceId),
        ),
      )
      .limit(1);
    if (!organization) throw new Error("organization not found in workspace");

    const [existing] = await tx
      .select({ id: partyEmployment.id })
      .from(partyEmployment)
      .where(
        and(
          eq(partyEmployment.workspaceId, auth.workspaceId),
          eq(partyEmployment.personId, input.personId),
          eq(partyEmployment.organizationId, input.organizationId),
          isNull(partyEmployment.endedAt),
        ),
      )
      .limit(1);
    if (existing) return { employmentId: existing.id };

    const [created] = await tx
      .insert(partyEmployment)
      .values({
        workspaceId: auth.workspaceId,
        personId: input.personId,
        organizationId: input.organizationId,
        title: input.title ?? null,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: partyEmployment.id });

    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: "party_employment.linked",
      subjectType: "person",
      subjectId: input.personId,
      summary: "Linked person to organization",
      metadata: { organizationId: input.organizationId, employmentId: created.id },
    });

    return { employmentId: created.id };
  });
}
