# Library and documents

What it is: the reading library over canonical documents (D18 / ASH-144): what to continue, what is unread, what is finished, and the engagement behind it. The Document Vault at `/polymath/knowledge` holds documents and zettels. Document detail lives at `/polymath/library/[documentId]`.

## Sub-features

- The library list at `/polymath/library`: reading-state groups (`libraryGroup` over `FINISHED_AT` / `STARTED_AT` in `src/domains/knowledge/reading.ts`) and the reading-history readout.
- Document detail at `/polymath/library/[documentId]`.
- The Document Vault at `/polymath/knowledge` (header "Knowledge", purpose "Write, retrieve, and connect.") and its zettels at `/polymath/knowledge/zettels`.
- Ingestion through connectors, exercised in CI by `tests/e2e/connectors-tier-journey.spec.ts`.

## How to get to it (user POV)

The rail entry "Document Vault" leads to `/polymath/knowledge`. The library route is `/polymath/library`, reached by URL or from the files explorer and polymath app screens, which link it.

## Driving it with agent-browser

1. Open `http://localhost:3000/polymath/library` and verify the list renders, empty or not.
2. With an existing or seeded document, open `http://localhost:3000/polymath/library/<document id>`. Verify the detail renders that document's title.
3. Open the vault at `/polymath/knowledge` and verify the header. If storage is not configured, the page renders the "Knowledge storage is not configured" state instead; that outcome is itself the proof for that precondition.
4. Capture each state to `/home/user/work/evidence/verify-polymath/`.

## Gotchas

- There is no `BLOB_READ_WRITE_TOKEN` in this sandbox, so document uploads fail. Any journey that depends on an upload or on extraction output must say so and stop at the failure state instead of faking it.
- `/polymath/sources` redirects to `/polymath/dossiers`. Sources left the rail in the IA simplification, so old links are not dead; do not "fix" the redirect.
