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

The proposal pass (fields, parties, obligations) is a separate retry boundary
on the extraction row (`proposal_status`, `proposer`, `proposal_error`): text
that succeeded is never re-read, but a later extract call reruns a failed or
never-run pass, idempotently. Fields come from `field-rules.ts` (labelled
values only, exact spans, honest confidence) unless a provider emits its own.
Values read inside a party's block carry `party_role`, and only those reach
that party's assertion ledger. In development with no Blob token or provider,
uploads go to `AXIOM_LOCAL_BLOB_DIR` and PDFs are read from their text layer.
