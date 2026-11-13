# learning

Owns quiz, Explain It, flashcard, and graph-recall records plus source pinning, server grading, and personal recall schedules. Notebook owns source selection and learning creation. Home's Up next card (`up-next.ts`) names the one place to continue (due cards, then a Notebook quiz never sat, opened inside its Notebook) and the learning streak; `/learn` lists everything due across Notebooks; legacy `/learn/:documentId` routes remain readable for existing quizzes. Tables are in `schema.ts`; server actions call this domain and UI reads through its queries.

## The trust boundary

The model proposes questions, the domain verifies them (`generate-quiz.ts`). Each question names one source in the immutable quiz manifest. `verifyQuizAcrossSources` re-locates the question's evidence quote in that exact extraction (normalized matching tolerates markdown links, citation markers, and whitespace; paraphrase is not accepted, see `locate-quote.ts`) and drops what it cannot prove. Fewer than three proven questions
is an honest typed failure (`insufficient_evidence`), never a padded quiz.
This is the reading summary's discipline (ASH-292) with one deviation: there
is no generate-then-accept split, because a quiz is low-stakes, regenerable,
quota-gated content. A quiz request key replays a completed generation instead of adding another row. Starting a deliberate new quiz uses a new key.

## How many items

Quizzes and flashcard decks take an exact count from 5 to 100, or scale with the selected sources when none is given (`item-count.ts`: about one item per 600 characters, 20 to 50 for a substantial source, never padded for a short one). Generation runs in sequential batches of at most 25. A model call sees at most 12,000 characters, so batch k of a long source reads its k-th window (`integrations/learning/source-window.ts`), spread evenly from start to end; quotes still verify against the full text. Each later batch is told the prompts already made, and repeats are dropped by prompt. A batch that adds fewer than half the items it asked for ends the run, so a thin source gives fewer items rather than an error.

Every result says how many items were requested and why the run stopped: `complete`, `source_exhausted` (the sources support no more) or `batch_failed` (a later model call failed, so more may exist). Both are stored on the row (`requested_count`, `stopped_by`) and replays return them.

Flashcards are stored after every batch. The deck row, its first cards and its audit row commit together; `stopped_by` stays null until the run ends, so a replay mid-run reads `in_progress`, and a deck left unfinished for more than 10 minutes (the run died) reads `batch_failed`. Either way its stored cards are a usable deck. A quiz is stored once at the end, because grading needs every question answered and a quiz never grows after someone can sit it.

## Grading and the award

`gradeAttempt` (`grading.ts`) is a pure fold: value-keyed (display-order
shuffling cannot corrupt a score), `dontKnow` never correct, no I/O. The
server re-grades every completion through it; a client-supplied score has no
path into `quiz_attempts`.

`completeQuizAttempt` (`commands.ts`) is the completeTask shape: one
transaction writes the attempt, the audit row, and the coins it earned
(`awardCoins` in the stones domain; the score is the server's grade).
Replaying an attempt's idempotency key returns the original attempt and pays
nothing; rating a flashcard and finishing a mock interview pay coins the same
way, inside their own transactions.

## Other learning modes

Explain It sessions pin exact extraction versions, evaluate free responses against those sources, store cited evidence, and adapt the next question. A missing or conflicting quote yields an explicit uncertain result. Flashcard content is shared, but due dates and Again/Hard/Good/Easy ratings are private per user. The relationship-recall exercise grades only against saved non-machine graph links and stores attempts separately from the link records. React Flow synthesis reuses the existing Zettel command and source links.

## What an item is about

Every quiz question, flashcard and Explain It question names the one concept it tests. A concept is a row of the knowledge `concepts` table (sense `domain`), the same row an Idea upserts, so an Idea and the questions about it share one id; names match whatever their letter case (`knowledge/concepts.ts`). `concept_links` joins a concept to exactly one item and is written in the transaction that stores the item (`concept-links.ts`). A proposed question or card that names no concept is dropped like any other unproven proposal. Items made before the link existed have no row, and a reader treats that as unassessed, never as a wrong answer.
