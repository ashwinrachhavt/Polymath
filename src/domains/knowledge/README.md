# knowledge

Owns: artifacts, versions, drafts, files, documents, extractions, sources, claims, evidence, embeddings, dossiers, concepts, canvases

Tables are in `schema.ts` and nowhere else — a domain owns its tables, and UI
code reads them through this domain's queries rather than joining across
(agents/engineering.md). Enum values are the contract: add a value, never
repurpose one.

Document extraction reads authorized private Blob objects through the server-side
SDK, with the upload size bound enforced on both metadata and streamed bytes.
The content-key row is claimed as pending before provider I/O. Only succeeded
rows deduplicate as success; failed rows may be claimed for retry, while pending
or skipped rows never report success. Successful evidence is not overwritten.
An extraction is claimed with a lease (`claimed_at`, `claimed_by`,
`EXTRACTION_LEASE_SECONDS`). A pending row is reclaimable only after its lease
expires; a process killed mid-extract leaves the row at "Reading" until then and
retryable after, never "Filed". Only the holder of the current `claimed_by` token
may write the result, so a stale process cannot overwrite a newer attempt. Every
claim writes a `document_extraction_attempts` row; a retry never deletes the
earlier error. Extractor revisions remain unfinished.

URL capture (`capture-url.ts`) is the same intake as an upload, not a second
one: the document is inserted first with `source_url` (one per workspace, by a
partial unique index), the bytes are fetched server-side by `src/lib/safe-fetch.ts`
(http/https only; loopback, private, link-local and metadata addresses refused at
connect time and on every redirect hop; 4 MB and 10 s limits), then stored by
`intake.ts`, the path `POST /api/v1/files` also uses, and run through the existing
extract and proposal pass. A fetch that fails leaves the document without a file
or type and records the reason on a failed extraction row (content hash
`unfetched:<sha256(url)>`), so it reads "Could not read", never Filed. Pasting the
URL again retries on the same document. PDF, PNG, and JPEG are stored as
fetched; an HTML page is reduced to its reading text (`html-to-text.ts`) and
stored as markdown, which `plain-text.ts` extracts in place of a parsing
provider. Other types are refused.

The embedding pass (`embedding.ts`, `chunking.ts`) runs only on a succeeded
extraction and reads its stored text, never the file. Chunks of about 1,200
characters (150 overlap, at most 400) become `embeddings` rows owned by the
extraction row (`owner_type = document_extraction`), each with its offsets and
page. Re-running replaces that extraction's chunks in one transaction, behind an
advisory lock, so chunks are never doubled. A failure is written to
`embed_error` and never changes the extraction's status; a later call retries
from the stored text. `searchChunks` in `search.ts` returns the nearest chunks by
cosine distance, inside one workspace, from each document's newest succeeded
extraction, and only from the model that embedded the query. The provider is
OpenAI `text-embedding-3-small` (1536 wide, matching the column) when
`OPENAI_API_KEY` is set; with no key the pass records that and extraction is
unaffected. pgvector only; there is no Qdrant.

The proposal pass (fields, parties, obligations) is a separate retry boundary
on the extraction row (`proposal_status`, `proposer`, `proposal_error`): text
that succeeded is never re-read, but a later extract call reruns a failed or
never-run pass, idempotently. Fields come from `field-rules.ts` (labelled
values only, exact spans, honest confidence) unless a provider emits its own.
Values read inside a party's block carry `party_role`, and only those reach
that party's assertion ledger. In development with no Blob token or provider,
uploads go to `AXIOM_LOCAL_BLOB_DIR` and PDFs are read from their text layer.
