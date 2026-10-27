import { and, desc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { listTaskNoteIds, listTasksWithoutBody } from "@/domains/work/queries";
import { db } from "@/lib/db";
import { artifactLinks, artifacts, claimEvidence, claims, documentReadingState, documents } from "./schema";

/*
 * The knowledge-debt report (ASH-295): where the library is quietly
 * decaying. Three structural signals plus one engagement signal, all read
 * from server rows, all workspace-scoped, all capped - the report exists to
 * be acted on in a weekly review, so it names the worst few and counts the
 * rest rather than shipping whole tables to the client.
 *
 * - zero-link notes: notes and zettels no other record points at and which
 *   point at nothing themselves. The graph's orphans.
 * - unsupported claims: live claims (proposed or accepted) with no evidence
 *   row. A claim without a passage is an opinion wearing a citation's
 *   clothes; rejected and retracted claims are out by definition.
 * - tasks without rationale: open tasks whose note has no body - the one
 *   place a task can carry its "why". (The literal rationale field lives
 *   on daily_outcomes, the day's commitments, not on the task itself. A
 *   task's prose lives on its note, so "no body" is the note's absence of
 *   plain text, not a null column.)
 * - never-opened documents: sources with an extraction that nobody has
 *   opened. Captured, processed, and never read - the engagement signal.
 */

const LIST_CAP = 10;

export type KnowledgeDebtItem = { id: string; title: string; detail?: string };
export type KnowledgeDebtSection = { total: number; items: KnowledgeDebtItem[] };

export type KnowledgeDebt = {
  zeroLinkNotes: KnowledgeDebtSection;
  unsupportedClaims: KnowledgeDebtSection;
  tasksWithoutRationale: KnowledgeDebtSection;
  neverOpenedDocuments: KnowledgeDebtSection;
};

/** Link rows touching an artifact, in either direction. */
const noLinks = (id: typeof artifacts.id) => sql`not exists (
  select 1 from ${artifactLinks}
  where ${artifactLinks.artifactId} = ${id}
     or (${artifactLinks.targetId} = ${id} and ${artifactLinks.targetType} in ('note', 'zettel', 'artifact'))
)`;

export async function getKnowledgeDebt(auth: AuthContext): Promise<KnowledgeDebt> {
  // A task is a note plus an extension row, so every open task's body is a note
  // in this workspace. Counting those as library orphans would report the same
  // work twice - once as work, once as a note nothing links to - and bury the
  // real orphans under it.
  const taskNoteIds = await listTaskNoteIds(auth);
  const noteRows = await db
    .select({ id: artifacts.id, title: artifacts.title, kind: artifacts.kind })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.workspaceId, auth.workspaceId),
        inArray(artifacts.kind, ["note", "zettel"]),
        ne(artifacts.status, "archived"),
        taskNoteIds.length ? notInArray(artifacts.id, taskNoteIds) : undefined,
        noLinks(artifacts.id),
      ),
    )
    .orderBy(desc(artifacts.updatedAt))
    .limit(LIST_CAP + 1);

  const claimRows = await db
    .select({ id: claims.id, statement: claims.statement, status: claims.status })
    .from(claims)
    .where(
      and(
        eq(claims.workspaceId, auth.workspaceId),
        inArray(claims.status, ["proposed", "accepted"]),
        sql`not exists (select 1 from ${claimEvidence} where ${claimEvidence.claimId} = ${claims.id})`,
      ),
    )
    .orderBy(desc(claims.updatedAt))
    .limit(LIST_CAP + 1);

  const taskRows = await listTasksWithoutBody(auth, LIST_CAP + 1);

  const docRows = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(
      and(
        eq(documents.workspaceId, auth.workspaceId),
        isNull(documents.archivedAt),
        sql`not exists (select 1 from ${documentReadingState} where ${documentReadingState.documentId} = ${documents.id})`,
      ),
    )
    .orderBy(desc(documents.updatedAt))
    .limit(LIST_CAP + 1);

  // Each list is capped at LIST_CAP + 1 so an 11th row tells us the true
  // count is "more than ten" without a second round-trip per section.
  const section = <T extends { id: string }>(rows: T[], map: (row: T) => KnowledgeDebtItem): KnowledgeDebtSection => ({
    total: rows.length > LIST_CAP ? -1 : rows.length, // -1: more than the cap
    items: rows.slice(0, LIST_CAP).map(map),
  });

  return {
    zeroLinkNotes: section(noteRows, (r) => ({ id: r.id, title: r.title, detail: r.kind })),
    unsupportedClaims: section(claimRows, (r) => ({ id: r.id, title: r.statement, detail: r.status })),
    tasksWithoutRationale: section(taskRows, (r) => ({ id: r.id, title: r.title, detail: r.status })),
    neverOpenedDocuments: section(docRows, (r) => ({ id: r.id, title: r.title ?? "Untitled document" })),
  };
}
