import { and, desc, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { artifactLinks, artifactVersions, artifacts } from "./schema";
import { SUGGESTED_LINKS_PER_DETAIL_PAGE } from "./zettel-capacity";

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

/*
 * The detail-page budget for suggested links, named in the capacity module
 * alongside the collection cap. Calibrated neighbour: the corpus-duplicate
 * threshold ZETTEL_DUPLICATE_MAX_DISTANCE (0.15) — admission vs display.
 */
const SEMANTIC_EDGE_LIMIT = SUGGESTED_LINKS_PER_DETAIL_PAGE;
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
      and a.kind in ('note', 'zettel', 'document', 'memo', 'report', 'transcript')
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
  // Topic hubs sit outside the semantic pass in both directions: the
  // neighbours query already filters kind "other" out of its candidates, and
  // this guard keeps a hub from ever writing out-edges. Hubs are furniture —
  // a hub that resembled its contents would tether every filed idea to one
  // vertex.
  const [self] = await db
    .select({ kind: artifacts.kind })
    .from(artifacts)
    .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.id, artifactId)))
    .limit(1);
  if (self?.kind === "other") return 0;

  const neighbors = await nearestNeighbors(auth, artifactId, {
    limit: input.limit ?? SEMANTIC_EDGE_LIMIT,
    maxDistance: input.maxDistance ?? SEMANTIC_EDGE_MAX_DISTANCE,
  });
  return withTransaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${artifactId}, 1))`);
    await tx
      .delete(artifactLinks)
      .where(
        and(
          eq(artifactLinks.workspaceId, auth.workspaceId),
          eq(artifactLinks.artifactId, artifactId),
          eq(artifactLinks.linkType, "semantic"),
        ),
      );
    if (!neighbors.length) return 0;
    const ids = neighbors.map((n) => n.id);
    const explicit = await tx
      .select({ a: artifactLinks.artifactId, b: artifactLinks.targetId })
      .from(artifactLinks)
      .where(
        and(
          eq(artifactLinks.workspaceId, auth.workspaceId),
          ne(artifactLinks.linkType, "semantic"),
          or(
            and(eq(artifactLinks.artifactId, artifactId), inArray(artifactLinks.targetId, ids)),
            and(eq(artifactLinks.targetId, artifactId), inArray(artifactLinks.artifactId, ids)),
          ),
        ),
      );
    const linked = new Set(explicit.flatMap((row) => [row.a, row.b]));
    const keep = neighbors.filter((n) => !linked.has(n.id));
    if (!keep.length) return 0;
    const titles = await tx
      .select({ id: artifacts.id, title: artifacts.title })
      .from(artifacts)
      .where(
        inArray(
          artifacts.id,
          keep.map((n) => n.id),
        ),
      );
    const titleOf = new Map(titles.map((t) => [t.id, t.title]));
    await tx
      .insert(artifactLinks)
      .values(
        keep.map((n) => ({
          workspaceId: auth.workspaceId,
          artifactId,
          targetType: "note",
          targetId: n.id,
          label: titleOf.get(n.id) ?? "",
          linkType: "semantic" as const,
          score: 1 - n.distance,
        })),
      )
      .onConflictDoNothing();
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
      and a.kind in ('note', 'zettel', 'document', 'memo', 'report', 'transcript')
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
 * The cards this one is explicitly linked to — edges a person or a creation
 * path saved: `source` provenance, sibling `related` seeds, canvas ties.
 *
 * `relatedNotes` only reads materialized `semantic` edges, and an explicit
 * edge suppresses its semantic twin (materialization skips explicitly-linked
 * pairs), so a card's two halves stay distinct: this is the explicit half,
 * both directions, title order.
 */
export async function linkedNotes(auth: AuthContext, artifactId: string): Promise<RelatedNote[]> {
  const result = await db.execute(sql`
    select a.id, a.title, a.kind,
           1::float as score,
           (select v.plain_text from artifact_versions v where v.id = a.current_version_id) as excerpt,
           true as already_linked
    from artifact_links l
    join artifacts a
      on a.id = case when l.artifact_id = ${artifactId} then l.target_id else l.artifact_id end
    where l.workspace_id = ${auth.workspaceId}
      -- Legacy veto tombstones ('dismissed') stay excluded until a data
      -- purge retires them; a rejected link must not resurface as a linked idea.
      and l.link_type not in ('semantic', 'dismissed')
      and (l.artifact_id = ${artifactId} or l.target_id = ${artifactId})
      and a.workspace_id = ${auth.workspaceId}
      and a.archived_at is null
    order by a.title asc
  `);
  return (result as unknown as RawRow[]).map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    score: Number(row.score),
    excerpt: firstLine(row.excerpt),
    alreadyLinked: true,
  }));
}

/**
 * The card's links as one list: the edges a person saved (explicit, title
 * order) first, then the machine's nearest neighbours (score order),
 * deduplicated by id — an explicit edge outranks its semantic twin. This is
 * the read the idea modal renders. There is no promotion step to pass, so
 * both kinds are plain links.
 */
export function mergeIdeaLinks(explicit: RelatedNote[], semantic: RelatedNote[]): RelatedNote[] {
  const seen = new Set(explicit.map((row) => row.id));
  return [...explicit, ...semantic.filter((row) => !seen.has(row.id))];
}

export function firstLine(text: string | null): string | null {
  if (!text) return null;
  const line =
    text
      .replace(/\*\*/g, "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? null;
  return line ? line.slice(0, 240) : null;
}

/* ---------------------------------------------------------------------------
 * Canvas reads and writes. The graph canvas shows the same one store: nodes
 * are notes and zettels, edges are artifact_links rows (explicit or semantic).
 * ------------------------------------------------------------------------- */

export type GraphNode = { id: string; title: string; kind: string; excerpt: string | null };
export type GraphEdge = { id: string; source: string; target: string; linkType: string; score: number | null };

const GRAPH_NODE_LIMIT = 150;

export async function listCardGraph(
  auth: AuthContext,
  options: { documentIds?: string[] } = {},
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const filters = [
    eq(artifacts.workspaceId, auth.workspaceId),
    inArray(artifacts.kind, ["note", "zettel", "document", "memo", "report", "transcript"]),
    sql`artifacts.archived_at is null`,
  ];
  if (options.documentIds) {
    if (options.documentIds.length === 0) return { nodes: [], edges: [] };
    const sourceRows = await db
      .select({ artifactId: artifactLinks.artifactId })
      .from(artifactLinks)
      .where(
        and(
          eq(artifactLinks.workspaceId, auth.workspaceId),
          eq(artifactLinks.targetType, "document"),
          eq(artifactLinks.linkType, "source"),
          inArray(artifactLinks.targetId, options.documentIds),
        ),
      );
    const sourceArtifactIds = [...new Set(sourceRows.map((row) => row.artifactId))];
    if (sourceArtifactIds.length === 0) return { nodes: [], edges: [] };
    filters.push(inArray(artifacts.id, sourceArtifactIds));
  }
  const rows = await db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      kind: artifacts.kind,
      excerpt: artifactVersions.plainText,
    })
    .from(artifacts)
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(and(...filters))
    .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
    .limit(GRAPH_NODE_LIMIT);
  const nodes = rows.map((row) => ({ id: row.id, title: row.title, kind: row.kind, excerpt: firstLine(row.excerpt) }));
  if (!nodes.length) return { nodes, edges: [] };
  const ids = nodes.map((node) => node.id);
  const edges = await db
    .select({
      id: artifactLinks.id,
      source: artifactLinks.artifactId,
      target: artifactLinks.targetId,
      linkType: artifactLinks.linkType,
      score: artifactLinks.score,
    })
    .from(artifactLinks)
    .where(
      and(
        eq(artifactLinks.workspaceId, auth.workspaceId),
        inArray(artifactLinks.artifactId, ids),
        inArray(artifactLinks.targetId, ids),
        ne(artifactLinks.linkType, "dismissed"),
      ),
    );
  return { nodes, edges };
}

/**
 * Tie two cards with an explicit 'related' edge. Links are automatic now, so
 * this is the one place a person overrides the machine: any edge already
 * joining the pair — a semantic neighbour included — becomes the explicit
 * one, direction normalized to viewer -> target. Tying a pair once rejected
 * (a legacy dismissed edge) is a fresh decision, not a state to remember.
 */
export async function linkCards(auth: AuthContext, input: { artifactId: string; targetId: string }): Promise<void> {
  if (input.artifactId === input.targetId) return;
  await withTransaction(async (tx) => {
    const existing = await tx
      .select({ id: artifactLinks.id, from: artifactLinks.artifactId })
      .from(artifactLinks)
      .where(pairWhere(auth.workspaceId, input.artifactId, input.targetId));
    const [target] = await tx
      .select({ title: artifacts.title, kind: artifacts.kind })
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.id, input.targetId)));
    if (existing.length) {
      const forward = existing.find((r) => r.from === input.artifactId) ?? existing[0];
      const extras = existing.filter((r) => r.id !== forward.id).map((r) => r.id);
      if (extras.length) await tx.delete(artifactLinks).where(inArray(artifactLinks.id, extras));
      await tx
        .update(artifactLinks)
        .set({
          artifactId: input.artifactId,
          targetId: input.targetId,
          targetType: target?.kind ?? "note",
          label: target?.title ?? "",
          linkType: "related",
          context: null,
        })
        .where(eq(artifactLinks.id, forward.id));
      return;
    }
    const found = await tx
      .select({ id: artifacts.id, title: artifacts.title, kind: artifacts.kind })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.workspaceId, auth.workspaceId),
          inArray(artifacts.id, [input.artifactId, input.targetId]),
          inArray(artifacts.kind, ["note", "zettel"]),
        ),
      );
    if (found.length !== 2 || !target) throw new Error("Both cards must be notes or zettels in this workspace.");
    await tx
      .insert(artifactLinks)
      .values({
        workspaceId: auth.workspaceId,
        artifactId: input.artifactId,
        targetType: target.kind,
        targetId: input.targetId,
        label: target.title,
        linkType: "related",
      })
      .onConflictDoNothing();
  });
}

/* ---------------------------------------------------------------------------
 * Curating links (ASH-110 section 6): similarity is not a relationship. The
 * owner names what a link means and why or removes a link; none of it
 * touches either note.
 * ------------------------------------------------------------------------- */

export { RELATION_TYPES, RELATION_LABELS, type RelationType } from "./relation-vocabulary";
import type { RelationType } from "./relation-vocabulary";

export class LinkEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkEditError";
  }
}

const pairWhere = (workspaceId: string, a: string, b: string) =>
  and(
    eq(artifactLinks.workspaceId, workspaceId),
    or(
      and(eq(artifactLinks.artifactId, a), eq(artifactLinks.targetId, b)),
      and(eq(artifactLinks.artifactId, b), eq(artifactLinks.targetId, a)),
    ),
  );

/** Name what an accepted link means and why. A [[wiki]] link keeps its text-managed type until retyped here. */
export async function setLinkRelation(
  auth: AuthContext,
  input: { artifactId: string; targetId: string; linkType: RelationType; why?: string },
): Promise<void> {
  const why = input.why?.trim().slice(0, 500) || null;
  const rows = await db
    .update(artifactLinks)
    .set({ linkType: input.linkType, context: why })
    .where(
      and(
        pairWhere(auth.workspaceId, input.artifactId, input.targetId),
        notInArray(artifactLinks.linkType, ["semantic"]),
      ),
    )
    .returning({ id: artifactLinks.id });
  if (!rows.length) throw new LinkEditError("There is no link between those cards.");
}

/** Remove a curated link. A [[wiki]] link lives in the note text, so it is removed there. */
export async function removeLink(auth: AuthContext, input: { artifactId: string; targetId: string }): Promise<void> {
  const rows = await db
    .delete(artifactLinks)
    .where(
      and(
        pairWhere(auth.workspaceId, input.artifactId, input.targetId),
        notInArray(artifactLinks.linkType, ["semantic", "reference"]),
      ),
    )
    .returning({ id: artifactLinks.id });
  if (!rows.length)
    throw new LinkEditError("Remove a [[wiki link]] by editing the note text; there is no curated link to remove.");
}
