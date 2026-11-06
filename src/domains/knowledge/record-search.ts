import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import { artifacts, documents, type artifactKind } from "@/domains/knowledge/schema";
import { threads } from "@/domains/agents/schema";
import { organizations, people, contactPoints } from "@/domains/identity/schema";
import type { AuthContext } from "@/domains/identity/resolve";

/*
 * Cross-record lookup for the composer's plus menu and @-mentions: when the
 * owner attaches context to a message, they search everything the message
 * could name — notes, zettels, generated artifacts, past conversations, and
 * the identity domain's people and companies (what the LinkedIn CSV import
 * writes and the People and Companies screens show). One query set, grouped
 * by kind client-side. Read-only; references travel in the message text, so
 * this module never writes anything.
 *
 * LIMIT is fixed rather than caller-supplied: the menu shows a handful per
 * group, and an unbounded typeahead against the workspace's own tables is a
 * cost for no UX gain.
 */

const PER_GROUP_LIMIT = 5;

export type RecordReference = {
  id: string;
  kind: "note" | "zettel" | "artifact" | "conversation" | "document" | "person" | "company";
  title: string;
  /** Where the picker sends a click: the record's own screen. */
  href: string;
};

export async function searchRecordsForAttach(auth: AuthContext, query: string): Promise<RecordReference[]> {
  const trimmed = query.trim().slice(0, 200);
  const like = `%${escapeLike(trimmed)}%`;

  // The enum's members the picker offers. "wiki" is not a db kind; the filter
  // below admits it only as a display kind, mapped from "note" rows the wiki
  // registry would claim — this query stays registry-agnostic.
  const artifactKinds: (typeof artifactKind.enumValues)[number][] = [
    "note",
    "zettel",
    "report",
    "deck",
    "infographic",
    "document",
    "memo",
    "diagram",
    "transcript",
    "other",
  ];

  // Order matters: the queries below run artifacts, threads, documents, CRM
  // people, and CRM companies, and the destructure must name them in that order.
  const [artifactRows, threadRows, documentRows, contactRows, companyRows] = await Promise.all([
    db
      .select({ id: artifacts.id, kind: artifacts.kind, title: artifacts.title, updatedAt: artifacts.updatedAt })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.workspaceId, auth.workspaceId),
          inArray(artifacts.kind, [...artifactKinds]),
          isNull(artifacts.archivedAt),
          // An untitled row has no name to attach or search by.
          sql`${artifacts.title} <> ''`,
          trimmed ? ilike(artifacts.title, like) : sql`true`,
        ),
      )
      .orderBy(desc(artifacts.updatedAt))
      .limit(PER_GROUP_LIMIT * 3),
    db
      .select({ id: threads.id, title: threads.title, updatedAt: threads.updatedAt })
      .from(threads)
      .where(
        and(
          eq(threads.workspaceId, auth.workspaceId),
          isNull(threads.archivedAt),
          trimmed ? ilike(threads.title, like) : sql`true`,
        ),
      )
      .orderBy(desc(threads.updatedAt))
      .limit(PER_GROUP_LIMIT),
    // Vault documents, so a message can reference the captured file itself.
    db
      .select({
        id: documents.id,
        title: sql<string>`coalesce(${documents.title}, '')`,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(
        and(
          eq(documents.workspaceId, auth.workspaceId),
          isNull(documents.archivedAt),
          sql`${documents.title} <> ''`,
          trimmed ? ilike(documents.title, like) : sql`true`,
        ),
      )
      .orderBy(desc(documents.updatedAt))
      .limit(PER_GROUP_LIMIT),
    // People and companies from the identity domain — the tables the LinkedIn
    // CSV import writes and the People and Companies screens read. A mention
    // is a name the model reads; the href opens the list filtered to the name.
    db
      .select({ id: people.id, displayName: people.displayName })
      .from(people)
      .where(
        and(
          eq(people.workspaceId, auth.workspaceId),
          isNull(people.archivedAt),
          sql`${people.displayName} <> ''`,
          trimmed
            ? or(
                ilike(people.displayName, like),
                sql`exists (
                  select 1 from ${contactPoints} cp
                  where cp.person_id = "people"."id"
                    and cp.workspace_id = ${auth.workspaceId}
                    and cp.kind = 'email'
                    and cp.archived_at is null
                    and cp.value ilike ${like}
                )`,
              )!
            : sql`true`,
        ),
      )
      .orderBy(asc(people.displayName), asc(people.id))
      .limit(PER_GROUP_LIMIT),
    db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(
        and(
          eq(organizations.workspaceId, auth.workspaceId),
          isNull(organizations.archivedAt),
          sql`${organizations.name} <> ''`,
          trimmed ? or(ilike(organizations.name, like), ilike(organizations.domain, like))! : sql`true`,
        ),
      )
      .orderBy(asc(organizations.name), asc(organizations.id))
      .limit(PER_GROUP_LIMIT),
  ]);

  const references: RecordReference[] = artifactRows
    // The picker's groups; document/other/memo/diagram/transcript rows do not
    // belong in a message-reference menu, they have their own surfaces.
    .filter((row) => ["note", "zettel", "report", "deck", "infographic"].includes(row.kind))
    .map((row) => ({
      id: row.id,
      kind: row.kind === "zettel" ? "zettel" : row.kind === "note" ? "note" : "artifact",
      title: row.title,
      href:
        row.kind === "note"
          ? `/polymath/notes?note=${row.id}`
          : row.kind === "zettel"
            ? `/polymath/ideas?zettel=${row.id}`
            : `/polymath/artifacts/${row.id}`,
    }));
  references.push(
    ...documentRows.map((row) => ({
      id: row.id,
      kind: "document" as const,
      title: row.title ?? "",
      href: `/polymath/knowledge?doc=${row.id}`,
    })),
  );
  references.push(
    ...threadRows.map((row) => ({
      id: row.id,
      kind: "conversation" as const,
      title: row.title || "Untitled conversation",
      href: `/command-center/conversations/${row.id}`,
    })),
  );
  references.push(
    ...contactRows.map((row) => ({
      id: row.id,
      kind: "person" as const,
      title: row.displayName,
      href: `/command-center/relationships/people?q=${encodeURIComponent(row.displayName)}`,
    })),
  );
  references.push(
    ...companyRows.map((row) => ({
      id: row.id,
      kind: "company" as const,
      title: row.name,
      href: `/command-center/relationships/companies?q=${encodeURIComponent(row.name)}`,
    })),
  );
  return references;
}
