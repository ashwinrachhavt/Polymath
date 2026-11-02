# learning

Owns: quizzes, quiz questions, quiz attempts, and the quiz generation flow

Turns a captured document's succeeded extraction into a short graded quiz;
completing an attempt earns a stone through the gamification ledger. Tables
are in `schema.ts` and nowhere else; UI code reads them through this domain's
queries rather than joining across domains.

## The trust boundary

The model proposes questions, the domain disposes (`generate-quiz.ts`):
`verifyQuiz` re-locates every question's evidence quote verbatim in the
extraction and drops what it cannot prove. Fewer than three proven questions
is an honest typed failure (`insufficient_evidence`), never a padded quiz.
This is the reading summary's discipline (ASH-292) with one deviation: there
is no generate-then-accept split, because a quiz is low-stakes, regenerable,
quota-gated content. Regeneration writes a new quiz row; the latest ready one
wins.

## Grading and the award

`gradeAttempt` (`grading.ts`) is a pure fold: value-keyed (display-order
shuffling cannot corrupt a score), `dontKnow` never correct, no I/O. The
server re-grades every completion through it; a client-supplied score has no
path into `quiz_attempts`.

`completeQuizAttempt` (`commands.ts`) is the completeTask shape: one
transaction writes the attempt, the audit row, and the stone. The award is
`recordLearningReview` in the gamification domain (`learning_reviewed`,
idempotency key `quiz_attempt:<attemptId>`, 10 points), the same-transaction
twin of the daily Quartz. Replaying an attempt's idempotency key returns the
original attempt; the ledger's unique index makes a double award impossible.

## Non-goals (v1)

No mid-quiz persistence (a refresh restarts the sitting), no multi-select,
no free-text grading, no spaced repetition.
