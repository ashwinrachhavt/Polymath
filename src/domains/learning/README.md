# learning

Owns quiz, Explain It, flashcard, and graph-recall records plus source pinning, server grading, and personal recall schedules. Notebook owns source selection and learning creation. Home's Up next card (`up-next.ts`) names the one place to continue (due cards, then a Notebook quiz never sat, opened inside its Notebook) and the learning streak; `/learn` lists everything due across Notebooks; legacy `/learn/:documentId` routes remain readable for existing quizzes. Tables are in `schema.ts`; server actions call this domain and UI reads through its queries.

## The trust boundary

The model proposes questions, the domain verifies them (`generate-quiz.ts`). Each question names one source in the immutable quiz manifest. `verifyQuizAcrossSources` re-locates the question's evidence quote in that exact extraction (normalized matching tolerates markdown links, citation markers, and whitespace; paraphrase is not accepted, see `locate-quote.ts`) and drops what it cannot prove. Fewer than three proven questions
is an honest typed failure (`insufficient_evidence`), never a padded quiz.
This is the reading summary's discipline (ASH-292) with one deviation: there
is no generate-then-accept split, because a quiz is low-stakes, regenerable,
quota-gated content. A quiz request key replays a completed generation instead of adding another row. Starting a deliberate new quiz uses a new key.

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

## Other learning modes

Explain It sessions pin exact extraction versions, evaluate free responses against those sources, store cited evidence, and adapt the next question. A missing or conflicting quote yields an explicit uncertain result. Flashcard content is shared, but due dates and Again/Hard/Good/Easy ratings are private per user. The relationship-recall exercise grades only against saved non-machine graph links and stores attempts separately from the link records. React Flow synthesis reuses the existing Zettel command and source links.
