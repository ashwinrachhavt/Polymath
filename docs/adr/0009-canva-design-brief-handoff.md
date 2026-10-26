# 0009 - Canva design-brief handoff: design import through the Composio proxy's binary_body

Status: proposed (design only; no capability, tier, executor, or migration changes ship with it)

## Context

ASH-286 asks for a skill that hands a generated design brief to Canva only after human
approval. The brief-generation slice (artifact action, toolbar control, idempotent
one-brief-per-source-revision, e2e journeys) is built and verified. The handoff itself
was initially assessed as unsupported: the repo's Composio write seam JSON-stringifies
every payload, and Canva's import endpoint takes an `application/octet-stream` body.
That assessment confused the repo's wrapper with the platform's contract.

## Evidence (all read-only, sources inline)

- Canva create design import job: `POST https://api.canva.com/rest/v1/imports`, body
  `application/octet-stream`, metadata in an `Import-Metadata` header, scope
  `design:content:write`, asynchronous job, 20 requests/minute/user.
  Source: https://www.canva.dev/docs/connect/api-reference/design-imports/create-design-import-job/
- Import accepts PDF, DOCX, PPTX (and others); Markdown is not a supported import type.
  Source: https://www.canva.dev/docs/connect/api-reference/design-imports/
- Canva exposes "Get design import job" for status reconciliation, and a URL import
  variant that fetches the file from a URL instead of receiving bytes.
  Source: same index page.
- The Composio proxy endpoint the repo already uses (`POST /api/v3/tools/execute/proxy`,
  frozen v3, and identically in current v3.1) documents a first-class `binary_body`
  field: `{base64: "...", content_type?: "..."}` or `{url: "...", content_type?: "..."}`,
  plus a `parameters` array that carries arbitrary headers such as `Import-Metadata`.
  Source: https://docs.composio.dev/reference/v3/api-reference/tools/postToolsExecuteProxy
- The repo seam (`src/domains/integrations/composio.ts` `postThroughProxy`) hard-codes
  `Content-Type: application/json` and does not pass `binary_body`. That is the whole
  gap: a wrapper omission, not a platform limitation.
- Both ACTIVE connected Canva accounts (`ca_DHzJaa68_LOb`, `ca_7-zrACv8-mvU`) already
  grant `design:content:write` and `design:meta:read` (live scope read, 2026-10-25).
  No new scopes, accounts, or grants are required for import.
  Scope-limit note: two EXPIRED accounts could not be queried; per-account visibility only.
- The autofill alternative stays blocked on a user-owned prerequisite: zero brand
  templates are visible on either ACTIVE account (`GET /v1/brand-templates` ->
  `{"items":[]}`, HTTP 200, 2026-10-26 00:54 UTC). Both accounts do carry
  `brandtemplate:content:read`, so autofill unblocks the day a template exists.

## Decision

The grounded executable route is a design import job through the proxy's documented
`binary_body`, reconciled asynchronously. Autofill remains the better long-term surface
(branded output) but is user-blocked; import needs nothing the accounts do not already have.

### Seam (small, single module)

Extend the write path in `src/domains/integrations/composio.ts` with an optional
`binaryBody?: { base64: string; contentType: string }` on the write call, forwarded as
`binary_body` on the proxy envelope, with `Import-Metadata` (JSON `{title}`) passed as a
`parameters` header entry. The envelope stays JSON; Composio sets the provider-side
content type from `content_type`. No new client, no second transport.

### Brief -> file

Canva cannot import Markdown. Render the brief to a minimal `.docx` (OOXML is a zip of
XML; `src/lib/zip.ts` already has `buildZip`) so no rendering dependency is added. The
brief's `format` field (`doc` | `whiteboard` | `presentation`) selects the template shape
later; v1 imports the doc form only.

### Approval and execution (existing contracts, no new surface here)

A `canva.design.import` capability goes through the existing action-proposal flow and the
revision-approved actions executor - never a direct skill call - mirroring
`src/domains/integrations/gmail/send.ts`. The proposal's expectedEffect copy states
exactly what happens: which brief, which Canva account, what file is uploaded. Capability,
tier, tool-manifest, and migration changes stay held until this design is accepted.

### Async reconciliation (existing pattern)

Job creation returns an import job id; the attempt row stays open. A reconciliation sweep
mirroring `src/domains/actions/reconciliation.ts` asks the provider a read question -
`GET /rest/v1/imports/{jobId}` through the existing `executeComposioRead` - and settles on
the terminal answer: `success` records the created design's id and url, `failed` settles
failed with Canva's error. The sweep never re-creates a job on an unknown outcome; the
same lag discipline as Gmail's reconciliation applies inside Canva's indexing window.
The 20 rpm/user limit bounds sweep cadence.

### Alternative: URL import

Canva's URL import job avoids bytes entirely but needs the rendered file at a fetchable
URL (signed URL from file storage). More moving parts than `binary_body`; kept as fallback.

## Consequences

- The handoff becomes implementable with one seam extension, one renderer, one capability
  wiring, and one sweep - no new external accounts, scopes, or dependencies.
- A wrong binary upload is recoverable: an imported design is an ordinary Canva design
  the owner can delete; nothing on the Polymath side mutates existing Canva content.
- What is still NOT settled: whether Canva's import of a minimal OOXML doc preserves the
  brief's structure acceptably (needs one real, owner-approved import in dev to judge),
  and per-account design landing location (Canva chooses; the design url is read back
  from the job result).
