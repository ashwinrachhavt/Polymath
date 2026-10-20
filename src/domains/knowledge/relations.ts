import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { artifactLinks, artifacts } from "./schema";

/*
 * Semantic relations (ASH-174/ASH-184): the machine half of the knowledge
 * graph. A note or zettel embeds like a document (pgvector in the existing
 * embeddings table, HNSW cosine index - one store, no new service, provider
 * from the #165 registry). Every successful embed materializes the card's
 * nearest neighbours as linkType 'semantic' edges with a score, rewritten
 * wholesale each time, so edges track the vectors exactly and never drift.
 * Reads are plain indexed joins over those edges, in both directions, so a
 * new card surfaces on the cards it resembles the moment it embeds.
 *
 * Distance is cosine (pgvector <=>); score is 1 - distance. A card with no
 * embedding has no semantic relations; the explicit graph still answers.
 */

export const SEMANTIC_EDGE_LIMIT = 5;
export const SEMANTIC_EDGE_MAX_DISTANCE = 0.45;

export type RelatedNote = {
  id: string;
  title: string;
  kind: string;
  /** 1 - cosine distance; higher is closer. */
  score: number;
  /** First line of the related card, so the relation reads as what it is. */
  excerpt: string | null;
  /** True when an explicit (non-semantic) edge already joins the two. */
  alreadyLinked: boolean;
};

type Neighbor = { id: string; distance: number };

async function nearestNeighbors(
  auth: AuthContext,
  artifactId: string,
  input: { limit: number; maxDistance: number },
): Promise<Neighbor[]> {
  const result = await db.execute(sql`
    with mine as (
      select e.embedding, e.model
      from embeddings e
      where e.workspace_id = ${auth.workspaceId}
        and e.owner_type = 'artifact'
        and e.owner_id = ${artifactId}
    )
    select e.owner_id as id, min(e.embedding <=> m.embedding) as distance
    from embeddings e
    cross join mine m
    join artifacts a on a.id = e.owner_id
    where e.workspace_id = ${auth.workspaceId}
      and e.owner_type = 'artifact'
      and e.owner_id <> ${artifactId}
      and e.model = m.model
      and a.archived_at is null
      and a.kind in ('note', 'zettel')
    group by e.owner_id
    having min(e.embedding <=> m.embedding) <= ${input.maxDistance}
    order by distance asc
    limit ${input.limit}
  `);
  return (result as unknown as { id: string; distance: number | string }[]).map((row) => ({
    id: row.id,
    distance: Number(row.distance),
  }));
}

/**
 * Rewrite a card's semantic out-edges from its current vector. Skips pairs the
 * owner already linked explicitly (either direction). Idempotent.
 */
export async function materializeSemanticEdges(
  auth: AuthContext,
  artifactId: string,
  input: { limit?: number; maxDistance?: number } = {},
): Promise<number> {
  const neighbors = await nearestNeighbors(auth, artifactId, {
    limit: input.limit ?? SEMANTIC_EDGE_LIMIT,
    maxDistance: input.maxDistance ?? SEMANTIC_EDGE_MAX_DISTANCE,
  });
  return withTransaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${artifactId}, 1))`);
    await tx.delete(artifactLinks).where(and(
      eq(artifactLinks.workspaceId, auth.workspaceId),
      eq(artifactLinks.artifactId, artifactId),
      eq(artifactLinks.linkType, "semantic"),
    ));
    if (!neighbors.length) return 0;
    const ids = neighbors.map((n) => n.id);
    const explicit = await tx
      .select({ a: artifactLinks.artifactId, b: artifactLinks.targetId })
      .from(artifactLinks)
      .where(and(
        eq(artifactLinks.workspaceId, auth.workspaceId),
        ne(artifactLinks.linkType, "semantic"),
        or(
          and(eq(artifactLinks.artifactId, artifactId), inArray(artifactLinks.targetId, ids)),
          and(eq(artifactLinks.targetId, artifactId), inArray(artifactLinks.artifactId, ids)),
        ),
      ));
    const linked = new Set(explicit.flatMap((row) => [row.a, row.b]));
    const keep = neighbors.filter((n) => !linked.has(n.id));
    if (!keep.length) return 0;
    const titles = await tx
      .select({ id: artifacts.id, title: artifacts.title })
      .from(artifacts)
      .where(inArray(artifacts.id, keep.map((n) => n.id)));
    const titleOf = new Map(titles.map((t) => [t.id, t.title]));
    await tx.insert(artifactLinks).values(
      keep.map((n) => ({
        workspaceId: auth.workspaceId,
        artifactId,
        targetType: "note",
        targetId: n.id,
        label: titleOf.get(n.id) ?? "",
        linkType: "semantic" as const,
        score: 1 - n.distance,
      })),
    ).onConflictDoNothing();
    return keep.length;
  });
}

type RawRow = {
  id: string;
  title: string;
  kind: string;
  score: number | string;
  excerpt: string | null;
  already_linked: boolean;
};

/** Related cards from materialized edges, both directions, best score per card. */
export async function relatedNotes(
  auth: AuthContext,
  artifactId: string,
  input: { limit?: number } = {},
): Promise<RelatedNote[]> {
  const limit = input.limit ?? SEMANTIC_EDGE_LIMIT;
  const result = await db.execute(sql`
    select a.id, a.title, a.kind, s.score,
           (select v.plain_text from artifact_versions v where v.id = a.current_version_id) as excerpt,
           exists(
             select 1 from artifact_links l
             where l.workspace_id = ${auth.workspaceId}
               and l.link_type <> 'semantic'
               and ((l.artifact_id = ${artifactId} and l.target_id = a.id)
                 or (l.artifact_id = a.id and l.target_id = ${artifactId}))
           ) as already_linked
    from (
      select case when l.artifact_id = ${artifactId} then l.target_id else l.artifact_id end as other_id,
             max(l.score) as score
      from artifact_links l
      where l.workspace_id = ${auth.workspaceId}
        and l.link_type = 'semantic'
        and (l.artifact_id = ${artifactId} or l.target_id = ${artifactId})
      group by 1
    ) s
    join artifacts a on a.id = s.other_id
    where a.workspace_id = ${auth.workspaceId}
      and a.archived_at is null
      and a.kind in ('note', 'zettel')
    order by s.score desc
    limit ${limit}
  `);
  return (result as unknown as RawRow[]).map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    score: Number(row.score),
    excerpt: firstLine(row.excerpt),
    alreadyLinked: Boolean(row.already_linked),
  }));
}

/**
 * Confirm a suggestion: flip the semantic edge into an explicit 'related'
 * edge, direction normalized to viewer -> target, score kept as provenance.
 * Returns false when there is no suggestion to promote.
 */
export async function promoteSemanticLink(
  auth: AuthContext,
  input: { artifactId: string; targetId: string },
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const rows = await tx
      .select({ id: artifactLinks.id, from: artifactLinks.artifactId, to: artifactLinks.targetId, score: artifactLinks.score })
      .from(artifactLinks)
      .where(and(
        eq(artifactLinks.workspaceId, auth.workspaceId),
        eq(artifactLinks.linkType, "semantic"),
        or(
          and(eq(artifactLinks.artifactId, input.artifactId), eq(artifactLinks.targetId, input.targetId)),
          and(eq(artifactLinks.artifactId, input.targetId), eq(artifactLinks.targetId, input.artifactId)),
        ),
      ));
    if (!rows.length) return false;
    const forward = rows.find((r) => r.from === input.artifactId) ?? rows[0];
    const [target] = await tx.select({ title: artifacts.title }).from(artifacts).where(eq(artifacts.id, input.targetId));
    const reverse = rows.filter((r) => r.id !== forward.id).map((r) => r.id);
    if (reverse.length) await tx.delete(artifactLinks).where(inArray(artifactLinks.id, reverse));
    await tx
      .update(artifactLinks)
      .set({
        artifactId: input.artifactId,
        targetId: input.targetId,
        label: target?.title ?? "",
        linkType: "related",
        context: "Confirmed from a semantic relation.",
      })
      .where(eq(artifactLinks.id, forward.id));
    return true;
  });
}

function firstLine(text: string | null): string | null {
  if (!text) return null;
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null;
  return line ? line.slice(0, 240) : null;
}
