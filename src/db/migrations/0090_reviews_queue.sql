-- Reviews v2 (canonical proposal queue). The decided views of /reviews filter
-- on (workspace_id, status) and read newest first; the pending queue itself
-- keeps using the existing partial index. Additive only.
CREATE INDEX IF NOT EXISTS "action_proposals_status_idx" ON "action_proposals" USING btree ("workspace_id", "status", "created_at");
