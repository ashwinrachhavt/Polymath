# understanding

Owns what the Polymath plugin for Claude Code and Codex leaves behind: code explainers, their checks, the person's plugin preferences, and what they already understand. The plugin itself lives in `plugins/polymath/`; it talks to `/api/v1/understanding/*` with an API key.

## An explainer

`requestExplainer` accepts a diff and the coding session's summary and returns at once. The `code_explainers` row exists from then on; a generation job (`understanding.explain`, `explainer-job.ts`) fills it in:

1. The model writes the parts of a literate diff (`explainer-format.ts`): background, intuition, the changes as a story, risks, concepts. `verifiedParts` drops any `path:line` reference to a file the diff never touched.
2. The note is created like any note, tagged `explainer`, `repo:<owner/name>` and `commit:<sha7>`, with the repo, commit and concept ids in its metadata.
3. An archived document holds the same Markdown as a succeeded extraction. It exists only because a quiz is made from a document's extraction; archiving keeps it out of the library.
4. `generateQuiz` makes the check (count and difficulty from the person's preferences), so every question's quote is verified against the explainer's text like any other quiz.

An explainer is `ready` once its quiz exists. A retried job resumes after whichever step already landed.

## The check

`submitCheck` grades through `completeQuizAttempt`, the same server-side fold the Learn screen uses, so answering in the terminal and in the app are one thing. `recordCheckOutcome` runs after either: the missed questions become flashcards in a deck due at once (`review.ts`, the only place that decides where review items go), and the concepts they tested are named back. A sitting passes at four right in five (`PASS_MARK`).

## Who is acting

An API key is not a person. `actingAuth` resolves the plugin to the person who minted the key, as a member; a key nobody minted is refused. Attempts, review schedules and jobs all name that person.

## What the person knows

`knownConcepts` reads graded answers only. `known`: the latest sitting on the concept had no miss, or an unaided answer was graded correct. `shaky`: the latest sitting had a miss. `unassessed`: nothing answered yet. Agents use it to skip background the person already has.

## Preferences

`understanding_preferences`, one row per person, every switch off or smallest by default: suggest an explainer after a large commit, warn before a push whose commit has no passed check (never blocks), question count (5 to 10), difficulty. Set in Settings, read by the plugin over the API.
