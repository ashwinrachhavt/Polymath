-- 0234: drop the Learning/teaching feature (IA simplification, owner decision).
--
-- Learning had no future in the product and its data was accepted as
-- test-scale loss, so every learning object goes: the four tables (decks,
-- items, attempts, plans), the quiz columns 0215 added to learning_items, and
-- the feature's enums. `plan_status` is dropped with them because
-- learning_plans was its only user. `ledger_reason` keeps its
-- `learning_reviewed` value: dropping an enum value has no single-statement
-- form, no row ever used it, and an unused variant is harmless.
DROP TABLE IF EXISTS "learning_attempts" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "learning_items" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "learning_decks" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "learning_plans" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "learning_item_kind";--> statement-breakpoint
DROP TYPE IF EXISTS "learning_item_status";--> statement-breakpoint
DROP TYPE IF EXISTS "learning_result";--> statement-breakpoint
DROP TYPE IF EXISTS "plan_status";
