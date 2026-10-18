import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
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
 *   - A name alone never merges. A row with no email always creates a person,
 *     even when an identically named one exists.
 *   - Organizations key on the `Company` column, not the address domain —
 *     most connections use a personal mailbox, so domain keying split one
 *     employer into many. A consumer domain is never claimed as an employer's.
 *   - Nothing is deleted. A re-run adds rows, updates edges, and reports what
 *     it skipped; a wrong import can be reversed by archiving rows, not by
 *     pretending it never happened.
 *
 * Parsing lives here because the file is the domain's own contract, not a
 * presentation concern: the server action hands over the text.
 */

type CsvRow = Record<string, string>;

/**
 * Rows past this are refused before any write. A LinkedIn export of a very
 * large network is the only file that gets near it, and one transaction over
 * 5k rows is already the practical ceiling for a serverless request.
 */
const MAX_ROWS = 5000;

/** Raised before any write; the action turns it into a message the owner can act on. */
export class ImportLimitError extends Error {
  constructor(readonly rowCount: number) {
    super(`This file has ${rowCount} rows; the import limit is ${MAX_ROWS}.`);
    this.name = "ImportLimitError";
  }
}

export type ImportSummary = {
  rowsRead: number;
  peopleCreated: number;
  peopleMatched: number;
  organizationsCreated: number;
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
function rowsFromCsv(csvRows: string[][]): CsvRow[] {
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

/**
 * Import connections in one transaction. Validation failures (no name, a
 * malformed address) are recorded in `problems` and skipped, so one bad row
 * does not cost the file. A database error still aborts the whole import —
 * throwing inside this transaction rolls everything back, which is the honest
 * outcome when the schema rejected a write, not a partial import to explain.
 *
 * Idempotent on re-run: email-keyed people and name-keyed organizations are
 * matched, and an employment edge that already exists is not duplicated.
 */
export async function importConnections(
  auth: AuthContext,
  input: { csv: string },
): Promise<ImportSummary> {
  const rows = rowsFromCsv(parseCsv(input.csv));
  if (rows.length > MAX_ROWS) {
    throw new ImportLimitError(rows.length);
  }

  const summary: ImportSummary = {
    rowsRead: rows.length,
    peopleCreated: 0,
    peopleMatched: 0,
    organizationsCreated: 0,
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

    // Every active organization, once, collapsed into a lower-name Map. The
    // per-row lookup that would need the lower(name) index is the case this
    // pre-pass exists to avoid.
    const knownOrgs = new Map<string, string>();
    const takenDomains = new Set<string>();
    const orgs = await tx
      .select({ id: organizations.id, name: organizations.name, domain: organizations.domain })
      .from(organizations)
      .where(and(eq(organizations.workspaceId, auth.workspaceId), isNull(organizations.archivedAt)));
    for (const org of orgs) {
      knownOrgs.set(org.name.toLowerCase(), org.id);
      if (org.domain) takenDomains.add(org.domain.toLowerCase());
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
        await tx
          .insert(partyEmployment)
          .values({
            workspaceId: auth.workspaceId,
            personId,
            organizationId,
            title: position || null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })
          .onConflictDoNothing();
        knownEdges.add(edgeKey);
      }
    }

    await recordAudit(
      auth,
      {
        action: "parties.imported",
        subjectType: "workspace",
        subjectId: auth.workspaceId,
        summary: `Imported ${summary.peopleCreated} people, ${summary.organizationsCreated} organizations from LinkedIn CSV`,
        metadata: {
          rowsRead: summary.rowsRead,
          peopleMatched: summary.peopleMatched,
          skipped: summary.skipped,
        },
      },
      tx,
    );
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

