-- 0211 (ASH-174/ASH-184): notes and zettels embed like documents, so the
-- knowledge graph gains semantic edges (nearest cards by cosine distance).
-- The vectors live in the existing `embeddings` table under owner_type
-- 'artifact'; this records the pass's failure state on the artifact, mirroring
-- document_extractions.embed_error.
ALTER TABLE "artifacts" ADD COLUMN "embed_error" text;
