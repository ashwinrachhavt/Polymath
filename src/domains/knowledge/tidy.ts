import { and, asc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import { enqueueOutbox, type OutboxHandler } from "@/domains/audit/outbox";
import type { AuthContext } from "@/domains/identity/resolve";
import { workspaces } from "@/domains/identity/tables";
import { resolveEmbedding } from "@/domains/billing/resolver";
import { EmbeddingUnconfiguredError } from "@/integrations/embeddings/provider";
import { defaultZettelExtractor, type IdeaComparator } from "@/integrations/zettels/extractor";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { extractWikiLinkTitles } from "./notes";
import { firstLine } from "./relations";
import {
  artifactLinks,
  artifacts,
  TIDY_FINDING_KINDS,
  TIDY_FINDING_STATUSES,
  TIDY_RESOLUTIONS,
  tidyFindings,
} from "./schema";
import { currentExtractionIdSubquery } from "./versions";
import { ZETTEL_DUPLICATE_MAX_DISTANCE, ZETTEL_DUPLICATE_STRONG_DISTANCE } from "./zettel-capacity";

/*
 * Tidy: the agent that keeps notes and ideas trustworthy without chores. It
 * finds ideas that disagree, likely duplicates, ideas whose source changed,
 * and loose ends (notes linked to nothing, [[links]] that point nowhere). It
 * proposes; a person decides. Nothing here deletes or rewrites a note or an
 * idea: the only writes are finding rows, the link between a disagreeing
 * pair, and a review stamp in the artifact's `metadata.tidy` namespace.
 *
 * A finding's lifecycle is one table of transitions (TRANSITIONS below):
 * open -> resolved | dismissed (a person decided) | cleared (the condition
 * went away). Decided rows are never reopened; the unique dedupe key is what
 * makes a later pass find them instead of raising a second row. Only the
 * derivable kinds (source_changed, unlinked, broken_link) are cleared and
 * reopened by the pass; pair kinds are judgments and stay until decided.
 */

export type TidyKind = (typeof TIDY_FINDING_KINDS)[number];
export type TidyStatus = (typeof TIDY_FINDING_STATUSES)[number];
export type TidyResolution = (typeof TIDY_RESOLUTIONS)[number];

const DERIVED_KINDS = ["source_changed", "unlinked", "broken_link"] as const satisfies readonly TidyKind[];
type DerivedKind = (typeof DERIVED_KINDS)[number];
const isDerivedKind = (kind: TidyKind): kind is DerivedKind => (DERIVED_KINDS as readonly string[]).includes(kind);

const uuid = z.string().uuid();
const findingFacts = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("disagreement"), otherId: uuid, detail: z.object({ reason: z.string() }) }),
  z.object({ kind: z.literal("duplicate"), otherId: uuid, detail: z.object({ distance: z.number() }) }),
  z.object({
    kind: z.literal("source_changed"),
    otherId: z.null(),
    detail: z.object({ documentId: uuid, cause: z.enum(["archived", "re_read"]) }),
  }),
  z.object({ kind: z.literal("unlinked"), otherId: z.null(), detail: z.object({}) }),
  z.object({ kind: z.literal("broken_link"), otherId: z.null(), detail: z.object({ linkTitle: z.string() }) }),
]);

/** What a finding says, by kind. Persisted `detail` is parsed against this at every read. */
type TidyFindingFacts = z.infer<typeof findingFacts>;
type SubjectFacts = TidyFindingFacts & { subjectId: string };

/**
 * One row per question asked. A pair has one key whichever order or kind it
 * was judged in, so a disagreement and a duplicate can never both be raised
 * for the same two ideas.
 */
export function findingDedupeKey(finding: SubjectFacts): string {
  switch (finding.kind) {
    case "disagreement":
    case "duplicate": {
      const [a, b] = [finding.subjectId, finding.otherId].sort();
      return `pair:${a}:${b}`;
    }
    case "source_changed":
      return `source_changed:${finding.subjectId}:${finding.detail.documentId}`;
    case "unlinked":
      return `unlinked:${finding.subjectId}`;
    case "broken_link":
      return `broken_link:${finding.subjectId}:${finding.detail.linkTitle.trim().toLowerCase()}`;
  }
}

export type TidyEvent = "resolve" | "dismiss" | "clear" | "reopen";

const TRANSITIONS: Record<TidyStatus, Partial<Record<TidyEvent, TidyStatus>>> = {
  open: { resolve: "resolved", dismiss: "dismissed", clear: "cleared" },
  cleared: { reopen: "open" },
  resolved: {},
  dismissed: {},
};

export class TidyTransitionError extends Error {
  constructor(
    readonly from: TidyStatus,
    readonly event: TidyEvent,
  ) {
    super(`A ${from} finding cannot ${event}.`);
    this.name = "TidyTransitionError";
  }
}

/**
 * The one place a finding's status changes meaning. Only a disagreement is
 * resolved with an outcome; only the derivable kinds clear and reopen.
 */
export function nextStatus(finding: { kind: TidyKind; status: TidyStatus }, event: TidyEvent): TidyStatus {
  const to = TRANSITIONS[finding.status][event];
  const allowedForKind =
    event === "resolve"
      ? finding.kind === "disagreement"
      : event === "clear" || event === "reopen"
        ? isDerivedKind(finding.kind)
        : true;
  if (!to || !allowedForKind) throw new TidyTransitionError(finding.status, event);
  return to;
}

export class TidyFindingNotFoundError extends Error {
  constructor() {
    super("That finding is not open in this workspace.");
    this.name = "TidyFindingNotFoundError";
  }
}

type Conn = TxDrizzle;

/*
 * Converge the pair to exactly one explicit edge, oriented from -> to. Any
 * edge already joining the two (semantic, reference, related) becomes this
 * one, the way linkCards retypes a pair; `source` provenance is never
 * touched.
 */
async function setPairLink(
  conn: Conn,
  auth: AuthContext,
  input: { fromId: string; toId: string; linkType: "contradicts" | "contrasts" | "dismissed"; context: string | null },
): Promise<void> {
  const [target] = await conn
    .select({ title: artifacts.title, kind: artifacts.kind })
    .from(artifacts)
    .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.id, input.toId)))
    .limit(1);
  if (!target) throw new TidyFindingNotFoundError();
  const existing = await conn
    .select({ id: artifactLinks.id, from: artifactLinks.artifactId })
    .from(artifactLinks)
    .where(
      and(
        eq(artifactLinks.workspaceId, auth.workspaceId),
        ne(artifactLinks.linkType, "source"),
        or(
          and(eq(artifactLinks.artifactId, input.fromId), eq(artifactLinks.targetId, input.toId)),
          and(eq(artifactLinks.artifactId, input.toId), eq(artifactLinks.targetId, input.fromId)),
        ),
      ),
    );
  const edge = {
    artifactId: input.fromId,
    targetId: input.toId,
    targetType: target.kind,
    label: target.title,
    linkType: input.linkType,
    context: input.context,
    score: null,
  };
  if (existing.length === 0) {
    await conn.insert(artifactLinks).values({ workspaceId: auth.workspaceId, ...edge });
    return;
  }
  const keep = existing.find((row) => row.from === input.fromId) ?? existing[0];
  const extras = existing.filter((row) => row.id !== keep.id).map((row) => row.id);
  if (extras.length) await conn.delete(artifactLinks).where(inArray(artifactLinks.id, extras));
  await conn.update(artifactLinks).set(edge).where(eq(artifactLinks.id, keep.id));
}

/** Insert a pair finding unless the pair already has one, in any status. True when this call created it. */
async function insertPairFinding(conn: Conn, auth: AuthContext, finding: SubjectFacts): Promise<boolean> {
  const [row] = await conn
    .insert(tidyFindings)
    .values({
      workspaceId: auth.workspaceId,
      kind: finding.kind,
      subjectId: finding.subjectId,
      otherId: finding.otherId,
      detail: finding.detail,
      dedupeKey: findingDedupeKey(finding),
    })
    .onConflictDoNothing({ target: [tidyFindings.workspaceId, tidyFindings.dedupeKey] })
    .returning({ id: tidyFindings.id });
  return Boolean(row);
}

/**
 * Record that two ideas cannot both hold: an open disagreement finding and a
 * `contradicts` link carrying the reason. A pair that already has a finding
 * (open, or decided by the person) is left exactly as it is. Runs on the
 * caller's connection so it commits with whatever created the idea.
 */
export async function recordDisagreement(
  conn: Conn,
  auth: AuthContext,
  input: { subjectId: string; otherId: string; reason: string },
): Promise<boolean> {
  if (input.subjectId === input.otherId) return false;
  const created = await insertPairFinding(conn, auth, {
    kind: "disagreement",
    subjectId: input.subjectId,
    otherId: input.otherId,
    detail: { reason: input.reason },
  });
  if (!created) return false;
  await setPairLink(conn, auth, {
    fromId: input.subjectId,
    toId: input.otherId,
    linkType: "contradicts",
    context: input.reason,
  });
  await recordAudit(
    auth,
    {
      action: "tidy.disagreement_found",
      subjectType: "artifact",
      subjectId: input.subjectId,
      summary: "Found two ideas that disagree",
      metadata: { otherId: input.otherId },
      actorKind: "system",
    },
    conn,
  );
  return true;
}

/* ---------------------------------------------------------------------------
 * The pass.
 * ------------------------------------------------------------------------- */

/** Model comparisons one pass may spend, across every pair it reviews. */
const TIDY_MAX_MODEL_COMPARISONS = 20;
/** Notes and ideas one pass reviews for pairs, oldest-edited first. */
const PAIR_REVIEW_ARTIFACTS = 25;
const PAIR_NEIGHBOURS = 3;
/** Rows one derived rule may produce; past this the rule skips clearing rather than clear on a partial view. */
const DERIVED_SCAN_LIMIT = 500;
const UNLINKED_AFTER_DAYS = 7;

/** What pair review needs: the embedding model whose vectors are compared, and the verdict call. */
export type PairJudge = { embeddingModel: string; compare: IdeaComparator };

async function defaultPairJudge(auth: AuthContext): Promise<PairJudge | null> {
  try {
    const embeddingModel = (await resolveEmbedding(auth.workspaceId)).model;
    const compare = (await defaultZettelExtractor(auth.workspaceId)).compareIdeas;
    return compare ? { embeddingModel, compare } : null;
  } catch (cause) {
    if (cause instanceof EmbeddingUnconfiguredError) return null;
    throw cause;
  }
}

export type TidyPassSummary = {
  pairReview:
    | { status: "skipped"; reason: "no_model" }
    | {
        status: "ran" | "stopped";
        reviewed: number;
        comparisons: number;
        disagreements: number;
        duplicates: number;
        /** Notes and ideas left for the next pass. */
        deferred: number;
        /** Why a stopped review stopped. Provider text can carry account details, so it is logged, never returned. */
        stoppedBy?: "budget" | "comparison_failed";
      };
  /** New or reopened derivable findings, and ones cleared because their condition no longer holds. */
  opened: number;
  cleared: number;
  /** Derived rules that hit their scan bound this pass; their open findings were not cleared. */
  truncated: DerivedKind[];
};

/**
 * One bounded Tidy pass over a workspace. Safe to repeat and to overlap:
 * derived findings reconcile under a per-workspace transaction lock, pair
 * findings are keyed so a second judgment of a pair writes nothing, and a
 * note or idea is stamped reviewed only after every neighbour was judged.
 * Model calls never run inside a transaction. With no model or embedding
 * provider configured, pair review is skipped and the rest still runs.
 */
export async function runTidyPass(
  auth: AuthContext,
  options: { judge?: PairJudge | null } = {},
): Promise<TidyPassSummary> {
  const derived = await reconcileDerivedFindings(auth);
  const judge = options.judge === undefined ? await defaultPairJudge(auth) : options.judge;
  const pairReview: TidyPassSummary["pairReview"] = judge
    ? await reviewPairs(auth, judge)
    : { status: "skipped", reason: "no_model" };
  const summary: TidyPassSummary = { pairReview, ...derived };
  await recordAudit(auth, {
    action: "tidy.pass_completed",
    subjectType: "workspace",
    subjectId: auth.workspaceId,
    summary: "Ran a Tidy pass over notes and ideas",
    metadata: summary,
    actorKind: "system",
  });
  return summary;
}

type PairCandidate = { id: string; title: string; content: string | null; versionId: string };
type Neighbour = { id: string; title: string; content: string | null; distance: number };

async function reviewPairs(auth: AuthContext, judge: PairJudge): Promise<TidyPassSummary["pairReview"]> {
  const candidates = (await db.execute(sql`
    select a.id, a.title, a.current_version_id as "versionId",
      coalesce(c.statement, v.plain_text) as content
    from artifacts a
    left join artifact_versions v on v.id = a.current_version_id
    left join lateral (
      select statement from claims
      where artifact_id = a.id and workspace_id = a.workspace_id and status not in ('rejected', 'retracted')
      order by created_at asc limit 1
    ) c on true
    where a.workspace_id = ${auth.workspaceId}
      and a.kind in ('note', 'zettel')
      and a.archived_at is null
      and a.current_version_id is not null
      and (a.metadata #>> '{tidy,pairsReviewedVersionId}') is distinct from a.current_version_id::text
      and exists (
        select 1 from embeddings e
        where e.workspace_id = a.workspace_id and e.owner_type = 'artifact'
          and e.owner_id = a.id and e.model = ${judge.embeddingModel}
      )
    order by a.updated_at asc, a.id asc
    limit ${PAIR_REVIEW_ARTIFACTS}
  `)) as unknown as PairCandidate[];

  const result = { reviewed: 0, comparisons: 0, disagreements: 0, duplicates: 0, deferred: 0 };
  for (const [index, candidate] of candidates.entries()) {
    const neighbours = await unjudgedNeighbours(auth, candidate.id, judge.embeddingModel);
    let finished = true;
    for (const neighbour of neighbours) {
      if (neighbour.distance <= ZETTEL_DUPLICATE_STRONG_DISTANCE) {
        if (await recordPair(auth, candidate.id, neighbour, { verdict: "same" })) result.duplicates += 1;
        continue;
      }
      if (!candidate.content || !neighbour.content) continue;
      if (result.comparisons >= TIDY_MAX_MODEL_COMPARISONS) {
        finished = false;
        break;
      }
      result.comparisons += 1;
      let verdict;
      try {
        verdict = await judge.compare({
          candidate: { title: candidate.title, content: candidate.content },
          existing: { title: neighbour.title, content: neighbour.content },
        });
      } catch (cause) {
        console.warn("[tidy] idea comparison failed; pair review stops until the next pass", cause);
        result.deferred += candidates.length - index;
        return { status: "stopped", ...result, stoppedBy: "comparison_failed" };
      }
      if (verdict.verdict === "distinct") continue;
      if (await recordPair(auth, candidate.id, neighbour, verdict)) {
        if (verdict.verdict === "same") result.duplicates += 1;
        else result.disagreements += 1;
      }
    }
    if (!finished) {
      result.deferred += candidates.length - index;
      return { status: "stopped", ...result, stoppedBy: "budget" };
    }
    await stampPairsReviewed(auth, candidate);
    result.reviewed += 1;
  }
  return { status: "ran", ...result };
}

/*
 * The nearest other notes and ideas within the duplicate distance, minus the
 * pairs already asked about: a pair with any finding row, or one a person
 * already typed as contradicting, contrasting or not related.
 */
async function unjudgedNeighbours(auth: AuthContext, artifactId: string, model: string): Promise<Neighbour[]> {
  const rows = (await db.execute(sql`
    with mine as (
      select embedding from embeddings
      where workspace_id = ${auth.workspaceId} and owner_type = 'artifact'
        and owner_id = ${artifactId} and model = ${model}
    )
    select b.id, b.title, coalesce(c.statement, v.plain_text) as content,
      min(e.embedding <=> m.embedding) as distance
    from embeddings e
    cross join mine m
    join artifacts b on b.id = e.owner_id and b.workspace_id = ${auth.workspaceId}
    left join artifact_versions v on v.id = b.current_version_id
    left join lateral (
      select statement from claims
      where artifact_id = b.id and workspace_id = b.workspace_id and status not in ('rejected', 'retracted')
      order by created_at asc limit 1
    ) c on true
    where e.workspace_id = ${auth.workspaceId}
      and e.owner_type = 'artifact'
      and e.model = ${model}
      and e.owner_id <> ${artifactId}
      and b.kind in ('note', 'zettel')
      and b.archived_at is null
      and not exists (
        select 1 from tidy_findings f
        where f.workspace_id = ${auth.workspaceId}
          and f.dedupe_key = 'pair:' || least(b.id, ${artifactId}::uuid) || ':' || greatest(b.id, ${artifactId}::uuid)
      )
      and not exists (
        select 1 from artifact_links l
        where l.workspace_id = ${auth.workspaceId}
          and l.link_type in ('contradicts', 'contrasts', 'dismissed')
          and ((l.artifact_id = b.id and l.target_id = ${artifactId}) or (l.artifact_id = ${artifactId} and l.target_id = b.id))
      )
    group by b.id, b.title, c.statement, v.plain_text
    having min(e.embedding <=> m.embedding) <= ${ZETTEL_DUPLICATE_MAX_DISTANCE}
    order by distance asc, b.id asc
    limit ${PAIR_NEIGHBOURS}
  `)) as unknown as Array<Omit<Neighbour, "distance"> & { distance: number | string }>;
  return rows.map((row) => ({ ...row, distance: Number(row.distance) }));
}

async function recordPair(
  auth: AuthContext,
  subjectId: string,
  neighbour: Neighbour,
  verdict: { verdict: "same" } | { verdict: "contradicts"; reason: string },
): Promise<boolean> {
  return withTransaction((tx) =>
    verdict.verdict === "contradicts"
      ? recordDisagreement(tx, auth, { subjectId, otherId: neighbour.id, reason: verdict.reason })
      : insertPairFinding(tx, auth, {
          kind: "duplicate",
          subjectId,
          otherId: neighbour.id,
          detail: { distance: neighbour.distance },
        }),
  );
}

/*
 * A namespaced annotation, not an edit: no new version and no updated_at
 * bump. Conditional on the version that was reviewed, so an edit that lands
 * mid-review leaves the card for the next pass.
 */
async function stampPairsReviewed(auth: AuthContext, candidate: PairCandidate): Promise<void> {
  await db
    .update(artifacts)
    .set({
      metadata: sql`jsonb_set(coalesce(${artifacts.metadata}, '{}'::jsonb), '{tidy}',
        coalesce(${artifacts.metadata}->'tidy', '{}'::jsonb) || jsonb_build_object('pairsReviewedVersionId', ${candidate.versionId}::text))`,
    })
    .where(
      and(
        eq(artifacts.workspaceId, auth.workspaceId),
        eq(artifacts.id, candidate.id),
        eq(artifacts.currentVersionId, candidate.versionId),
      ),
    );
}

/* ---------------------------------------------------------------------------
 * Derived findings: conditions the database can answer without a model.
 * ------------------------------------------------------------------------- */

type DerivedFacts = Extract<SubjectFacts, { kind: DerivedKind }>;

/**
 * A [[Title]] is broken when no live note or idea has that title, compared
 * case-insensitively the way syncNoteLinks resolves it. `resolvable` holds
 * lowercased titles.
 */
export function deriveBrokenLinks(
  notes: Array<{ subjectId: string; titles: string[] }>,
  resolvable: ReadonlySet<string>,
): DerivedFacts[] {
  return notes.flatMap((note) =>
    note.titles
      .filter((title) => !resolvable.has(title.toLowerCase()))
      .map((linkTitle): DerivedFacts => ({
        kind: "broken_link",
        subjectId: note.subjectId,
        otherId: null,
        detail: { linkTitle },
      })),
  );
}

async function deriveFindings(tx: Conn, auth: AuthContext): Promise<Record<DerivedKind, DerivedFacts[] | "truncated">> {
  const limit = DERIVED_SCAN_LIMIT + 1;
  const [archivedSources, reRead, unlinked, linkingNotes] = await Promise.all([
    tx.execute(sql`
      select distinct a.id as "subjectId", d.id as "documentId"
      from artifacts a
      join artifact_links l on l.artifact_id = a.id and l.workspace_id = a.workspace_id
        and l.link_type = 'source' and l.target_type = 'document'
      join documents d on d.id = l.target_id and d.workspace_id = a.workspace_id
      where a.workspace_id = ${auth.workspaceId} and a.kind = 'zettel' and a.archived_at is null
        and d.archived_at is not null
      order by 1, 2
      limit ${limit}
    `),
    // The extraction an idea was made from is stored on its claim evidence;
    // an idea with no evidence row has no lineage to compare and is skipped.
    tx.execute(sql`
      select distinct a.id as "subjectId", documents.id as "documentId"
      from artifacts a
      join claims c on c.artifact_id = a.id and c.workspace_id = a.workspace_id
      join claim_evidence ce on ce.claim_id = c.id and ce.workspace_id = a.workspace_id
      join document_extractions made on made.id = ce.extraction_id
      join documents on documents.id = made.document_id and documents.workspace_id = a.workspace_id
      join document_extractions cur on cur.id = ${currentExtractionIdSubquery()}
      where a.workspace_id = ${auth.workspaceId} and a.kind = 'zettel' and a.archived_at is null
        and documents.archived_at is null
        and cur.id <> made.id and cur.status = 'succeeded' and cur.created_at > made.created_at
      order by 1, 2
      limit ${limit}
    `),
    tx.execute(sql`
      select a.id as "subjectId"
      from artifacts a
      where a.workspace_id = ${auth.workspaceId} and a.kind = 'note' and a.archived_at is null
        and a.created_at < now() - make_interval(days => ${UNLINKED_AFTER_DAYS})
        and not exists (
          select 1 from artifact_links l
          where l.workspace_id = a.workspace_id
            and l.link_type not in ('semantic', 'dismissed', 'source')
            and (l.artifact_id = a.id or l.target_id = a.id)
        )
      order by a.created_at asc, a.id asc
      limit ${limit}
    `),
    tx.execute(sql`
      select a.id as "subjectId", v.plain_text as body
      from artifacts a
      join artifact_versions v on v.id = a.current_version_id
      where a.workspace_id = ${auth.workspaceId} and a.kind = 'note' and a.archived_at is null
        and v.plain_text like '%[[%'
      order by a.created_at asc, a.id asc
      limit ${limit}
    `),
  ]);

  const bounded = <T>(rows: T[]): T[] | "truncated" => (rows.length > DERIVED_SCAN_LIMIT ? "truncated" : rows);
  const sourceRows = (cause: "archived" | "re_read", rows: unknown) =>
    (rows as Array<{ subjectId: string; documentId: string }>).map((row): DerivedFacts => ({
      kind: "source_changed",
      subjectId: row.subjectId,
      otherId: null,
      detail: { documentId: row.documentId, cause },
    }));
  const archived = bounded(sourceRows("archived", archivedSources));
  const reReadRows = bounded(sourceRows("re_read", reRead));

  const notes = linkingNotes as unknown as Array<{ subjectId: string; body: string | null }>;
  let brokenLinks: DerivedFacts[] | "truncated" = "truncated";
  if (notes.length <= DERIVED_SCAN_LIMIT) {
    const linksByNote = notes.map((note) => ({
      subjectId: note.subjectId,
      titles: extractWikiLinkTitles(note.body ?? ""),
    }));
    const wanted = [...new Set(linksByNote.flatMap((note) => note.titles.map((title) => title.toLowerCase())))];
    const found = wanted.length
      ? await tx
          .selectDistinct({ title: sql<string>`lower(${artifacts.title})` })
          .from(artifacts)
          .where(
            and(
              eq(artifacts.workspaceId, auth.workspaceId),
              inArray(artifacts.kind, ["note", "zettel"]),
              isNull(artifacts.archivedAt),
              inArray(sql`lower(${artifacts.title})`, wanted),
            ),
          )
      : [];
    brokenLinks = bounded(deriveBrokenLinks(linksByNote, new Set(found.map((row) => row.title))));
  }

  return {
    // An archived source outranks a re-read of it; both share one key per idea and document.
    source_changed: archived === "truncated" || reReadRows === "truncated" ? "truncated" : [...archived, ...reReadRows],
    unlinked: bounded(
      (unlinked as unknown as Array<{ subjectId: string }>).map((row): DerivedFacts => ({
        kind: "unlinked",
        subjectId: row.subjectId,
        otherId: null,
        detail: {},
      })),
    ),
    broken_link: brokenLinks,
  };
}

async function reconcileDerivedFindings(
  auth: AuthContext,
): Promise<Pick<TidyPassSummary, "opened" | "cleared" | "truncated">> {
  return withTransaction(async (tx) => {
    // Two passes over one workspace serialize here, so neither can clear a
    // finding the other just derived from a newer view.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`tidy:${auth.workspaceId}`}, 0))`);
    const derived = await deriveFindings(tx, auth);
    const truncated = DERIVED_KINDS.filter((kind) => derived[kind] === "truncated");
    const desired = new Map<string, DerivedFacts>();
    for (const kind of DERIVED_KINDS) {
      const rows = derived[kind];
      if (rows === "truncated") continue;
      for (const row of rows) {
        const key = findingDedupeKey(row);
        if (!desired.has(key)) desired.set(key, row);
      }
    }

    const keys = [...desired.keys()];
    const before = keys.length
      ? await tx
          .select({ key: tidyFindings.dedupeKey, status: tidyFindings.status })
          .from(tidyFindings)
          .where(and(eq(tidyFindings.workspaceId, auth.workspaceId), inArray(tidyFindings.dedupeKey, keys)))
      : [];
    const statusOf = new Map(before.map((row) => [row.key, row.status as TidyStatus]));
    // New and still-open findings are written; a cleared one reopens through
    // the transition table; a decided one is left alone.
    const writes = [...desired.entries()].filter(([key, finding]) => {
      const status = statusOf.get(key);
      return (
        status === undefined ||
        status === "open" ||
        (status === "cleared" && nextStatus({ kind: finding.kind, status }, "reopen") === "open")
      );
    });
    const opened = writes.filter(([key]) => statusOf.get(key) !== "open").length;
    if (writes.length) {
      await tx
        .insert(tidyFindings)
        .values(
          writes.map(([dedupeKey, finding]) => ({
            workspaceId: auth.workspaceId,
            kind: finding.kind,
            subjectId: finding.subjectId,
            otherId: null,
            detail: finding.detail,
            dedupeKey,
          })),
        )
        .onConflictDoUpdate({
          target: [tidyFindings.workspaceId, tidyFindings.dedupeKey],
          set: { status: "open", detail: sql`excluded.detail` },
          setWhere: sql`${tidyFindings.status} in ('open', 'cleared')`,
        });
    }

    const clearable = DERIVED_KINDS.filter((kind) => derived[kind] !== "truncated");
    const cleared = clearable.length
      ? await tx
          .update(tidyFindings)
          .set({ status: TRANSITIONS.open.clear })
          .where(
            and(
              eq(tidyFindings.workspaceId, auth.workspaceId),
              eq(tidyFindings.status, "open"),
              inArray(tidyFindings.kind, clearable),
              ...(keys.length ? [notInArray(tidyFindings.dedupeKey, keys)] : []),
            ),
          )
          .returning({ id: tidyFindings.id })
      : [];
    return { opened, cleared: cleared.length, truncated };
  });
}

/* ---------------------------------------------------------------------------
 * Schedule: one pass per workspace per UTC day, through the outbox.
 * ------------------------------------------------------------------------- */

export const TIDY_PASS_TOPIC = "knowledge.tidy_pass_requested";

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/**
 * Enqueue today's pass for every workspace. The dispatch key carries the
 * workspace and the UTC date, so every cron tick after the first in a day
 * enqueues nothing.
 */
export async function scheduleDailyTidyPasses(now: Date = new Date()): Promise<{ enqueued: number }> {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(isNull(workspaces.archivedAt))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id));
  const day = utcDay(now);
  let enqueued = 0;
  await withTransaction(async (tx) => {
    for (const workspace of rows) {
      const result = await enqueueOutbox(
        tx,
        { workspaceId: workspace.id },
        { topic: TIDY_PASS_TOPIC, payload: { day }, dispatchKey: `tidy-pass:${workspace.id}:${day}` },
      );
      if (result.enqueued) enqueued += 1;
    }
  });
  return { enqueued };
}

/** The consumer: one pass as the workspace's owner. A workspace with no owner has no one to propose to. */
export function tidyPassRequestedHandler(
  resolveAuth: (workspaceId: string) => Promise<AuthContext | null>,
): OutboxHandler {
  return async (event) => {
    const auth = await resolveAuth(event.workspaceId);
    if (!auth) return;
    await runTidyPass(auth);
  };
}

/* ---------------------------------------------------------------------------
 * Reads and decisions.
 * ------------------------------------------------------------------------- */

export type TidyArtifactView = {
  id: string;
  title: string;
  kind: "note" | "zettel";
  excerpt: string | null;
  sourceTitle: string | null;
  sourceQuote: string | null;
};

export type TidyFindingView = TidyFindingFacts & {
  id: string;
  createdAt: Date;
  subject: TidyArtifactView;
  other: TidyArtifactView | null;
};

const LIST_LIMIT = 50;

const artifactView = z.object({
  id: uuid,
  title: z.string(),
  kind: z.enum(["note", "zettel"]),
  excerpt: z.string().nullable(),
  sourceTitle: z.string().nullable(),
  sourceQuote: z.string().nullable(),
});
const listedRow = z.object({
  id: uuid,
  kind: z.enum(TIDY_FINDING_KINDS),
  detail: z.unknown(),
  otherId: uuid.nullable(),
  createdAt: z.coerce.date(),
  subject: artifactView,
  other: artifactView.nullable(),
});

const artifactJson = (alias: string) =>
  sql.raw(`json_build_object(
    'id', ${alias}.id, 'title', ${alias}.title, 'kind', ${alias}.kind,
    'excerpt', (select v.plain_text from artifact_versions v where v.id = ${alias}.current_version_id),
    'sourceTitle', (select l.label from artifact_links l where l.artifact_id = ${alias}.id and l.link_type = 'source' order by l.created_at, l.id limit 1),
    'sourceQuote', (select l.context from artifact_links l where l.artifact_id = ${alias}.id and l.link_type = 'source' and l.context is not null order by l.created_at, l.id limit 1)
  )`);

function openFindingsQuery(auth: AuthContext, input: { kind?: TidyKind; limit: number }) {
  return sql`
    select f.id, f.kind, f.detail, f.other_id as "otherId", f.created_at as "createdAt",
      ${artifactJson("s")} as subject,
      case when o.id is null then null else ${artifactJson("o")} end as other,
      count(*) over () as total
    from tidy_findings f
    join artifacts s on s.id = f.subject_id and s.workspace_id = f.workspace_id
    left join artifacts o on o.id = f.other_id and o.workspace_id = f.workspace_id
    where f.workspace_id = ${auth.workspaceId}
      and f.status = 'open'
      and s.archived_at is null
      and s.kind in ('note', 'zettel')
      and (f.other_id is null or (o.id is not null and o.archived_at is null and o.kind in ('note', 'zettel')))
      ${input.kind ? sql`and f.kind = ${input.kind}` : sql``}
    order by f.created_at asc, f.id asc
    limit ${input.limit}
  `;
}

function toView(raw: unknown): TidyFindingView {
  const row = listedRow.parse(raw);
  const facts = findingFacts.parse({ kind: row.kind, otherId: row.otherId, detail: row.detail });
  const shape = (view: z.infer<typeof artifactView>): TidyArtifactView => ({
    ...view,
    excerpt: firstLine(view.excerpt),
  });
  return {
    ...facts,
    id: row.id,
    createdAt: row.createdAt,
    subject: shape(row.subject),
    other: row.other ? shape(row.other) : null,
  };
}

/**
 * The open findings a person can act on, oldest first, with what a row needs
 * to render. A finding whose note or idea was archived is hidden, not
 * deleted: the condition belongs to something no longer in view.
 */
export async function listTidyFindings(auth: AuthContext): Promise<{ findings: TidyFindingView[]; total: number }> {
  const rows = (await db.execute(openFindingsQuery(auth, { limit: LIST_LIMIT }))) as unknown as Array<{
    total: number | string;
  }>;
  return { findings: rows.map(toView), total: rows.length ? Number(rows[0].total) : 0 };
}

/** The disagreement that has waited longest, and how many are open: Home's lesson to resolve. */
export async function oldestOpenDisagreement(
  auth: AuthContext,
): Promise<{ findingId: string; firstTitle: string; secondTitle: string; open: number } | null> {
  const [row] = (await db.execute(openFindingsQuery(auth, { kind: "disagreement", limit: 1 }))) as unknown as Array<{
    total: number | string;
  }>;
  if (!row) return null;
  const view = toView(row);
  if (view.kind !== "disagreement" || !view.other) return null;
  return { findingId: view.id, firstTitle: view.subject.title, secondTitle: view.other.title, open: Number(row.total) };
}

/** Lock one open finding of this workspace for a decision, parsed. */
async function claimOpenFinding(tx: Conn, auth: AuthContext, findingId: string) {
  if (!uuid.safeParse(findingId).success) throw new TidyFindingNotFoundError();
  const [row] = await tx
    .select({
      id: tidyFindings.id,
      kind: tidyFindings.kind,
      status: tidyFindings.status,
      subjectId: tidyFindings.subjectId,
      otherId: tidyFindings.otherId,
      detail: tidyFindings.detail,
    })
    .from(tidyFindings)
    .where(and(eq(tidyFindings.workspaceId, auth.workspaceId), eq(tidyFindings.id, findingId)))
    .for("update")
    .limit(1);
  if (!row) throw new TidyFindingNotFoundError();
  const facts = findingFacts.parse({ kind: row.kind, otherId: row.otherId, detail: row.detail });
  return { id: row.id, subjectId: row.subjectId, status: row.status as TidyStatus, ...facts };
}

async function decide(
  tx: Conn,
  auth: AuthContext,
  finding: { id: string; kind: TidyKind; status: TidyStatus },
  event: "resolve" | "dismiss",
  resolution: { outcome: TidyResolution; note: string | null } | null,
) {
  const status = nextStatus(finding, event);
  await tx
    .update(tidyFindings)
    .set({
      status,
      resolution: resolution?.outcome ?? null,
      resolutionNote: resolution?.note ?? null,
      resolvedAt: new Date(),
      resolvedBy: auth.userId,
    })
    .where(and(eq(tidyFindings.id, finding.id), eq(tidyFindings.status, finding.status)));
}

const MAX_NOTE_CHARS = 500;

/**
 * Settle a disagreement. `first_holds` and `second_holds` keep a
 * `contradicts` link, oriented from the idea that holds to the one it
 * overrides; `both_hold` makes it `contrasts`. The person's note, when
 * given, becomes the link's context. Link and finding change together.
 */
export async function resolveDisagreement(
  auth: AuthContext,
  input: { findingId: string; outcome: TidyResolution; note?: string },
): Promise<void> {
  const note = input.note?.trim().slice(0, MAX_NOTE_CHARS) || null;
  await withTransaction(async (tx) => {
    const finding = await claimOpenFinding(tx, auth, input.findingId);
    if (finding.kind !== "disagreement") throw new TidyTransitionError(finding.status, "resolve");
    const [holds, overridden] =
      input.outcome === "second_holds" ? [finding.otherId, finding.subjectId] : [finding.subjectId, finding.otherId];
    await decide(tx, auth, finding, "resolve", { outcome: input.outcome, note });
    await setPairLink(tx, auth, {
      fromId: holds,
      toId: overridden,
      linkType: input.outcome === "both_hold" ? "contrasts" : "contradicts",
      context: note ?? finding.detail.reason,
    });
    await recordAudit(
      auth,
      {
        action: "tidy.finding_resolved",
        subjectType: "artifact",
        subjectId: finding.subjectId,
        summary: "Settled a disagreement between two ideas",
        metadata: { findingId: finding.id, otherId: finding.otherId, outcome: input.outcome },
      },
      tx,
    );
  });
}

/**
 * The person says this is not a problem. The finding is dismissed for good;
 * for a disagreement the link becomes `dismissed`, so it leaves the graph.
 */
export async function dismissFinding(auth: AuthContext, input: { findingId: string }): Promise<void> {
  await withTransaction(async (tx) => {
    const finding = await claimOpenFinding(tx, auth, input.findingId);
    await decide(tx, auth, finding, "dismiss", null);
    if (finding.kind === "disagreement") {
      await setPairLink(tx, auth, {
        fromId: finding.subjectId,
        toId: finding.otherId,
        linkType: "dismissed",
        context: null,
      });
    }
    await recordAudit(
      auth,
      {
        action: "tidy.finding_dismissed",
        subjectType: "artifact",
        subjectId: finding.subjectId,
        summary: "Marked a Tidy finding as fine",
        metadata: { findingId: finding.id, kind: finding.kind },
      },
      tx,
    );
  });
}
