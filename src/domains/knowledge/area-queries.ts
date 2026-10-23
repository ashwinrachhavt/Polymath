import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { areas } from "./schema";

/*
 * Effort and knowledge confidence, computed from live content on every read.
 *
 * Effort counts what the spec counts and no more, with honest scope: notes,
 * manual ([[Title]]) links, and recall activity are measurable today;
 * captures land as notes so they are inside the notes count; focus time is
 * NOT counted - focus sessions join to tasks, not artifacts, so there is no
 * honest artifact-level focus attribution yet.
 *
 * Knowledge confidence is ratios, never volume: recall accuracy over the
 * area's cards and the accepted share of decided claims. The two are shown
 * side by side and never averaged into a single score, and no number here
 * tells anyone they are an expert.
 */

export type AreaState = "empty" | "stale" | "active";

export type AreaListItem = {
  id: string;
  name: string;
  tags: string[];
  version: number;
  state: AreaState;
  effort: { notes: number; manualLinks: number; recallAttempts: number };
  confidence: {
    recallCorrect: number;
    recallTotal: number;
    /**
     * Recall attempts with typed text. The review UI unmounts the attempt
     * field at reveal, so typing provably precedes seeing the answer - but
     * typing is optional and unaided mental recall leaves no trace, so this
     * is "typed before reveal", not the spec's "answers without looking".
     * That measure stays unresolved until a grounded capture exists.
     */
    typedBeforeReveal: number;
    claimsAccepted: number;
    claimsDecided: number;
  };
  lastActivityAt: Date | null;
  /** Effort high, confidence low: the spec's "study rather than read" cue. */
  suggestStudy: boolean;
};

/*
 * The suggestion rule, deliberately fixed and documented: the area shows
 * real effort (at least 5 notes, links and attempts combined), enough
 * recall evidence to read (3+ attempts), and accuracy below 70%.
 */
const SUGGEST_MIN_EFFORT = 5;
const SUGGEST_MIN_ATTEMPTS = 3;
const SUGGEST_MAX_ACCURACY = 0.7;

/** An area is stale when nothing linked to it moved within this window. */
const STALE_DAYS = 14;

type AreaRow = { id: string; name: string; tags: string[]; version: number };

async function measureArea(auth: AuthContext, area: AreaRow) {
  // artifacts.tags is jsonb text[]; overlap with the area's tags links content.
  const [row] = await db.execute<{
    notes: string;
    manual_links: string;
    recall_attempts: string;
    recall_correct: string;
    typed_before_reveal: string;
    claims_decided: string;
    claims_accepted: string;
    last_activity_at: string | null;
  }>(sql`
    with linked as (
      select a.id, a.updated_at from artifacts a
      where a.workspace_id = ${auth.workspaceId}
        and a.kind in ('note', 'zettel')
        and a.archived_at is null
        and exists (
          select 1 from jsonb_array_elements_text(a.tags) t
          -- One JSON parameter, exploded here: binding a JS array as text[]
          -- through the driver does not survive the cast.
          where t in (select jsonb_array_elements_text(${JSON.stringify(area.tags)}::jsonb))
        )
    )
    select
      (select count(*)::text from linked) as notes,
      (select count(*)::text from artifact_links l
        where l.artifact_id in (select id from linked) and l.link_type = 'reference') as manual_links,
      (select count(*)::text from card_reviews r
        join cards c on c.id = r.card_id
        where c.artifact_id in (select id from linked)) as recall_attempts,
      (select count(*)::text from card_reviews r
        join cards c on c.id = r.card_id
        where c.artifact_id in (select id from linked) and r.outcome = 'correct') as recall_correct,
      (select count(*)::text from card_reviews r
        join cards c on c.id = r.card_id
        where c.artifact_id in (select id from linked) and r.response_text is not null) as typed_before_reveal,
      (select count(*)::text from claims cl
        where cl.artifact_id in (select id from linked) and cl.status in ('accepted', 'rejected')) as claims_decided,
      (select count(*)::text from claims cl
        where cl.artifact_id in (select id from linked) and cl.status = 'accepted') as claims_accepted,
      greatest(
        (select max(updated_at) from linked),
        (select max(l.created_at) from artifact_links l where l.artifact_id in (select id from linked)),
        (select max(r.created_at) from card_reviews r
          join cards c on c.id = r.card_id
          where c.artifact_id in (select id from linked))
      ) as last_activity_at
  `);
  const effort = {
    notes: Number(row?.notes ?? 0),
    manualLinks: Number(row?.manual_links ?? 0),
    recallAttempts: Number(row?.recall_attempts ?? 0),
  };
  const confidence = {
    recallCorrect: Number(row?.recall_correct ?? 0),
    recallTotal: effort.recallAttempts,
    typedBeforeReveal: Number(row?.typed_before_reveal ?? 0),
    claimsAccepted: Number(row?.claims_accepted ?? 0),
    claimsDecided: Number(row?.claims_decided ?? 0),
  };
  const lastActivityAt = row?.last_activity_at ? new Date(row.last_activity_at) : null;
  const state: AreaState =
    effort.notes === 0
      ? "empty"
      : !lastActivityAt || Date.now() - lastActivityAt.getTime() > STALE_DAYS * 86_400_000
        ? "stale"
        : "active";
  const effortScore = effort.notes + effort.manualLinks + effort.recallAttempts;
  const accuracy = confidence.recallTotal > 0 ? confidence.recallCorrect / confidence.recallTotal : null;
  const suggestStudy =
    effortScore >= SUGGEST_MIN_EFFORT &&
    confidence.recallTotal >= SUGGEST_MIN_ATTEMPTS &&
    accuracy !== null &&
    accuracy < SUGGEST_MAX_ACCURACY;
  return { effort, confidence, lastActivityAt, state, suggestStudy };
}

/*
 * Scaling, stated rather than assumed: areas are declared by the person,
 * so the expected count is tens, not thousands. The list measures each
 * area with one SQL round trip - 30 declared areas is 30 sequential
 * queries, fine at that scale; if areas ever become machine-generated
 * this must move to a single grouped query. Measured on the scratch
 * database: 50 declared areas with seeded content list in well under a
 * second.
 *
 * Source lifecycle in the totals: archived sources are excluded (a.tags
 * linkage requires a live note/zettel, matching how archived sources
 * leave the review queue), and deleting a source sets cards.artifact_id
 * to null, so its reviews leave the area's totals - the area linkage
 * lived on the source's tags, and pretending otherwise would invent an
 * attribution. Captures and focus time are not counted: unprocessed
 * captures carry no tags, and focus sessions join to tasks, not
 * artifacts. Both would need real linkage before they can be counted
 * honestly.
 */
export async function listAreas(auth: AuthContext): Promise<AreaListItem[]> {
  const rows = await db
    .select({ id: areas.id, name: areas.name, tags: areas.tags, version: areas.version })
    .from(areas)
    .where(and(eq(areas.workspaceId, auth.workspaceId), isNull(areas.archivedAt)))
    .orderBy(asc(areas.name));
  // Areas are few (declared by the person); measure each with one round trip.
  const measured: AreaListItem[] = [];
  for (const area of rows) {
    const m = await measureArea(auth, area);
    measured.push({ ...area, ...m });
  }
  return measured;
}
