# Changelog

## 0.3.0 - 2026-10-27

### Added

- Reports: a weekly outcome narrative (ASH-280) restates the week from the
  outcome sentences you wrote on finished focus sessions and the stones you
  earned. It is composed deterministically, not by a model, and carries no
  score, points or streak. Keep as note saves it; Discard writes nothing; an
  empty week shows no narrative.
- Providers: the chat model catalog gains the free tiers the workspace can
  actually call - Cohere (trial), Mistral (free mode), NVIDIA NIM, OVHcloud,
  Z AI, and the AI Gateway's free-tier models - each hidden until its key is
  set, with the probe field saying what verified it. OpenRouter's :free pool
  is reachable through the existing key.
- Search: Parallel's direct Search API (5,000 requests/month, card-backed)
  and the AI Gateway server-tool route (Exa/Tako/Parallel/Perplexity) join
  the adapter seam, both registry-disabled until the spend is opted into.
- Notifications: a panel in the header holds the decision queue, running work
  and the agent audit trail, replacing the Decisions page. The count is read
  on the server per request, so it cannot disagree with the records behind it.
- Work: a board where cards move between lanes by drag, one status patch per
  drop, and a card opens a small dialog rather than the full inspector.
- Work: tomorrow's suggestions, as the shutdown ritual recorded them, with
  Commit and Dismiss. Dismissing archives the seed, so a replayed shutdown
  cannot revive a suggestion you declined.
- Day and Shut down are destinations again, and Spending joins them. Retiring
  Briefing had moved all three onto their own routes and left every one of
  them with no way in.

### Changed

- The front door is the conversation. "/" redirects to the Assistant; the
  decision queue it used to hold lives in the notifications panel.
- The vault reads extracted text as markdown rather than showing its syntax,
  replaces its three review filters with two counts, and makes the empty
  state the upload target. Copy and Save appear on the text itself.

### Removed

- Briefing, its day theatre, and the outcome picker. The shutdown ritual and
  the daybook keep their own routes; the spending ledger keeps its own.
- `daily_outcomes` and the `Outcome:YYYY-MM-DD` tag convention (migration
  0257). Committed-today is a task's own status, which cannot go stale.

### Fixed

- The day record no longer reads the dropped `daily_outcomes` table. The
  query was raw SQL that TypeScript never checked, so the page compiled and
  then returned a 500 for every date (found in review, fixed before ship).
- Search: the provider registry's fail-closed rule is now enforced. A
  disabled entry (parallel's card-backed tier, the gateway's post-promo
  billing) refuses at the gate instead of executing because its key is set,
  and card-backed providers never auto-select without an explicit
  SEARCH_PROVIDER.
- Search: a synthesized AI Gateway answer carries an ai-gateway://
  provenance marker instead of a fabricated citation URL.
- Agents: a run whose frozen model left the catalog fails loudly instead of
  silently answering with the default model.
- Prompts: one shared untrusted-data clause (with a JSON-safe variant for
  the structured-output surfaces) replaces the five drifting inline copies;
  Alfred's and the specialist's instructions carry the untrusted-content
  policy block, and every tool description states when NOT to call it.


- Conversations: a title that started with a pasted link (for example
  "[Note: …](/alfred/notes?note=…) Summarize this") showed the raw markdown on
  the home list, the history menu, the run header and the briefing card. Every
  surface now shows the link's words as plain text.
- Conversations: a run whose turn failed kept saying "running" and offered a
  Stop button under "This conversation has ended". The failed turn now ends
  the conversation cleanly, and the run parks as waiting for input instead of
  running forever.
- Conversations: the Stop button under a live conversation stretched across
  the full page width, reading as a second message box. It is a normal-size
  button now.
- Conversations: the Sources chip on a cited answer counted retrieved
  passages, so one document read as "Sources · 5" with its name repeated five
  times. The chip now counts distinct documents and lists each title once.
- Work: adding a task from the Today quick-add made it look lost — the row
  flashed and vanished because new tasks start in the Inbox, which Today does
  not list. The list now refreshes and says "Added to Inbox. Find it under
  List."
- Notes: list previews showed raw markdown ("# When most projects begin…")
  because the editor sent the markdown source as plain text. Previews now get
  real plain text, and every note shows what you last typed rather than the
  last explicit checkpoint (autosave-only notes no longer show a blank
  preview).
- Polymath: reloading a conversation page spawned orphaned background agent
  sessions (the agent-side "infinite loop"). The health probe is now
  side-effect free.
- Notebook: navigating to a notebook from the rail was non-instant and logged
  a Next.js URL-data warning on every visit. Notebook pages now stream the
  same way Notes does.
- Local development: four integration test suites (semantic relations, zettel
  artifacts, zettel card views, hybrid search) passed in CI but failed on a
  developer machine that had provider API keys set. They now isolate from the
  shell's keys entirely.

- Chrome connector: queued captures are now bound to the destination they
  were saved for (server origin + credential hash, never the credential). An
  account switch, key rotation, or server change parks them as "account
  changed — needs your OK" with an explicit per-capture choice, instead of
  silently delivering the user's words to a different account.
- Chrome connector: a 409 from Polymath is only treated as delivered for a
  URL-only capture whose problem body carries code "conflict" — the server's
  unique index covers every capture with a URL, so a text-bearing 409 means
  the text was rejected, not saved. Those now park as "already in Polymath —
  text not saved" with an explicit save-text-without-link / discard choice.
- Chrome connector: Capture History and Pending Sync refresh live while the
  dashboard is open (storage change subscription + reload on panel show), so
  a drained queue no longer shows a stale "pending sync".
- Chrome connector: the settings access-token field now uses the same styled,
  full-width input as the other fields.

### Added

- The Chrome connector keeps captures safe across deploys: every capture is
  written to a durable on-device outbox before any network attempt, then
  synced in the background with exponential-backoff retries and exactly-once
  idempotency keys. Capture History and toasts now distinguish "Saved on
  this device" from "Synced to Polymath", and the Dashboard has a Pending
  Sync panel with Retry and Discard. Failed or unauthenticated captures park
  for review instead of disappearing (ASH-219).

## [0.2.0] - 2026-10-22

### Added

- A simplified rail: 16 destinations, one calm list. Notes and Document Vault
  sit beside the new Artifacts tab, which lists every kept output the assistant
  generated, filterable by kind and status.
- NotebookLM-pattern capture in the Notebook: an "Add sources" control takes a
  URL, a YouTube link, a file, or a pick from the Document Vault, with visible
  readiness per source (Reading / Ready / Failed) and working Retry.
- Focus sessions start from Work. A task's Focus action opens the session in
  place; pause, resume, and finish live on the same screen, and the reward
  stage renders during the session.
- Notes has its own page at /alfred/notes, with "Write your first page." as
  the empty state and a focused composer.
- Creating a notebook is naming it: the document picker on the create form is
  gone; sources attach in the Notebook itself.
- Dossier generation now requires an Idempotency-Key, so a double click or a
  network retry can never start two paid runs.

### Changed

- Dossiers are now called Notebooks everywhere in the product (the URL stays
  /alfred/dossiers so old links keep working). The Library is now the Document
  Vault. Every piece of material lives in one home by origin: you write it
  (Notes), you uploaded it (Document Vault), the assistant generated it
  (Artifacts), or you pointed at it (Notebook).
- Six removed destinations now redirect: Sources to Notebook, Wiki to Document
  Vault, Spending to Today, Opportunities to People, Focus to Work, and the
  old /alfred/notebook address to Notes.

### Removed

- The Learning feature: the review schedule, its decks and items, the agent
  tools, and the /alfred/learning page are gone, with a migration dropping the
  tables. Quiz and flashcards remain unbuilt by design.

### Fixed

- A run's draft crash when opening a draft that was not a Studio artifact, and
  the same crash class on wiki pages, notes, and malformed links (all now
  render the right empty state instead of a 500).
- Notebook generation now includes URL and YouTube sources pinned by address,
  and they receive their citation links.
- Retry on a failed URL or YouTube source re-runs the fetch instead of
  queueing an extraction that could never succeed.
- A quarantined file upload now reports the quarantine instead of a generic
  upload failure.
