-- Home's learning streak (src/domains/learning/up-next.ts) reads the days one
-- learner rated flashcards: audit rows with action
-- 'learning.flashcard_reviewed' for (workspace_id, actor_id) over a bounded
-- window. The only usable index was (workspace_id, created_at), so every Home
-- render read every audit row the workspace wrote in that window and filtered
-- actor and action on the heap. Partial on the action, so the shared write
-- log pays for it only on flashcard reviews.
CREATE INDEX "audit_events_flashcard_review_idx" ON "audit_events" USING btree ("workspace_id","actor_id","created_at") WHERE action = 'learning.flashcard_reviewed';
