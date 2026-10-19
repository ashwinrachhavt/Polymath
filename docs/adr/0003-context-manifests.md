# 0003: Source-version-pinned context manifests (ASH-118, RT04)

Status: accepted (code, migration 0141).

## Lifecycle

A manifest is built once by `buildContext` and never mutated: items,
selection reasons, staleness marks and the budget outcome are append-only
rows. An intentional refresh builds a NEW manifest; the old one stays as the
record of what an earlier run actually saw. `context_manifests.run_id` and
`profile_revision_id` are `set null` so deleting a run or revision never
erases the context record.

## Refresh semantics

`loadManifest` is the refresh path: it re-reads each included item against
current access state (live revocation). An artifact archived or a memory
retired since construction comes back as a gap with a reason, not as
content. The stored manifest is untouched: it records what WAS used, and
the load result records what is still usable.

## Source precedence and staleness

A pinned artifact version that is no longer the artifact's current version
is marked `superseded` and its selection reason says a newer version exists;
it is never presented as current truth. Evidence is a span (`quote` +
offsets) addressed to a `sources` row, whose `content_hash` pins the fetched
version. Conversation (`message` items), canonical records, evidence
(`source_span`) and reviewed memory (`memory_revision`) are distinct kinds;
an assistant message is never evidence, and retrieved content is data, not
instructions.

## Evidence addressing and validation

`validateClaimEvidence` grades actual support: a claim is supported only by
an accessible source with a well-formed span. Missing evidence is an
explicit gap — never an invented agreement, price, credential or decision —
and a span with impossible offsets is reported malformed rather than counted
as support.

## Memory rules

Only `accepted` memory enters context, at its latest revision. Proposed,
rejected or retired memory requested by id produces a recorded gap, so an
unreviewed model proposal is never silently treated as a preference, and a
newer accepted decision is distinguishable from an older similar source.

## Budget

`estimateTokens` (~4 chars/token) budgets by exclusion: items are ranked
records/evidence, memory, then conversation; whatever does not fit is
excluded with the reason "excluded by context budget" and counted in
`gap_count`. Selection reasons are stored on every item — inspectable
without any hidden chain-of-thought.

## Retention and access

Manifests and items live under their workspace (`onDelete: cascade`) with
tenant-composite keys. Nothing here stores secrets or raw provider payloads.
Access checks run both at construction and at load, so revocation takes
effect for new loads even when an old manifest references the material.
