-- 0236 (artifacts list + capture placeholder): two hot paths filter on
-- columns no index serves.
--
-- wiki_pages.artifact_id is the artifacts list's wiki-registry join and the
-- wiki reader's lookup; the table's only unique key is (workspace_id,
-- document_id, role), so every list render joined by seq-scanning
-- wiki_pages.
--
-- sources (workspace_id, url) WHERE content_hash IS NULL serves the queued
-- capture placeholder update (recordSource's in-place update of a
-- queued-capture placeholder, which filters exactly this partial shape) and
-- the notebook's address binding; the existing unique indexes start with the
-- full content hash, which a placeholder row never has.
CREATE INDEX "wiki_pages_artifact_id_idx" ON "wiki_pages" ("artifact_id");
CREATE INDEX "sources_workspace_url_pending_idx" ON "sources" ("workspace_id","url") WHERE "content_hash" IS NULL;
