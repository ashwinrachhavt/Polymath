# integrations

Owns: integration catalog, external accounts, sync cursors, triggers

Tables are in `schema.ts` and nowhere else — a domain owns its tables, and UI
code reads them through this domain's queries rather than joining across domains
. Enum values are the contract: add a value, never
repurpose one.

## Notion import

`notion.ts` reads Notion into knowledge documents, read-only. A sync given a root page link (`rootPageId`) walks the tree under it (child pages, pages a block links to, rows of embedded databases), each page once, up to 400 pages. Without a root it is the older pass over every shared page by `last_edited_time`.

- **Whole pages.** The reader (`integrations/notion/client.ts`) follows `next_cursor` to the end of every block list and walks nested blocks; a child page or database is its own page, never read into its parent. Reads retry on 429/5xx (writes never do). Limits: 10,000 blocks and 12 levels per page.
- **Honest partial state.** A nested part Notion would not give, or a page over the limits, is named in the sync result and in a note inside the imported text; the page still imports. A page that fails outright is `failed` with its reason and the walk continues.
- **Idempotent.** The document is keyed by the Notion URL; the markdown's sha-256 decides `unchanged`, `updated` (a new file version on the same document, the old blob kept) or `created`. An unchanged page whose extraction never finished is extracted on the next pass. A page removed from Notion stays in the library.
- **Safe retry.** The watermark (no-root pass) advances only through pages finished cleanly and stops before the first failure, so a failed page and anything edited after it is read again. A root sync reads the tree every time (a page's edit does not touch its parent), and the hash keeps that from changing anything. Each root has its own state row (`sync_cursors.resource = "root:<id>"`).
- **Links.** Outside links found in the pages become inbox captures (`source = "import"`, `url-reference`, context pointing back at the Notion page), once each; reading the page behind one is the owner's call, as for any pasted link. Links to Notion pages are not captured.
- **Citations.** `files.provider_object_id` is `<pageId>:<content hash>`, and extractions version by the same hash, so an answer cites the exact imported version.
- **A job.** The Sync control starts `integrations.notion` (`notion-job.ts`, registered in `domains/jobs/runners.ts`): progress "Reading Notion, 12 of 40" in the jobs panel, cancellable between pages, the result sentence as the job's notice. A double click within 15 seconds joins the first job.
- `summarizeNotionSync` writes the sentence the Sync control shows: pages read, new/updated/unchanged, skipped with reasons, partial, links added.

Not covered: linked database views (the API does not expose them), pages shared only by mention, attachments.
