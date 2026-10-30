-- 0263: cards, areas and sittings are retired (spec 2026-10-30).
--
-- Drop order follows the foreign keys: card reviews cite cards, sitting cards
-- cite sittings. No CASCADE on purpose — a surviving foreign key means some
-- code still references one of these tables, and that should fail the migration
-- loudly rather than silently drop a column from a table that survives.

DROP TABLE IF EXISTS card_reviews;
DROP TABLE IF EXISTS cards;
DROP TABLE IF EXISTS zettel_sitting_cards;
DROP TABLE IF EXISTS zettel_sittings;
DROP TABLE IF EXISTS areas;
