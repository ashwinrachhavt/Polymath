import { sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { escapeLike } from "@/lib/list-params";
import { db } from "@/lib/db";

/*
 * What the person already understands, for an agent that wants to skip it.
 * Read from stored answers only - a quiz sitting graded by the server, never a
 * model's guess - and worded in three levels:
 *
 * - known: every answer on the concept in the latest sitting was right, or an
 *   unaided answer (Explain It, mock interview) was graded correct.
 * - shaky: the latest sitting had a miss or "I don't know" on the concept.
 * - unassessed: the concept exists but nothing has been answered about it.
 *
 * "Known" is deliberately about the latest sitting: understanding that was
 * shown once and lost on the next try is not understanding to skip over.
 */

type UnderstandingLevel = "known" | "shaky" | "unassessed";

type KnownConcept = { term: string; level: UnderstandingLevel; correct: number; missed: number };

type Evidence = { correct: number; missed: number; lastCorrect: boolean | null; unaidedCorrect: number };

export function deriveLevel(evidence: Evidence): UnderstandingLevel {
  if (evidence.unaidedCorrect > 0) return "known";
  if (evidence.lastCorrect === true) return "known";
  if (evidence.lastCorrect === false) return "shaky";
  return "unassessed";
}

type Row = {
  term: string;
  correct: number;
  missed: number;
  last_correct: boolean | null;
  unaided_correct: number;
};

/** Concepts in this workspace with the person's answers, optionally narrowed to a topic (a case-insensitive word match on the concept name). */
export async function knownConcepts(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  topic?: string,
  limit = 60,
): Promise<KnownConcept[]> {
  const words = (topic ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3)
    .slice(0, 6);
  const topicFilter =
    words.length === 0
      ? sql``
      : sql`and (${sql.join(
          words.map((word) => sql`lower(c.term) like ${`%${escapeLike(word)}%`}`),
          sql` or `,
        )})`;
  const rows = await db.execute<Row>(sql`
    with answered as (
      select cl.concept_id,
        coalesce((a->>'selectedValue') = qq.answer_value and not coalesce((a->>'dontKnow')::boolean, false), false) as is_correct,
        qa.created_at
      from concept_links cl
      join quiz_questions qq on qq.id = cl.quiz_question_id
      join quiz_attempts qa on qa.quiz_id = qq.quiz_id and qa.user_id = ${auth.userId}
      cross join lateral jsonb_array_elements(qa.answers) as a
      where cl.workspace_id = ${auth.workspaceId} and (a->>'questionId')::uuid = qq.id
    ),
    latest as (
      select concept_id, max(created_at) as at from answered group by concept_id
    ),
    quiz as (
      select a.concept_id,
        count(*) filter (where a.is_correct)::int as correct,
        count(*) filter (where not a.is_correct)::int as missed,
        bool_and(a.is_correct) filter (where a.created_at = l.at) as last_correct
      from answered a join latest l on l.concept_id = a.concept_id
      group by a.concept_id
    ),
    unaided as (
      select cl.concept_id, count(*)::int as unaided_correct
      from concept_links cl
      join explain_turns et on et.id = cl.explain_turn_id and et.grade = 'correct'
      join explain_sessions es on es.id = et.session_id and es.user_id = ${auth.userId}
      where cl.workspace_id = ${auth.workspaceId}
      group by cl.concept_id
    )
    select c.term,
      coalesce(q.correct, 0)::int as correct,
      coalesce(q.missed, 0)::int as missed,
      q.last_correct,
      coalesce(u.unaided_correct, 0)::int as unaided_correct
    from concepts c
    left join quiz q on q.concept_id = c.id
    left join unaided u on u.concept_id = c.id
    where c.workspace_id = ${auth.workspaceId} and c.sense = 'domain' ${topicFilter}
    order by (q.correct is null and q.missed is null), c.updated_at desc, c.term
    limit ${limit}
  `);
  return rows.map((row) => ({
    term: row.term,
    correct: row.correct,
    missed: row.missed,
    level: deriveLevel({
      correct: row.correct,
      missed: row.missed,
      lastCorrect: row.last_correct,
      unaidedCorrect: row.unaided_correct,
    }),
  }));
}
