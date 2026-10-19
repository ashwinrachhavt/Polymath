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

## Zettel proposals

`proposeZettels(auth, { documentId })` reads a document's newest succeeded
extraction and asks an extractor (default: OpenRouter, `ZETTEL_MODEL`, needs
`OPENROUTER_API_KEY`) for candidate notes. Each candidate is a title, one claim
and a quote. The domain re-locates the quote in the extraction text and drops
anything that is not verbatim, so every proposal row carries a real span
(`span_start`/`span_end`). Rows are `zettel_proposals`, deduped by
`zettel:<documentId>:<start>-<end>`. Accept writes a concept, a claim and a
`claim_evidence` row pointing at the span; reject writes only the decision.
Controls live on the Knowledge screen (/alfred/knowledge); there is no graph page.

## Dossiers

A dossier is a name plus a set of documents in this workspace
(`createDossier`, `attachDocuments`). A foreign or unknown document id fails the
whole command. Each attachment pins the document's latest succeeded extraction
hash on `dossier_sources`. `documents.search` takes an optional `dossierId`, and
a run started with a dossier (`POST /api/v1/runs` with `dossierId`, set from the
Ask Alfred form) stays inside it; an empty dossier returns nothing and an
unknown dossier is an error.

Not in this PR: Studio Generate (a run saved as a draft artifact linked to the
pinned versions). The brief says not to start Studio until PR 5 and PR 8 merge.

## Studio Generate

`startStudioGenerate` starts a run whose objective names the dossier and whose
subjects bind it to that dossier. `saveGeneratedDraft` turns the run's last
assistant message into a `draft` artifact (version 1, reason `generated`), linked
to each pinned document (`pinned:<content hash>`) and to the run, once per run.
The owner then calls `saveDraft` (status `reviewed`) or `discardDraft`
(`archived`); a decided draft is never rewritten. No code path sets `published`.
API: POST /api/v1/dossiers/:id/generate, POST /api/v1/drafts, POST
/api/v1/drafts/:artifactId/save|discard.

## Wiki (second brain)

The maintained layer over documents (`wiki.ts`, registry table `wiki_pages`).
Documents stay immutable raw sources; the wiki holds one master index, one hub
per topic, one article per ingested document, and an append-only log. Every
page is an artifact, so each refresh is a new append-only version — nothing is
edited in place. Hubs and the index are derived from the registry and
regenerated on every ingest, so they cannot drift; only article bodies come
from the summarizer (`src/integrations/wiki/summarizer.ts`, default OpenRouter,
`WIKI_MODEL`, needs `OPENROUTER_API_KEY`). `ingestDocument(auth, {documentId})`
is the one write path: re-ingesting after a re-extraction appends a new
article version; re-ingesting unchanged text writes nothing. `lintWiki` is
read-only: it reports archived-but-registered pages, articles whose source was
archived, empty topics and a missing skeleton; it never auto-fixes. Alfred
runs the loop through the `wiki.read` / `wiki.ingest` / `wiki.lint`
capabilities; the surface is /alfred/wiki.

## Library backend (Box-feel file manager)

The read model behind the document library UI: `library.ts` for reads,
`folders.ts` for the tree, `exports.ts` for export manifests (ASH-130).

- Folders (`folders.ts`): a name plus a parent; the root is "no folder".
  Names are unique per folder, case-insensitively, among live folders. Every
  mutation is version-checked and audited. Moving a document is a
  `document_folder_events` row in the same transaction, never a silent edit;
  archiving a folder is refused while it holds live documents or subfolders.
- Pages (`listDocuments`): keyset pagination (opaque cursor: sort key plus
  id), sorts recent/added/title/size, filters folder ("root" for unfiled),
  doc type, state, party, date range, and q (full-text over extraction text
  plus title/original-filename trigram match, so a failed extraction is
  still findable by name). The state filter uses the same vocabulary as
  `status.ts` - one SQL expression mirrors it, and the integration suite
  asserts parity combination by combination. `listFolders` returns the flat
  live folder list with direct document counts; the tree is composed
  client-side.
- Detail: `getDocumentVersions` (every extraction version, newest first),
  `getDocumentActivity` (added, read attempts, classification, renames,
  moves, field and obligation decisions, newest first, bounded),
  `getDocumentParties` (roles with resolved CRM names).
- Tags (`tags.ts`): free tags, normalized lowercase, one row per (document,
  tag); batch add/remove with idempotent re-tags. `listDocuments` takes a tag
  filter and returns each row's tags; `listTags` is the filter rail.
- Export manifests (`exports.ts`): a named selection for a party or purpose.
  Each item pins the latest succeeded extraction at add time (id plus
  content hash, so the pin survives extraction pruning); a document with no
  succeeded extraction is pinned as an honest null. The read side reports
  drift (`isCurrent: false`) after a re-extraction rather than silently
  upgrading. Full packets remain deferred per ASH-130.
