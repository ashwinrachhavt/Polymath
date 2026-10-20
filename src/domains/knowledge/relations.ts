import { sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";

/*
 * Semantic relations (ASH-174/ASH-184): the second half of the knowledge
 * graph. Explicit edges ([[Title]], source, curated types) live in
 * artifact_links; this is the machine half — the nearest cards to a given
 * note or zettel by cosine distance over the card embeddings (owner_type
 * 'artifact', same workspace, same model). Reading relations never writes:
 * semantic edges are computed at read time, so a re-embed is immediately
 * reflected and no stale edge rows can drift.
 *
 * Distance is cosine (pgvector <=>), so a lower value is a closer card and
 * `score` is 1 - distance. Cards with no embedding simply have no semantic
 * relations — the explicit graph still answers.
 */

export type RelatedNote = {
  id: string;
  title: string;
  kind: string;
  /** 1 - cosine distance; higher is closer. */
  score: number;
  /** First line of the related card, so the relation reads as what it is. */
  excerpt: string | null;
  /** True when an explicit artifact_links edge already joins the two. */
  alreadyLinked: boolean;
};

type RawRow = {
  id: string;
  title: string;
  kind: string;
  distance: number;
  excerpt: string | null;
  already_linked: boolean;
};

export async function relatedNotes(
  auth: AuthContext,
  artifactId: string,
  input: { limit?: number; maxDistance?: number } = {},
): Promise<RelatedNote[]> {
  const limit = input.limit ?? 5;
  const maxDistance = input.maxDistance ?? 0.45;
  const result = await db.execute(sql`
    with mine as (
      select e.embedding, e.model
      from embeddings e
      where e.workspace_id = ${auth.workspaceId}
        and e.owner_type = 'artifact'
        and e.owner_id = ${artifactId}
    ),
    nearest as (
      select e.owner_id as id, min(e.embedding <=> m.embedding) as distance
      from embeddings e
      cross join mine m
      where e.workspace_id = ${auth.workspaceId}
        and e.owner_type = 'artifact'
        and e.owner_id <> ${artifactId}
        and e.model = m.model
      group by e.owner_id
      having min(e.embedding <=> m.embedding) <= ${maxDistance}
      order by distance asc
      limit ${limit}
    )
    select a.id,
           a.title,
           a.kind,
           n.distance,
           (select v.plain_text from artifact_versions v where v.id = a.current_version_id) as excerpt,
           exists(
             select 1 from artifact_links l
             where l.workspace_id = ${auth.workspaceId}
               and ((l.artifact_id = ${artifactId} and l.target_id = a.id)
                 or (l.artifact_id = a.id and l.target_id = ${artifactId}))
           ) as already_linked
    from nearest n
    join artifacts a on a.id = n.id
    where a.workspace_id = ${auth.workspaceId}
      and a.archived_at is null
      and a.kind in ('note', 'zettel')
    order by n.distance asc
  `);
  const rows = result as unknown as RawRow[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    score: 1 - Number(row.distance),
    excerpt: firstLine(row.excerpt),
    alreadyLinked: Boolean(row.already_linked),
  }));
}

function firstLine(text: string | null): string | null {
  if (!text) return null;
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null;
  return line ? line.slice(0, 240) : null;
}
