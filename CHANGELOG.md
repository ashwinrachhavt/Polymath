# Changelog

## Unreleased

### Fixed

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
