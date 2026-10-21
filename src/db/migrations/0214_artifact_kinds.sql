-- 0214 (NotebookLM parity): generated study artifacts.
--
-- A deck and an infographic are artifacts like a report: structured versions in
-- the same container, saved through Studio's draft -> reviewed gate. They are
-- new kinds, not new tables, so the link graph, versioning and provenance all
-- apply without a second store.
ALTER TYPE "public"."artifact_kind" ADD VALUE 'deck';--> statement-breakpoint
ALTER TYPE "public"."artifact_kind" ADD VALUE 'infographic';
