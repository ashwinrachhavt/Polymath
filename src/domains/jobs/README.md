# jobs

Owns background work a person asked for and does not wait on: making a quiz or a deck, a mission's concepts, reading a site, absorbing a video, zettelizing a capture. One table (`generation_jobs`), one state machine, one progress channel. A domain that has long work adds a job kind; it never builds its own queue, status column or polling loop.

## The record

One row per job (`schema.ts`). The row is the whole truth: a page opened after the work finished shows what a page that watched it showed.

| Field                     | Meaning                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `kind`                    | Selects the runner (`runners.ts`), e.g. `knowledge.crawl`.                                                     |
| `subject`                 | What the work is for, when a surface lists one thing's jobs: `capture:<id>`, `document:<id>`, `notebook:<id>`. |
| `idempotency_key`         | The caller's intent, unique per workspace. A repeated submit returns the first job.                            |
| `status`, `attempt`       | The state machine below. `attempt` fences a run that outlived its retry.                                       |
| `progress`, `progress_at` | The running attempt's latest step: `{ step: "Crawling", done: 12, total: 25 }`.                                |
| `result` / `error`        | Where the finished thing lives and what to say about it / authored failure copy.                               |
| `heartbeat_at`            | Bumped while a run is alive; 90 s of silence reads as failed with a retry.                                     |

## States

```
queued --claim--> running --settle--> ready
  |                  |
  |                  +----settle----> failed ----retry--> queued
  |                  |
  +-----cancel-------+----cancel----> cancelled --retry--> queued
```

`state.ts` holds the table; every command guards its update with it. A stalled running job (silent heartbeat) is shown as failed and may be retried. Cancelling settles the row at once; the runner sees `run.signal` abort at its next progress report or heartbeat and stops, and the attempt fence keeps anything it finishes afterwards from landing.

## Who does what

- **Submit** (`commands.ts`): `submitGenerationJob(auth, { kind, subject, idempotencyKey, title, input }, tx?)` writes the job and its outbox event in one transaction, so accepted work is never lost. Pass `tx` to accept the job with the thing it works on. `submitOrRetryGenerationJob` is for one-job-per-thing work (a capture's crawl, a video's absorption), where asking again means trying again.
- **Start**: `kickGenerationJob` (`kick.ts`) runs the attempt after the response has gone. The outbox event (`generation.job_requested`) is the guarantee if that process dies; a watching tab starts a job still queued after 20 s.
- **Run** (`runGenerationJob`): claims the attempt with a conditional update, so the worker and an inline start never both do the work. The runner gets `run.progress(step, counts)`, `run.signal` and `run.generationKey` (pass it wherever the work takes an idempotency key). Throw `GenerationJobFailure` for copy the person can read; any other error fails with generic copy. Failures never retry on their own: the person retries.
- **Verbs** (`actions.ts`): retry, cancel, dismiss, list recent. Every verb is scoped to the job's maker.

## The progress channel

`GET /api/v1/generation-jobs/stream` is Server-Sent Events, one per tab (`stream.ts`). The server tails the table for rows whose status or progress changed (`updated_at`, `progress_at`) and sends each new state once (`jobSignature`); the frame id is the database time of the read, so a reconnect resumes from `Last-Event-ID`. There is no LISTEN/NOTIFY: the deployed database sits behind a transaction-mode pooler. The browser keeps one store (`components/jobs/generation-jobs.tsx`); every surface reads it.

## Where jobs show

- The top bar's jobs indicator (`components/jobs/jobs-indicator.tsx`): a mark that turns while anything runs, with a count, and closes into a check (or a cross) when the last one settles. It opens a panel of running and recent jobs.
- The Activity page's "Background work" section, the same rows.
- The surface the result lands on (`useSurfaceJobs` + `GenerationJobRows`): Learn, a Notebook, a capture's site, a zettelize click.

All three render `JobRow`: mark, title, live step and bar, and the verbs its state allows. A settled job toasts with a link to its result.

## Kinds

| Kind                                   | Owner                            | What it does                                                                                                                                                                       |
| -------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `learning.quiz`, `learning.flashcards` | learning                         | Make a quiz or deck from sources.                                                                                                                                                  |
| `learning.mission.*`                   | learning                         | A mission's concepts.                                                                                                                                                              |
| `knowledge.crawl`                      | knowledge (`site-crawl.ts`)      | Crawl a site with Firecrawl (25 pages, two links deep, same site, no assets) and file each page as a document; a capture's pages become its child documents (`capture_documents`). |
| `knowledge.youtube`                    | knowledge (`youtube-absorb.ts`)  | The shared captions cache (`video_transcripts`), else the video's captions; file the transcript and its cues. A video with no captions is skipped, said plainly.                   |
| `zettels.source`                       | capture (`zettel-generation.ts`) | File a capture or document and write its zettel cards.                                                                                                                             |

Not jobs, on purpose: a capture's own page read and classification (`capture.url_content_requested`, `capture.enrichment_requested`) are seconds long and have their own state on the capture row; agent runs have their own runtime (`domains/agents`).
