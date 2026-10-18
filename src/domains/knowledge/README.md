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
A process killed while pending still needs durable job/lease recovery (ASH-134);
extractor revisions and append-only attempt history remain unfinished.

The proposal pass (fields, parties, obligations) is a separate retry boundary
on the extraction row (`proposal_status`, `proposer`, `proposal_error`): text
that succeeded is never re-read, but a later extract call reruns a failed or
never-run pass, idempotently. Fields come from `field-rules.ts` (labelled
values only, exact spans, honest confidence) unless a provider emits its own.
Values read inside a party's block carry `party_role`, and only those reach
that party's assertion ledger. In development with no Blob token or provider,
uploads go to `AXIOM_LOCAL_BLOB_DIR` and PDFs are read from their text layer.
