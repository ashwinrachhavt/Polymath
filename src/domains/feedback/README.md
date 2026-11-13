# feedback

Owns `llm_feedback`: one person's 1–5 rating (😞 to 😄) of one model output,
with an optional note. Every surface that shows generated text rates through
this domain — chat replies (the `run_events` row the reply was written to),
quizzes, flashcard decks, Explain It verdicts and artifacts — via the one
client control (`components/feedback/output-rating.tsx`) and the one server
action (`rate-output-action.ts`).

- **One rating per person per output.** `output_id` is the single output
  foreign key that is set (generated column), and the unique index on
  `(workspace_id, user_id, output_id)` is the upsert target. A null score
  deletes the row.
- **Provenance is copied, never supplied.** `model` and `prompt_version` are
  read off the output at write time: the run's model and profile revision, the
  quiz's or deck's model and prompt version, the Explain It session's prompt
  version. Artifacts carry neither.
- **Scope.** The output must be in the caller's workspace; an Explain It verdict
  only for the person who sat the session. A missing output and another
  workspace's are the same `null`.
- **Readout.** `/settings/feedback` (admins) shows average and distribution per
  surface, model and prompt version, plus recent notes.
- **Learning loop.** Quiz and flashcard generation read a score ≤ 2 as "not
  helpful"; zettel extraction reads ≥ 4 as helpful and ≤ 2 as not, and ignores 3.

0314 migrated the earlier thumbs (`run_events.feedback`, up → 4, down → 2) and
`artifact_feedback` (helpful → 4, not helpful → 2) into this table and dropped
both. The run-level verdict under a finished run (`run_reviews`, ASH-304) is a
separate signal and is not stored here.
