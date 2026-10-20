-- 0214 (inbox two-pane): the inbox's converted/discarded/all views and the
-- four filter-tab counts filter by (workspace_id, processing_state) and sort
-- by created_at; the only prior index is the partial captures_inbox_idx,
-- which covers only the to-clarify states. Without this index every other
-- tab seq-scans the workspace's captures on each cache miss. One index
-- serves the unfiltered list and all four counts; the processing_state
-- leading column serves the filtered views.
CREATE INDEX "captures_workspace_state_created_idx" ON "captures" USING btree ("workspace_id","processing_state","created_at" DESC);
