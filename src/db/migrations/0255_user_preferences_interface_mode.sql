-- ASH-312: the interface mode is an account preference, one value per
-- (workspace, user) on the existing preferences row. Hand-written: the
-- snapshot chain is broken (see 0251's header / ASH-316); check-migrations
-- guards the journal entry. Old code inserts and reads the row without the
-- column: the default keeps those writes valid, and new code reading an old
-- row resolves 'auto' - the same value a brand-new account gets.
DO $$ BEGIN
  CREATE TYPE "public"."interface_mode" AS ENUM('library', 'action', 'auto');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "interface_mode" "public"."interface_mode" NOT NULL DEFAULT 'auto';
