-- 0268: drop the retired tables that 0266 resurrected.
--
-- 0266 reports its drop sections (0235_drop_learning, 0257_drop_daily_outcomes,
-- 0263_drop_cards_areas_sittings, 0264) by header only: the DROP statements
-- were left out, but the matching CREATE TABLE IF NOT EXISTS bodies from the
-- earlier chain were copied in. On an incremental database that is harmless,
-- because those tables already exist and the create is a no-op. On a database
-- that reaches 0266 with the tables already dropped — drizzle replays 0263's
-- DROP immediately before it — the create runs for real and brings them back
-- empty (observed 2026-11-01 on the local dev database).
--
-- 0266 is a published checkpoint, so it cannot be edited; this forward
-- migration removes what it should never have recreated.
--
-- Every table here is provably dead in the current schema:
--   cards, card_reviews, areas, zettel_sittings, zettel_sitting_cards
--       retired by 0263
--   learning_attempts, learning_items, learning_decks, learning_plans
--       retired by 0235
--   dossiers, dossier_sources, dossier_questions
--       renamed to notebooks by 0248; 0266's guarded RENAME raised
--       duplicate_table and was swallowed, so the empty originals survived
--       alongside the real notebooks tables
--
-- No CASCADE, for the same reason 0263 gives: a surviving foreign key means
-- live code still references one of these, and that should fail this migration
-- loudly rather than silently cascade. Drop order follows the foreign keys
-- (children first). IF EXISTS keeps this a no-op on databases that never
-- resurrected them.
DROP TABLE IF EXISTS "card_reviews";
DROP TABLE IF EXISTS "cards";
DROP TABLE IF EXISTS "zettel_sitting_cards";
DROP TABLE IF EXISTS "zettel_sittings";
DROP TABLE IF EXISTS "areas";
DROP TABLE IF EXISTS "learning_attempts";
DROP TABLE IF EXISTS "learning_items";
DROP TABLE IF EXISTS "learning_decks";
DROP TABLE IF EXISTS "learning_plans";
DROP TABLE IF EXISTS "dossier_questions";
DROP TABLE IF EXISTS "dossier_sources";
DROP TABLE IF EXISTS "dossiers";
