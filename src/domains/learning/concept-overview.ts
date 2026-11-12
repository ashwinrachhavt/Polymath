import { sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { deriveConceptStatus, type ConceptCoverage, type ConceptStatus } from "./concept-status";
/*
 * The concept screen's one read: every concept in the workspace with the
 * items that cover it, the attempts made on those items, and the unaided
 * answers that prove it. Shaped as a handful of set queries rather than a
 * per-concept loop, so a workspace with hundreds of concepts still reads in
 * one pass.
 *
 * Evidence rules, all from stored rows:
 * - a concept's quiz attempts are the attempts on quizzes holding a question
 *   linked to it;
 * - an unaided correct answer is a quiz answer that was right in that attempt,
 *   or an Explain It turn (or mock answer) graded correct - free answers
 *   written from memory, never multiple-choice, and never uncertain;
 * - an older item with no concept link is counted once, at the workspace
 *   level, and never against a concept.
 */

type ConceptItemLink = { kind: "quiz" | "deck" | "explain"; label: string; href: string };

export type ConceptOverviewRow = {
  conceptId: string;
  term: string;
  status: ConceptStatus;
  coverage: ConceptCoverage;
  /** Attempts whose answers were correct with no help, across all linked items. */
  unaidedCorrect: number;
  /** Distinct items linked to the concept with at least one stored attempt. */
  attemptCount: number;
  /** The most recent attempt on any linked item, or the item's own creation when never attempted. */
  lastSeenAt: Date | null;
  /** Up to one destination per kind, so a card can link straight into what covers it. */
  items: ConceptItemLink[];
};

export type ConceptOverview = {
  concepts: ConceptOverviewRow[];
  /** Items made before concepts were recorded. Counted separately, never as failures. */
  unlinked: { questions: number; cards: number; explanations: number };
};

type CoverageRow = {
  concept_id: string;
  questions: number;
  cards: number;
  explanations: number;
};

type AttemptsRow = {
  concept_id: string;
  attempt_count: number;
  unaided_correct: number;
  /** Raw SQL returns a timestamp column as an ISO string, not a Date. */
  last_seen_at: string | Date | null;
};

type ItemRow = {
  concept_id: string;
  kind: "quiz" | "deck" | "explain";
  label: string;
  subject_id: string;
  notebook_id: string | null;
};

/**
 * Concepts, coverage, evidence and one destination per item kind, for the
 * concept screen. Scoped to the workspace. A concept is listed when an item
 * covers it or a Mission plans it - the Mission's concepts are work the person
 * is doing even before an item exists for them. Coverage still reports zero;
 * status stays unassessed until something is answered.
 */
export async function getConceptOverview(auth: AuthContext): Promise<ConceptOverview> {
  const coverageRows = await db.execute<CoverageRow>(sql`
    select cl.concept_id,
      count(distinct cl.quiz_question_id)::int as questions,
      count(distinct cl.flashcard_id)::int as cards,
      count(distinct cl.explain_turn_id)::int as explanations
    from concept_links cl
    where cl.workspace_id = ${auth.workspaceId}
    group by cl.concept_id
  `);

  // Concepts a Mission plans, at zero coverage. `coalesce` below keeps an
  // item-backed concept's real counts when it is also in a Mission. A deleted
  // (archived) Mission no longer plans anything.
  const missionRows = await db.execute<{ concept_id: string }>(sql`
    select distinct mc.concept_id
    from mission_concepts mc
    join missions m on m.id = mc.mission_id
    where mc.workspace_id = ${auth.workspaceId} and m.status <> 'archived'
  `);

  const attemptRows = await db.execute<AttemptsRow>(sql`
    with linked_quiz as (
      select distinct cl.concept_id, cl.quiz_question_id, qq.quiz_id
      from concept_links cl
      join quiz_questions qq on qq.id = cl.quiz_question_id
      where cl.workspace_id = ${auth.workspaceId} and cl.quiz_question_id is not null
    ),
    quiz_evidence as (
      select lq.concept_id,
        count(distinct qa.id)::int as attempt_count,
        coalesce(sum((
          select count(*) from jsonb_array_elements(qa.answers) as a
          where (a->>'questionId')::uuid = lq.quiz_question_id
            and coalesce((a->>'dontKnow')::boolean, false) = false
            and exists (
              select 1 from quiz_questions qq
              where qq.id = lq.quiz_question_id and qq.answer_value = a->>'selectedValue'
            )
        )), 0)::int as unaided_correct,
        max(qa.created_at) as last_seen_at
      from linked_quiz lq
      join quiz_attempts qa on qa.quiz_id = lq.quiz_id and qa.user_id = ${auth.userId}
      group by lq.concept_id
    ),
    explain_evidence as (
      select cl.concept_id,
        count(distinct et.id) filter (where et.answer is not null)::int as attempt_count,
        count(distinct et.id) filter (where et.grade = 'correct')::int as unaided_correct,
        max(coalesce(et.updated_at, et.created_at)) filter (where et.answer is not null) as last_seen_at
      from concept_links cl
      join explain_turns et on et.id = cl.explain_turn_id
      join explain_sessions es on es.id = et.session_id and es.user_id = ${auth.userId}
      where cl.workspace_id = ${auth.workspaceId} and cl.explain_turn_id is not null
      group by cl.concept_id
    ),
    mock_evidence as (
      select mc.concept_id,
        count(distinct mq.id) filter (where mq.answer is not null)::int as attempt_count,
        count(distinct mq.id) filter (where mq.grade = 'correct')::int as unaided_correct,
        max(mq.created_at) filter (where mq.answer is not null) as last_seen_at
      from mission_mock_questions mq
      join mission_concepts mc on mc.id = mq.mission_concept_id
      join mission_mock_sessions ms on ms.id = mq.session_id and ms.user_id = ${auth.userId}
      where mq.workspace_id = ${auth.workspaceId}
      group by mc.concept_id
    ),
    all_evidence as (
      select * from quiz_evidence
      union all select * from explain_evidence
      union all select * from mock_evidence
    )
    select concept_id,
      sum(attempt_count)::int as attempt_count,
      sum(unaided_correct)::int as unaided_correct,
      max(last_seen_at) as last_seen_at
    from all_evidence
    group by concept_id
  `);

  const itemRows = await db.execute<ItemRow>(sql`
    with linked as (
      select cl.concept_id, 'quiz' as kind, q.id as subject_id, q.notebook_id, q.title as label,
             row_number() over (partition by cl.concept_id order by q.created_at desc) as rn
      from concept_links cl
      join quiz_questions qq on qq.id = cl.quiz_question_id
      join quizzes q on q.id = qq.quiz_id
      where cl.workspace_id = ${auth.workspaceId} and cl.quiz_question_id is not null
      union all
      select cl.concept_id, 'deck' as kind, d.id as subject_id, d.notebook_id, d.title as label,
             row_number() over (partition by cl.concept_id order by d.created_at desc) as rn
      from concept_links cl
      join flashcards f on f.id = cl.flashcard_id
      join flashcard_decks d on d.id = f.deck_id
      where cl.workspace_id = ${auth.workspaceId} and cl.flashcard_id is not null
      union all
      select cl.concept_id, 'explain' as kind, es.id as subject_id, es.notebook_id,
             coalesce((es.source_manifest->0->>'title'), 'Explain It') as label,
             row_number() over (partition by cl.concept_id order by es.created_at desc) as rn
      from concept_links cl
      join explain_turns et on et.id = cl.explain_turn_id
      join explain_sessions es on es.id = et.session_id
      where cl.workspace_id = ${auth.workspaceId} and cl.explain_turn_id is not null
    )
    select concept_id, kind, subject_id, notebook_id, label from linked where rn = 1
  `);

  const termRows = await db.execute<{ id: string; term: string }>(sql`
    select id, term from concepts
    where workspace_id = ${auth.workspaceId} and sense = 'domain'
  `);
  const termById = new Map(termRows.map((row) => [row.id, row.term]));

  const unlinkedRows = await db.execute<{ questions: number; cards: number; explanations: number }>(sql`
    select
      (select count(*) from quiz_questions qq join quizzes q on q.id = qq.quiz_id
        where q.workspace_id = ${auth.workspaceId} and not exists (select 1 from concept_links cl where cl.quiz_question_id = qq.id))::int as questions,
      (select count(*) from flashcards f join flashcard_decks d on d.id = f.deck_id
        where d.workspace_id = ${auth.workspaceId} and not exists (select 1 from concept_links cl where cl.flashcard_id = f.id))::int as cards,
      (select count(*) from explain_turns et join explain_sessions es on es.id = et.session_id
        where es.workspace_id = ${auth.workspaceId} and not exists (select 1 from concept_links cl where cl.explain_turn_id = et.id))::int as explanations
  `);

  const attemptsByConcept = new Map(attemptRows.map((row) => [row.concept_id, row]));
  const itemsByConcept = new Map<string, ConceptItemLink[]>();
  for (const row of itemRows) {
    const list = itemsByConcept.get(row.concept_id) ?? [];
    list.push({ kind: row.kind, label: row.label, href: itemHref(row) });
    itemsByConcept.set(row.concept_id, list);
  }

  // A concept with no item yet but in a Mission is still shown, at zero
  // coverage; the Mission's own concepts are things the person is working on.
  const coverageById = new Map(coverageRows.map((row) => [row.concept_id, row]));
  const conceptIds = new Set([...coverageById.keys(), ...missionRows.map((row) => row.concept_id)]);

  const concepts = [...conceptIds]
    .map((conceptId): ConceptOverviewRow => {
      const row = coverageById.get(conceptId) ?? { concept_id: conceptId, questions: 0, cards: 0, explanations: 0 };
      const coverage = { questions: row.questions, cards: row.cards, explanations: row.explanations };
      const evidence = attemptsByConcept.get(conceptId);
      const attemptCount = evidence?.attempt_count ?? 0;
      const unaidedCorrect = evidence?.unaided_correct ?? 0;
      return {
        conceptId,
        term: termById.get(conceptId) ?? "Unnamed concept",
        status: deriveConceptStatus({ unaidedCorrect, attemptCount }),
        coverage,
        unaidedCorrect,
        attemptCount,
        lastSeenAt: evidence?.last_seen_at ? new Date(evidence.last_seen_at) : null,
        items: itemsByConcept.get(conceptId) ?? [],
      };
    })
    .sort((a, b) => {
      // Proven last: what still needs work is what the screen is for.
      const rank = { unassessed: 0, practised: 1, proven: 2 } as const;
      return rank[a.status] - rank[b.status] || a.term.localeCompare(b.term);
    });

  const unlinked = unlinkedRows[0] ?? { questions: 0, cards: 0, explanations: 0 };
  return { concepts, unlinked };
}

/**
 * Where a concept's item opens: a quiz runs on its own page when it was made
 * outside a Notebook; a deck is reviewed inside its Notebook or on Learn; an
 * explanation reopens its session inside the Notebook it belongs to.
 */
function itemHref(row: ItemRow): string {
  if (row.kind === "explain") return `/projects/${row.notebook_id}/notebook/explain?session=${row.subject_id}`;
  if (row.kind === "deck") {
    return row.notebook_id
      ? `/projects/${row.notebook_id}/notebook/flashcards?deck=${row.subject_id}`
      : `/learn/decks/${row.subject_id}`;
  }
  return `/learn/quizzes/${row.subject_id}`;
}
