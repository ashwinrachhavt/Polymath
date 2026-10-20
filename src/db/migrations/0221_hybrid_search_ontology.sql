-- 0221: one retrieval layer and a small ontology vocabulary (ASH-110 section 6).
-- Adds three relation types an idea can have to another (instance_of, part_of,
-- causes), and the two indexes hybrid search needs on the artifact store:
-- full-text over a version's plain text and trigram over titles. No new tables.
ALTER TABLE "artifact_links" DROP CONSTRAINT "artifact_links_link_type_check";--> statement-breakpoint
ALTER TABLE "artifact_links" ADD CONSTRAINT "artifact_links_link_type_check" CHECK (link_type in ('reference', 'related', 'supports', 'contradicts', 'source', 'semantic', 'explains', 'applies', 'extends', 'contrasts', 'dismissed', 'instance_of', 'part_of', 'causes'));--> statement-breakpoint
CREATE INDEX "artifact_versions_plain_text_fts_idx" ON "artifact_versions" USING gin (to_tsvector('english', coalesce("plain_text", '')));--> statement-breakpoint
CREATE INDEX "artifacts_title_trgm_idx" ON "artifacts" USING gin ("title" gin_trgm_ops);
