-- 0242: the stone carries the person's own sentence (spec: task completion
-- asks "what did you actually do?" and carries the sentence onto the stone).
-- Null when a stone was earned without a sentence.
ALTER TABLE "reward_ledger"
  ADD COLUMN IF NOT EXISTS "note" text;
